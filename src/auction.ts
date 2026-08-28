export type Manager = { id: string; name: string; pin: string; budget: number; roster: string[] };
export type Bid = { managerId: string; amount: number; submittedAt: string };
export type Nomination = { player: string; nominatorId: string; bids: Bid[]; openedAt: string };
export type Result = { player: string; winnerId: string; amount: number; tied: boolean };
export type League = {
  commissionerPin: string; managers: Manager[]; nominationOrder: string[]; tieOrder: string[];
  current: Nomination | null; results: Result[];
};

export const maxBid = (m: Manager) => m.budget - Math.max(0, 20 - m.roster.length - 1);

export function resolveAuction(league: League): Result {
  const current = league.current;
  if (!current || current.bids.length === 0) throw new Error("No bids have been submitted.");
  const top = Math.max(...current.bids.map((b) => b.amount));
  const tied = current.bids.filter((b) => b.amount === top).map((b) => b.managerId);
  let winnerId: string;
  if (tied.includes(current.nominatorId)) winnerId = current.nominatorId;
  else winnerId = league.tieOrder.find((id) => tied.includes(id))!;
  const winner = league.managers.find((m) => m.id === winnerId)!;
  winner.budget -= top;
  winner.roster.push(current.player);
  if (tied.length > 1 && winnerId !== current.nominatorId) {
    league.tieOrder = league.tieOrder.filter((id) => id !== winnerId).concat(winnerId);
  }
  const result = { player: current.player, winnerId, amount: top, tied: tied.length > 1 };
  league.results.unshift(result);
  league.current = null;
  return result;
}
