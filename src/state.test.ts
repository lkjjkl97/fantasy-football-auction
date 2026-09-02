import test from "node:test";
import assert from "node:assert/strict";
import type { League } from "./auction.js";
import { buildPublicState } from "./state.js";

const league = (): League => ({
  commissionerPin: "commissioner-secret",
  managers: [
    { id: "a", name: "A", pinHash: "private-a", budget: 300, roster: [], rosterSlotsUsed: 0 },
    { id: "b", name: "B", pinHash: "private-b", budget: 300, roster: [], rosterSlotsUsed: 0 }
  ],
  nominationOrder: ["a", "b"],
  tieOrder: ["b", "a"],
  nominationIndex: 0,
  current: {
    player: "Player",
    nominatorId: "a",
    openingBid: 1,
    openedAt: new Date().toISOString(),
    deadline: new Date(Date.now() + 30_000).toISOString(),
    bids: [
      { managerId: "a", amount: 17, submittedAt: new Date().toISOString() },
      { managerId: "b", amount: 29, submittedAt: new Date().toISOString() }
    ]
  },
  results: []
});

test("anonymous state never exposes sealed bids or PIN data", () => {
  const state = buildPublicState(league())!;
  const serialized = JSON.stringify(state);
  assert.equal("myBid" in state.current!, false);
  assert.equal(serialized.includes("private-a"), false);
  assert.equal(serialized.includes("commissioner-secret"), false);
  assert.equal(serialized.includes('"amount":17'), false);
  assert.equal(serialized.includes('"amount":29'), false);
});

test("authenticated state includes only that manager's bid", () => {
  const state = buildPublicState(league(), "a")!;
  assert.equal(state.current!.myBid, 17);
  assert.equal(JSON.stringify(state).includes('"amount":29'), false);
});
