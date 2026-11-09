/**
 * Which signed-in actor the page's database data belongs to.
 *
 * Every authenticated operation reply names its actor in an opaque header.
 * Requests are numbered as they are sent and stamped with the session epoch.
 * A reply from an earlier epoch, or one that contradicts a reply to a later
 * request, is stale and never delivered. A reply to a later request that names
 * another actor, or a 401 after an authenticated reply, opens a new epoch, and
 * subscribers drop what they show for the old one.
 */

/** The reply header that names, opaquely, the actor a reply was computed for. */
export const DATABASE_ACTOR_HEADER = "x-appkit-database-actor";

/** One request's place in the session history. */
interface DatabaseRequestTicket {
  readonly sequence: number;
  /** The epoch it was sent in, moved forward when its own reply opens one. */
  epoch: number;
}

let sequence = 0;
let epoch = 0;
/** The actor this epoch's replies named; `null` before one, or after a 401. */
let actor: string | null = null;
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
  const opensEpoch = actor !== null;
  actor = observed;
  confirmed = ticket.sequence;
  if (opensEpoch) {
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
  actor = null;
  confirmed = 0;
}
