import {
  type GameDefinition,
  type Invalid,
  InvalidSchema,
  type Json,
  type Random,
  type SeatId,
} from "@bgp/schema";

export function invalid(code: string, message: string): Invalid {
  return InvalidSchema.parse({ invalid: true, code, message });
}

export function defineGame<S extends Json, V extends Json = Json>(
  definition: GameDefinition<S, V>,
): GameDefinition<S, V> {
  return definition;
}

export function rekey<T extends { id: string }>(items: readonly T[], random: Random): T[] {
  return items.map((item) => ({ ...item, id: random.id() }));
}

export function countHidden(items: readonly unknown[]): number {
  return items.length;
}

/** All other seats in turn order, starting immediately after the given seat. */
export function seatsAfter(seats: readonly SeatId[], seat: SeatId): SeatId[] {
  const index = seats.indexOf(seat);
  if (index < 0) throw new Error("Unknown seat");
  return [...seats.slice(index + 1), ...seats.slice(0, index)];
}
