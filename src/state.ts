import { maxBid, type League } from "./auction.js";

export function buildPublicState(league: League | null, viewerId?: string) {
  if (!league) return null;
  const current = league.current && {
    player: league.current.player,
    nominatorId: league.current.nominatorId,
    openingBid: league.current.openingBid,
    openedAt: league.current.openedAt,
    deadline: league.current.deadline,
    paused: league.current.paused,
    responses: league.managers.map((manager) => ({
      managerId: manager.id,
      submitted: league.current!.bids.some((bid) => bid.managerId === manager.id)
    })),
    ...(viewerId ? {
      myBid: league.current.bids.find((bid) => bid.managerId === viewerId)?.amount,
      myPassed: league.current.bids.find((bid) => bid.managerId === viewerId)?.passed
    } : {})
  };

  return {
    managers: league.managers.map((manager) => ({
      id: manager.id,
      name: manager.name,
      budget: manager.budget,
      roster: manager.roster,
      rosterSlotsUsed: manager.rosterSlotsUsed,
      rosterSpotsLeft: 20 - manager.rosterSlotsUsed,
      maxBid: maxBid(manager)
    })),
    nominationOrder: league.nominationOrder,
    tieOrder: league.tieOrder,
    nominationIndex: league.nominationIndex,
    current,
    results: league.results,
    ended: league.ended
  };
}
