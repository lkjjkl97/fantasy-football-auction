import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Server } from "socket.io";
import { z } from "zod";
import { maxBid, resolveAuction, type League } from "./auction.js";

const app = express();
const http = createServer(app);
const io = new Server(http);
const port = Number(process.env.PORT || 3000);
const stateFile = process.env.STATE_FILE || "data/league.json";
let league: League | null = loadLeague();

function loadLeague(): League | null {
  try { return JSON.parse(readFileSync(stateFile, "utf8")) as League; }
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
  managers: league.managers.map(({ pin, ...m }) => ({ ...m, maxBid: maxBid({ pin, ...m }) })),
  nominationOrder: league.nominationOrder,
  tieOrder: league.tieOrder,
  current: league.current && { player: league.current.player, nominatorId: league.current.nominatorId, openedAt: league.current.openedAt,
    bidCount: league.current.bids.length, hasBid: league.current.bids.some(b => b.managerId === viewerId),
    myBid: league.current.bids.find(b => b.managerId === viewerId)?.amount },
  results: league.results
});
const broadcast = () => io.sockets.sockets.forEach((s) => s.emit("state", publicState(s.data.managerId)));
const authManager = (managerId: string, pin: string) => league?.managers.find((m) => m.id === managerId && m.pin === pin);

app.get("/api/state", (req, res) => res.json(publicState(String(req.query.viewer || ""))));
app.post("/api/setup", (req, res) => {
  if (league) return res.status(409).json({ error: "League is already set up." });
  const parsed = z.object({ commissionerPin: z.string().min(4), managers: z.array(z.object({ name: z.string().min(1).max(30), pin: z.string().min(4).max(20) })).min(2).max(20) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Use 2–20 managers and PINs of at least 4 characters." });
  const managers = parsed.data.managers.map((m) => ({ id: randomUUID(), ...m, budget: 300, roster: [] as string[] }));
  const nominationOrder = [...managers].sort(() => Math.random() - .5).map((m) => m.id);
  league = { commissionerPin: parsed.data.commissionerPin, managers, nominationOrder, tieOrder: [...nominationOrder].reverse(), current: null, results: [] };
  saveLeague();
  broadcast(); res.json({ ok: true, managers: managers.map(({id,name}) => ({id,name})) });
});
app.post("/api/login", (req, res) => {
  const m = authManager(String(req.body.managerId), String(req.body.pin));
  if (!m) return res.status(401).json({ error: "Manager or PIN is incorrect." });
  res.json({ managerId: m.id, state: publicState(m.id) });
});
app.post("/api/nominate", (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Commissioner PIN is incorrect." });
  if (league.current) return res.status(409).json({ error: "Resolve the current auction first." });
  const manager = league.managers.find(m => m.id === req.body.nominatorId);
  const player = String(req.body.player || "").trim();
  if (!manager || !player) return res.status(400).json({ error: "Choose a nominator and enter a player." });
  if (manager.roster.length >= 20) return res.status(400).json({ error: "That manager's roster is full." });
  league.current = { player, nominatorId: manager.id, bids: [], openedAt: new Date().toISOString() };
  saveLeague();
  broadcast(); res.json({ ok: true });
});
app.post("/api/bid", (req, res) => {
  const m = authManager(String(req.body.managerId), String(req.body.pin));
  if (!league || !m || !league.current) return res.status(401).json({ error: "Sign in and wait for an active auction." });
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > maxBid(m)) return res.status(400).json({ error: `Your bid must be $1–$${maxBid(m)}.` });
  league.current.bids = league.current.bids.filter(b => b.managerId !== m.id);
  league.current.bids.push({ managerId: m.id, amount, submittedAt: new Date().toISOString() });
  saveLeague();
  broadcast(); res.json({ ok: true });
});
app.post("/api/resolve", (req, res) => {
  if (!league || req.body.commissionerPin !== league.commissionerPin) return res.status(401).json({ error: "Commissioner PIN is incorrect." });
  try { const result = resolveAuction(league); saveLeague(); broadcast(); res.json(result); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

io.on("connection", (socket) => {
  socket.on("identify", ({ managerId, pin }) => { if (authManager(managerId, pin)) socket.data.managerId = managerId; socket.emit("state", publicState(socket.data.managerId)); });
  socket.emit("state", publicState());
});
http.listen(port, "0.0.0.0", () => console.log(`Sealed Bid Draft running at http://localhost:${port}`));
