export type Manager = { id: string; name: string; pinHash?: string; budget: number; startingBudget?: number; rosterLimit?: number; roster: string[]; rosterSlotsUsed: number };
export type Bid = { managerId: string; amount: number; submittedAt: string; passed?: boolean };
export type Nomination = { player: string; nominatorId: string; openingBid: number; bids: Bid[]; openedAt: string; deadline: string; paused?: boolean };
export type Result = { player: string; winnerId: string; amount: number; winningBid: number; tied: boolean; bids: Bid[] };
export type League = { commissionerPin: string; managers: Manager[]; nominationOrder: string[]; tieOrder: string[]; nominationIndex: number; current: Nomination | null; results: Result[]; ended?: boolean };
export const hasRosterSpace = (m: Manager) => m.rosterSlotsUsed < (m.rosterLimit ?? 20);
export const maxBid = (m: Manager) => hasRosterSpace(m) ? m.budget - Math.max(0, (m.rosterLimit ?? 20) - m.rosterSlotsUsed - 1) : 0;
export function nextNominationIndex(l: League, afterIndex=l.nominationIndex-1) {
  for (let offset=1;offset<=l.nominationOrder.length;offset++) {
    const index=(afterIndex+offset+l.nominationOrder.length)%l.nominationOrder.length;
    const manager=l.managers.find((candidate)=>candidate.id===l.nominationOrder[index]);
    if (manager&&hasRosterSpace(manager)) return index;
  }
  return -1;
}
export const allResponded = (l: League) => !!l.current && l.current.bids.length === l.managers.length;
export const canReveal = (l: League, now=Date.now()) => !!l.current && now >= Date.parse(l.current.deadline);
export function resolveAuction(l: League): Result {
  const c=l.current;if(!c)throw Error("No auction is open.");const active=c.bids.filter(b=>!b.passed);if(!active.length)throw Error("No valid bids were submitted.");
  const top=Math.max(...active.map(b=>b.amount));const tied=active.filter(b=>b.amount===top).map(b=>b.managerId);let winnerId:string;
  if(tied.includes(c.nominatorId))winnerId=c.nominatorId;else winnerId=l.tieOrder.find(id=>tied.includes(id))!;
  const priorityBefore=[...l.tieOrder];
  const otherBids=active.filter(b=>b.managerId!==winnerId).map(b=>b.amount);
  const amount=otherBids.length?Math.min(top,Math.max(...otherBids)+1):c.openingBid;
  const winner=l.managers.find(m=>m.id===winnerId)!;winner.budget-=amount;winner.roster.push(c.player);
  winner.rosterSlotsUsed += 1;
  if(tied.length>1&&winnerId!==c.nominatorId)l.tieOrder=l.tieOrder.filter(id=>id!==winnerId).concat(winnerId);
  const tieRank=(managerId:string)=>managerId===c.nominatorId?-1:priorityBefore.indexOf(managerId);
  const revealedBids=[...c.bids].sort((a,b)=>Number(a.passed)-Number(b.passed)||b.amount-a.amount||tieRank(a.managerId)-tieRank(b.managerId));
  const result={player:c.player,winnerId,amount,winningBid:top,tied:tied.length>1,bids:revealedBids};
  l.results.unshift(result);l.current=null;const nextIndex=nextNominationIndex(l,l.nominationIndex);if(nextIndex<0)l.ended=true;else l.nominationIndex=nextIndex;return result;
}
