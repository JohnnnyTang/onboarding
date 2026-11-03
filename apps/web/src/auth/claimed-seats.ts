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
 * Seats claimed in this tab, kept in memory only (D-007): no web storage, no cookies.
 * A reload forgets guest seats; see Q-018 in decisions.md.
 */
export interface ClaimedSeats {
  get(matchId: string): ClaimedSeat | undefined;
  set(seat: ClaimedSeat): void;
}

export function createClaimedSeats(): ClaimedSeats {
  const seats = new Map<string, ClaimedSeat>();
  return {
    get: (matchId) => seats.get(matchId),
    set: (seat) => {
      seats.set(seat.matchId, { ...seat });
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
