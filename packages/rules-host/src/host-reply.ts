import {
  type HostCommand,
  HostMoveOutcomeSchema,
  HostViewsSchema,
  MatchStateSchema,
  Sha256Schema,
} from "@bgp/schema";

/** Validate the payload for the outstanding operation, not just the IPC envelope. */
export function validHostReply(op: HostCommand["op"], value: unknown): boolean {
  switch (op) {
    case "apply":
      return HostMoveOutcomeSchema.safeParse(value).success;
    case "views":
      return HostViewsSchema.safeParse(value).success;
    case "hash":
      return Sha256Schema.safeParse(value).success;
    case "exportState":
      return MatchStateSchema.safeParse(value).success;
    default:
      return value === null;
  }
}
