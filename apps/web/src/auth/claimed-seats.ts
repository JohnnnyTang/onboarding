import type { TokenSource } from "../api/client";
import type { AuthService } from "./auth";

/** A seat claimed from an invite in this tab. */
export interface ClaimedSeat {
  matchId: string;
  seat: string;
  displayName: string;
  /** Present for guests; signed-in designers use their own access token instead. */
  guestToken: string | null;
}

/**
 * Seats claimed in this tab. Kept in session storage when one is supplied, so a guest who
 * reloads the page returns to the same seat (Q-018, AC-06). Session storage belongs to this
 * tab only, is cleared when the tab closes, and is out of reach of the game worker
 * (workers have no web storage). Designer tokens are never stored (D-007).
 */
export interface ClaimedSeats {
  get(matchId: string): ClaimedSeat | undefined;
  set(seat: ClaimedSeat): void;
}

/** The parts of `Storage` the store uses. */
export type SeatStorage = Pick<Storage, "getItem" | "setItem">;

export const CLAIMED_SEATS_KEY = "bgp.claimedSeats";
/** Older entries are dropped first; a tab rarely plays this many matches. */
export const MAX_STORED_SEATS = 20;

function isClaimedSeat(value: unknown): value is ClaimedSeat {
  if (typeof value !== "object" || value === null) return false;
  const seat = value as Record<string, unknown>;
  return (
    typeof seat.matchId === "string" &&
    typeof seat.seat === "string" &&
    typeof seat.displayName === "string" &&
    (seat.guestToken === null || typeof seat.guestToken === "string")
  );
}

function load(storage: SeatStorage | null): ClaimedSeat[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CLAIMED_SEATS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isClaimedSeat) : [];
  } catch {
    return [];
  }
}

export function createClaimedSeats(storage: SeatStorage | null = null): ClaimedSeats {
  const seats = new Map<string, ClaimedSeat>();
  for (const seat of load(storage)) seats.set(seat.matchId, { ...seat });
  const save = () => {
    if (!storage) return;
    try {
      storage.setItem(CLAIMED_SEATS_KEY, JSON.stringify([...seats.values()]));
    } catch {
      // Storage full or blocked: the seat still works until the next reload.
    }
  };
  return {
    get: (matchId) => {
      const seat = seats.get(matchId);
      return seat ? { ...seat } : undefined;
    },
    set: (seat) => {
      seats.delete(seat.matchId);
      seats.set(seat.matchId, {
        matchId: seat.matchId,
        seat: seat.seat,
        displayName: seat.displayName,
        guestToken: seat.guestToken,
      });
      while (seats.size > MAX_STORED_SEATS) {
        const oldest = seats.keys().next().value;
        if (oldest === undefined) break;
        seats.delete(oldest);
      }
      save();
    },
  };
}

/**
 * Picks the bearer token for a request: a guest token for the match it was issued for,
 * otherwise the designer's access token, otherwise none.
 */
export function createTokenSource(auth: AuthService, seats: ClaimedSeats): TokenSource {
  return {
    tokenFor(scope) {
      const guest = scope.matchId ? seats.get(scope.matchId)?.guestToken : null;
      return guest ?? auth.accessToken();
    },
  };
}
