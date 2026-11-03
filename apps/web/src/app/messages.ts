import { ApiError, UnexpectedResponseError } from "../api/client";

/** Human-readable text for a failed request. Server messages are already client-safe. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "UNAUTHORIZED":
        return "Your session has ended. Sign in again.";
      case "FORBIDDEN":
        return "You do not have access to this.";
      case "NOT_FOUND":
        return "This could not be found.";
      case "INTERNAL":
        return "Something went wrong on the server. Try again shortly.";
      default:
        return error.message;
    }
  }
  if (error instanceof UnexpectedResponseError) {
    return "The server sent an unexpected response. Try again shortly.";
  }
  return "Could not reach the server. Check your connection and try again.";
}

/** Rules seats are "0".."n-1"; people count from one. */
export function seatLabel(seat: string): string {
  const index = Number(seat);
  return Number.isSafeInteger(index) ? `Seat ${index + 1}` : `Seat ${seat}`;
}

/** Retry transient failures only: never repeat a request the server refused. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  if (error instanceof UnexpectedResponseError) return false;
  return failureCount < 2;
}
