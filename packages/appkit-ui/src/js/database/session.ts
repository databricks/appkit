/** The reply header that names, opaquely, the actor a reply was computed for. */
export const DATABASE_ACTOR_HEADER = "x-appkit-database-actor";

/** One request's place in the session history. */
export interface DatabaseRequestTicket {
  readonly sequence: number;
  /** The epoch it was sent in, moved forward when its own reply opens one. */
  epoch: number;
}

const UNOBSERVED = Symbol("unobserved");

let sequence = 0;
let epoch = 0;
let actor: string | null | typeof UNOBSERVED = UNOBSERVED;
/** The latest request whose reply agreed with `actor`. */
let confirmed = 0;
const listeners = new Set<() => void>();

export function openDatabaseRequest(): DatabaseRequestTicket {
  sequence += 1;
  return { sequence, epoch };
}

/**
 * Record what a reply says about the session and report whether to deliver
 * it. `observed` is the reply's actor, or `null` for a 401. A reply that opens
 * a new epoch is delivered in that epoch.
 */
export function acceptDatabaseReply(
  ticket: DatabaseRequestTicket,
  observed: string | null,
): boolean {
  if (ticket.epoch !== epoch) return false;
  if (observed === actor) {
    confirmed = Math.max(confirmed, ticket.sequence);
    return true;
  }
  // A request sent before one that answered as `actor` saw an older session.
  if (ticket.sequence < confirmed) return false;
  const firstReply = actor === UNOBSERVED;
  actor = observed;
  confirmed = ticket.sequence;
  if (!firstReply) {
    epoch += 1;
    ticket.epoch = epoch;
    for (const listener of [...listeners]) listener();
  }
  return true;
}

/** Whether a reply to `ticket` still belongs to the current session. */
export function isCurrentDatabaseRequest(
  ticket: DatabaseRequestTicket,
): boolean {
  return ticket.epoch === epoch;
}

export function getDatabaseSessionEpoch(): number {
  return epoch;
}

/** Call `listener` whenever a new epoch opens. Returns the unsubscribe. */
export function subscribeDatabaseSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget the session. Subscribers stay attached. */
export function resetDatabaseSession(): void {
  sequence = 0;
  epoch = 0;
  actor = UNOBSERVED;
  confirmed = 0;
}
