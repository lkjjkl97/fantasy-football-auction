import express from "express";
import { createServer } from "node:http";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
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
const hashPin = (pin: string) => createHash("sha256").update(pin).digest("hex");
const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const redisKey = "fantasy-football-auction:league";

async function redisCommand(...args: Array<string | number>) {
  if (!redisUrl || !redisToken) return undefined;
  const response = await fetch(redisUrl, { method: "POST", headers: { authorization: `Bearer ${redisToken}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  if (!response.ok) throw new Error(`Redis request failed (${response.status}).`);
  return (await response.json() as { result?: unknown }).result;
}

function normalizeLeague(saved: League) {
  saved.nominationIndex ??= 0;
  saved.managers.forEach((manager) => { manager.rosterSlotsUsed ??= manager.roster.length; });
  if (saved.current && !(saved.current as { deadline?: string }).deadline) saved.current = null;
  return saved;
}

async function refreshLeague() {
  const stored = await redisCommand("GET", redisKey);
  if (typeof stored === "string") league = normalizeLeague(JSON.parse(stored) as League);
}

async function persistLeague() {
  if (redisUrl && redisToken) {
    if (league) await redisCommand("SET", redisKey, JSON.stringify(league));
    else await redisCommand("DEL", redisKey);
    return;
  }
  saveLeague();
}

const sessionSecret = () => process.env.SESSION_SECRET || league?.commissionerPin || "local-development-secret";
const signManager = (managerId: string) => `${managerId}.${createHmac("sha256", sessionSecret()).update(managerId).digest("hex")}`;
function sessionManager(token: unknown) {
  const [managerId, signature] = String(token || "").split(".");
  if (!managerId || !signature) return undefined;
  const expected = createHmac("sha256", sessionSecret()).update(managerId).digest("hex");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return undefined;
  return findManager(managerId);
}

function loadLeague(): League | null {
  try {
    return normalizeLeague(JSON.parse(readFileSync(stateFile, "utf8")) as League);
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
app.use("/api", async (_req, res, next) => {
  try { await refreshLeague(); next(); }
  catch (error) { console.error("Could not load shared league state:", error); res.status(503).json({ error: "League storage is temporarily unavailable." }); }
});

const publicState = (viewerId?: string) => league && ({
  managers: league.managers.map((m) => ({ id: m.id, name: m.name, budget: m.budget, roster: m.roster, rosterSlotsUsed: m.rosterSlotsUsed, rosterSpotsLeft: 20 - m.rosterSlotsUsed, maxBid: maxBid(m) })),
  nominationOrder: league.nominationOrder,
  tieOrder: league.tieOrder,
  nominationIndex: league.nominationIndex,
  current: league.current && { player: league.current.player, nominatorId: league.current.nominatorId, openingBid: league.current.openingBid,
    openedAt: league.current.openedAt, deadline: league.current.deadline, paused: league.current.paused,
    responses: league.managers.map(m => ({managerId:m.id,submitted:league!.current!.bids.some(b=>b.managerId===m.id)})),
    myBid: league.current.bids.find(b => b.managerId === viewerId)?.amount,
    myPassed: league.current.bids.find(b => b.managerId === viewerId)?.passed },
  results: league.results,
  ended: league.ended
});
const broadcast = () => io.sockets.sockets.forEach((s) => s.emit("state", publicState(s.data.managerId)));
let revealTimer: NodeJS.Timeout | null = null;
function scheduleReveal() {
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = null;
  const deadline = league?.current?.deadline;
  if (!deadline) return;
  revealTimer = setTimeout(async () => {
    if (!league?.current || league.current.deadline !== deadline) return;
    try { resolveAuction(league); await persistLeague(); broadcast(); }
    catch (error) { console.error("Automatic reveal failed:", error); }
  }, Math.max(0, Date.parse(deadline) - Date.now()));
}
const findManager = (managerId: string) => league?.managers.find((m) => m.id === managerId);

app.get("/api/state", async (req, res) => {
  const manager = sessionManager(req.query.token);
  if (league?.current && !league.current.paused && canReveal(league)) {
    try { resolveAuction(league); await persistLeague(); broadcast(); }
    catch (error) { console.error("Deadline reveal failed:", error); }
  }
  res.json(publicState(manager?.id));
});
app.post("/api/setup", async (req, res) => {
  if (league) return res.status(409).json({ error: "League is already set up." });
  const parsed = z.object({ commissionerPin: z.string().min(4), managers: z.array(z.object({ name: z.string().min(1).max(30), pin: z.string().min(4).max(30) })).min(2).max(20) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Use 2–20 team names, unique team PINs, and a commissioner PIN of at least 4 characters." });
  if (new Set(parsed.data.managers.map((m) => m.pin)).size !== parsed.data.managers.length) return res.status(400).json({ error: "Every team needs a unique PIN." });
  const managers = parsed.data.managers.map(({ name, pin }) => ({ id: randomUUID(), name, pinHash: hashPin(pin), budget: 300, roster: [] as string[], rosterSlotsUsed: 0 }));
  const nominationOrder = managers.map((m) => m.id);
  league = { commissionerPin: parsed.data.commissionerPin, managers, nominationOrder, tieOrder: [...nominationOrder].reverse(), nominationIndex: 0, current: null, results: [] };
  await persistLeague();
  broadcast(); res.json({ ok: true, managers: managers.map(({id,name}) => ({id,name})) });
});
app.post("/api/login", (req, res) => {
  const m = findManager(String(req.body.managerId));
  if (!m || m.pinHash !== hashPin(String(req.body.pin || ""))) return res.status(401).json({ error: "Team or PIN is incorrect." });
  const token = signManager(m.id);
  res.json({ managerId: m.id, token, state: publicState(m.id) });
});
app.post("/api/commissioner-check", (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Invalid commissioner PIN" });
  res.json({ ok: true });
});
app.post("/api/nominate", async (req, res) => {
  if (!league) return res.status(404).json({ error: "League not found." });
  if (league.ended) return res.status(400).json({ error: "This league has ended." });
  if (league.current) return res.status(409).json({ error: "Resolve the current auction first." });
  const manager = sessionManager(req.body.token);
  const player = String(req.body.player || "").trim();
  const openingBid = Number(req.body.openingBid);
  if (!manager || manager.id !== league.nominationOrder[league.nominationIndex]) return res.status(403).json({ error: "It is not your turn to nominate." });
  if (!player || !Number.isInteger(openingBid) || openingBid < 1 || openingBid > maxBid(manager)) return res.status(400).json({ error: `Enter a player and an opening bid from $1–$${maxBid(manager)}.` });
  if (manager.rosterSlotsUsed >= 20) return res.status(400).json({ error: "That manager's roster is full." });
  const openedAt = new Date();
  league.current = { player, nominatorId: manager.id, openingBid, openedAt: openedAt.toISOString(),
    deadline: new Date(openedAt.getTime() + 30000).toISOString(),
    bids: [{ managerId: manager.id, amount: openingBid, submittedAt: openedAt.toISOString() }] };
  await persistLeague();
  scheduleReveal();
  broadcast(); res.json({ ok: true });
});
app.post("/api/bid", async (req, res) => {
  const m = sessionManager(req.body.token);
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
  await persistLeague();
  broadcast(); res.json({ ok: true });
});
app.post("/api/resolve", async (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Commissioner PIN is incorrect." });
  if (!canReveal(league)) return res.status(400).json({ error: "Wait for every team to respond or for the timer to expire." });
  try { const result = resolveAuction(league); await persistLeague(); broadcast(); res.json(result); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
app.post("/api/reset", async (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Commissioner PIN is incorrect." });
  league.managers.forEach((manager) => { manager.budget = 300; manager.roster = []; manager.rosterSlotsUsed = 0; });
  league.current = null;
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = null;
  league.results = [];
  league.ended = false;
  league.nominationIndex = 0;
  league.tieOrder = [...league.nominationOrder].reverse();
  await persistLeague(); broadcast(); res.json({ ok: true });
});
app.post("/api/end", async (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Commissioner PIN is incorrect." });
  league = null;
  try { unlinkSync(stateFile); } catch {}
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = null;
  await persistLeague(); broadcast(); res.json({ ok: true });
});
app.post("/api/pause", async (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Commissioner PIN is incorrect." });
  if (!league.current) return res.status(400).json({ error: "No active bidding session." });
  league.current.paused = !league.current.paused;
  if (league.current.paused && revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
  else if (!league.current.paused) scheduleReveal();
  await persistLeague(); broadcast(); res.json({ paused: league.current.paused });
});
app.post("/api/manager-adjust", async (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Commissioner PIN is incorrect." });
  const manager = league.managers.find((m) => m.id === String(req.body.managerId));
  const budget = Number(req.body.budget);
  const rosterSpotsLeft = Number(req.body.rosterSpotsLeft);
  if (!manager || !Number.isInteger(budget) || budget < 0 || budget > 300 || !Number.isInteger(rosterSpotsLeft) || rosterSpotsLeft < 0 || rosterSpotsLeft > 20) return res.status(400).json({ error: "Enter $0–$300 and 0–20 roster spots left." });
  if (budget < rosterSpotsLeft) return res.status(400).json({ error: `A team with ${rosterSpotsLeft} spots left must retain at least $${rosterSpotsLeft}.` });
  manager.budget = budget;
  manager.rosterSlotsUsed = 20 - rosterSpotsLeft;
  if (manager.roster.length > manager.rosterSlotsUsed) manager.roster = manager.roster.slice(0, manager.rosterSlotsUsed);
  await persistLeague(); broadcast(); res.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.on("identify", ({ token }) => { const manager = sessionManager(token); if (manager) socket.data.managerId = manager.id; socket.emit("state", publicState(socket.data.managerId)); });
  socket.emit("state", publicState());
});
scheduleReveal();
if (!process.env.VERCEL) http.listen(port, "0.0.0.0", () => console.log(`Sealed Bid Draft running at http://localhost:${port}`));
export default app;
