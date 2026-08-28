import test from "node:test";
import assert from "node:assert/strict";
import { maxBid, resolveAuction, type League } from "./auction.js";

const league = (): League => ({ commissionerPin: "x", managers: [
  { id: "a", name: "A", pin: "1", budget: 300, roster: [] },
  { id: "b", name: "B", pin: "2", budget: 300, roster: [] },
  { id: "c", name: "C", pin: "3", budget: 300, roster: [] }
], nominationOrder: ["a","b","c"], tieOrder: ["c","b","a"], current: null, results: [] });

test("reserves one dollar for every remaining roster slot", () => {
  assert.equal(maxBid(league().managers[0]), 281);
});
test("nominator wins a top-bid tie without changing priority", () => {
  const l = league(); l.current = { player: "Player", nominatorId: "a", openedAt: "", bids: [{managerId:"a",amount:10,submittedAt:""},{managerId:"c",amount:10,submittedAt:""}] };
  assert.equal(resolveAuction(l).winnerId, "a"); assert.deepEqual(l.tieOrder,["c","b","a"]);
});
test("priority resolves other ties and winner moves to bottom", () => {
  const l = league(); l.current = { player: "Player", nominatorId: "a", openedAt: "", bids: [{managerId:"b",amount:10,submittedAt:""},{managerId:"c",amount:10,submittedAt:""}] };
  assert.equal(resolveAuction(l).winnerId, "c"); assert.deepEqual(l.tieOrder,["b","a","c"]);
});
