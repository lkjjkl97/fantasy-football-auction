export type Manager = { id: string; name: string; budget: number; roster: string[]; rosterSlotsUsed: number };
export type Bid = { managerId: string; amount: number; submittedAt: string; passed?: boolean };
export type Nomination = { player: string; nominatorId: string; openingBid: number; bids: Bid[]; openedAt: string; deadline: string };
export type Result = { player: string; winnerId: string; amount: number; tied: boolean; bids: Bid[] };
export type League = { commissionerPin: string; managers: Manager[]; nominationOrder: string[]; tieOrder: string[]; nominationIndex: number; current: Nomination | null; results: Result[] };
export const maxBid = (m: Manager) => m.budget - Math.max(0, 20 - m.rosterSlotsUsed - 1);
export const allResponded = (l: League) => !!l.current && l.current.bids.length === l.managers.length;
export const canReveal = (l: League, now=Date.now()) => allResponded(l) || (!!l.current && now >= Date.parse(l.current.deadline));
export function resolveAuction(l: League): Result {
  const c=l.current;if(!c)throw Error("No auction is open.");const active=c.bids.filter(b=>!b.passed);if(!active.length)throw Error("No valid bids were submitted.");
  const top=Math.max(...active.map(b=>b.amount));const tied=active.filter(b=>b.amount===top).map(b=>b.managerId);let winnerId:string;
  if(tied.includes(c.nominatorId))winnerId=c.nominatorId;else winnerId=l.tieOrder.find(id=>tied.includes(id))!;
  const winner=l.managers.find(m=>m.id===winnerId)!;winner.budget-=top;winner.roster.push(c.player);
  winner.rosterSlotsUsed += 1;
  if(tied.length>1&&winnerId!==c.nominatorId)l.tieOrder=l.tieOrder.filter(id=>id!==winnerId).concat(winnerId);
  const result={player:c.player,winnerId,amount:top,tied:tied.length>1,bids:[...c.bids].sort((a,b)=>Number(a.passed)-Number(b.passed)||b.amount-a.amount)};
  l.results.unshift(result);l.current=null;l.nominationIndex=(l.nominationIndex+1)%l.managers.length;return result;
}
