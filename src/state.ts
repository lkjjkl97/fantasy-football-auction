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
      submitted: league.current!.bids.some((bid) => bid.managerId === manager.id),
      eligible: manager.rosterSlotsUsed < (manager.rosterLimit ?? 20)
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
      rosterLimit: manager.rosterLimit ?? 20,
      startingBudget: manager.startingBudget ?? 300,
      rosterSpotsLeft: (manager.rosterLimit ?? 20) - manager.rosterSlotsUsed,
      maxBid: maxBid(manager)
    })),
    nominationOrder: league.nominationOrder,
    tieOrder: league.tieOrder,
    nominationIndex: league.nominationIndex,
    current,
    results: league.results.map((result) => ({
      player: result.player,
      winnerId: result.winnerId,
      amount: result.amount,
      winningBid: result.winningBid,
      tied: result.tied,
      bids: result.bids
    })),
    ended: league.ended
  };
}
