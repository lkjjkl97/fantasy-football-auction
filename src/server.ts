import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Server } from "socket.io";
import { z } from "zod";
import { canReveal, maxBid, resolveAuction, type League } from "./auction.js";

const app = express();
const http = createServer(app);
const io = new Server(http);
const port = Number(process.env.PORT || 3000);
const stateFile = process.env.STATE_FILE || "data/league.json";
let league: League | null = loadLeague();

function loadLeague(): League | null {
  try {
    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as League;
    saved.nominationIndex ??= 0;
    saved.managers.forEach((manager) => { manager.rosterSlotsUsed ??= manager.roster.length; });
    if (saved.current && !(saved.current as { deadline?: string }).deadline) saved.current = null;
    return saved;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Could not load league state:", error);
    return null;
  }
}

function saveLeague() {
  if (!league) return;
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.tmp`;
  writeFileSync(temporary, JSON.stringify(league, null, 2));
  renameSync(temporary, stateFile);
}

app.use(express.json());
app.use(express.static("public"));

const publicState = (viewerId?: string) => league && ({
  managers: league.managers.map((m) => ({ ...m, rosterSpotsLeft: 20 - m.rosterSlotsUsed, maxBid: maxBid(m) })),
  nominationOrder: league.nominationOrder,
  tieOrder: league.tieOrder,
  nominationIndex: league.nominationIndex,
  current: league.current && { player: league.current.player, nominatorId: league.current.nominatorId, openingBid: league.current.openingBid,
    openedAt: league.current.openedAt, deadline: league.current.deadline, paused: league.current.paused,
    responses: league.managers.map(m => ({managerId:m.id,submitted:league!.current!.bids.some(b=>b.managerId===m.id)})),
    myBid: league.current.bids.find(b => b.managerId === viewerId)?.amount,
    myPassed: league.current.bids.find(b => b.managerId === viewerId)?.passed },
  results: league.results
});
const broadcast = () => io.sockets.sockets.forEach((s) => s.emit("state", publicState(s.data.managerId)));
let revealTimer: NodeJS.Timeout | null = null;
function scheduleReveal() {
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = null;
  const deadline = league?.current?.deadline;
  if (!deadline) return;
  revealTimer = setTimeout(() => {
    if (!league?.current || league.current.deadline !== deadline) return;
    try { resolveAuction(league); saveLeague(); broadcast(); }
    catch (error) { console.error("Automatic reveal failed:", error); }
  }, Math.max(0, Date.parse(deadline) - Date.now()));
}
const findManager = (managerId: string) => league?.managers.find((m) => m.id === managerId);

app.get("/api/state", (req, res) => res.json(publicState(String(req.query.viewer || ""))));
app.post("/api/setup", (req, res) => {
  if (league) return res.status(409).json({ error: "League is already set up." });
  const parsed = z.object({ commissionerPin: z.string().min(4), managers: z.array(z.object({ name: z.string().min(1).max(30) })).min(2).max(20) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Use 2–20 team names and a commissioner PIN of at least 4 characters." });
  const managers = parsed.data.managers.map((m) => ({ id: randomUUID(), ...m, budget: 300, roster: [] as string[], rosterSlotsUsed: 0 }));
  const nominationOrder = managers.map((m) => m.id);
  league = { commissionerPin: parsed.data.commissionerPin, managers, nominationOrder, tieOrder: [...nominationOrder].reverse(), nominationIndex: 0, current: null, results: [] };
  saveLeague();
  broadcast(); res.json({ ok: true, managers: managers.map(({id,name}) => ({id,name})) });
});
app.post("/api/login", (req, res) => {
  const m = findManager(String(req.body.managerId));
  if (!m) return res.status(401).json({ error: "Choose a team." });
  res.json({ managerId: m.id, state: publicState(m.id) });
});
app.post("/api/commissioner-check", (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Invalid commissioner PIN" });
  res.json({ ok: true });
});
app.post("/api/nominate", (req, res) => {
  if (!league) return res.status(404).json({ error: "League not found." });
  if (league.current) return res.status(409).json({ error: "Resolve the current auction first." });
  const manager = findManager(String(req.body.managerId));
  const player = String(req.body.player || "").trim();
  const openingBid = Number(req.body.openingBid);
  if (!manager || manager.id !== league.nominationOrder[league.nominationIndex]) return res.status(403).json({ error: "It is not your turn to nominate." });
  if (!player || !Number.isInteger(openingBid) || openingBid < 1 || openingBid > maxBid(manager)) return res.status(400).json({ error: `Enter a player and an opening bid from $1–$${maxBid(manager)}.` });
  if (manager.rosterSlotsUsed >= 20) return res.status(400).json({ error: "That manager's roster is full." });
  const openedAt = new Date();
  league.current = { player, nominatorId: manager.id, openingBid, openedAt: openedAt.toISOString(),
    deadline: new Date(openedAt.getTime() + 20000).toISOString(),
    bids: [{ managerId: manager.id, amount: openingBid, submittedAt: openedAt.toISOString() }] };
  saveLeague();
  scheduleReveal();
  broadcast(); res.json({ ok: true });
});
app.post("/api/bid", (req, res) => {
  const m = findManager(String(req.body.managerId));
  if (!league || !m || !league.current) return res.status(401).json({ error: "Choose a team and wait for an active auction." });
  if (league.current.paused) return res.status(400).json({ error: "Bidding is paused by the commissioner." });
  if (Date.now() > Date.parse(league.current.deadline)) return res.status(400).json({ error: "Bidding has closed." });
  const passed = !!req.body.passed;
  if (passed && m.id === league.current.nominatorId) return res.status(400).json({ error: "The nominator's opening bid cannot be withdrawn." });
  const amount = Number(req.body.amount);
  const minimumBid = m.id === league.current.nominatorId ? league.current.openingBid : league.current.openingBid + 1;
  if (!passed && (!Number.isInteger(amount) || amount < minimumBid || amount > maxBid(m))) return res.status(400).json({ error: `Your bid must be $${minimumBid}–$${maxBid(m)}.` });
  const existing = league.current.bids.find(b => b.managerId === m.id && !b.passed);
  if (m.id === league.current.nominatorId && existing && !passed && amount <= existing.amount) return res.status(400).json({ error: `As nominator, your new bid must be higher than $${existing.amount}.` });
  league.current.bids = league.current.bids.filter(b => b.managerId !== m.id);
  league.current.bids.push({ managerId: m.id, amount: passed ? 0 : amount, passed, submittedAt: new Date().toISOString() });
  saveLeague();
  broadcast(); res.json({ ok: true });
});
app.post("/api/resolve", (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Commissioner PIN is incorrect." });
  if (!canReveal(league)) return res.status(400).json({ error: "Wait for every team to respond or for the timer to expire." });
  try { const result = resolveAuction(league); saveLeague(); broadcast(); res.json(result); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post("/api/reset", (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Commissioner PIN is incorrect." });
  league.managers.forEach((manager) => { manager.budget = 300; manager.roster = []; manager.rosterSlotsUsed = 0; });
  league.current = null;
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = null;
  league.results = [];
  league.nominationIndex = 0;
  league.tieOrder = [...league.nominationOrder].reverse();
  saveLeague(); broadcast(); res.json({ ok: true });
});
app.post("/api/pause", (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Commissioner PIN is incorrect." });
  if (!league.current) return res.status(400).json({ error: "No active bidding session." });
  league.current.paused = !league.current.paused;
  if (league.current.paused && revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
  else if (!league.current.paused) scheduleReveal();
  saveLeague(); broadcast(); res.json({ paused: league.current.paused });
});
app.post("/api/manager-adjust", (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Commissioner PIN is incorrect." });
  const manager = league.managers.find((m) => m.id === String(req.body.managerId));
  const budget = Number(req.body.budget);
  const rosterSpotsLeft = Number(req.body.rosterSpotsLeft);
  if (!manager || !Number.isInteger(budget) || budget < 0 || budget > 300 || !Number.isInteger(rosterSpotsLeft) || rosterSpotsLeft < 0 || rosterSpotsLeft > 20) return res.status(400).json({ error: "Enter $0–$300 and 0–20 roster spots left." });
  if (budget < rosterSpotsLeft) return res.status(400).json({ error: `A team with ${rosterSpotsLeft} spots left must retain at least $${rosterSpotsLeft}.` });
  manager.budget = budget;
  manager.rosterSlotsUsed = 20 - rosterSpotsLeft;
  if (manager.roster.length > manager.rosterSlotsUsed) manager.roster = manager.roster.slice(0, manager.rosterSlotsUsed);
  saveLeague(); broadcast(); res.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.on("identify", ({ managerId }) => { if (findManager(managerId)) socket.data.managerId = managerId; socket.emit("state", publicState(socket.data.managerId)); });
  socket.emit("state", publicState());
});
scheduleReveal();
http.listen(port, "0.0.0.0", () => console.log(`Sealed Bid Draft running at http://localhost:${port}`));
