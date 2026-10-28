import type {
  AcceptedEvent,
  ApplyResult,
  ClientView,
  Json,
  MatchInit,
  MatchState,
  MoveIntent,
  SeatId,
} from "@bgp/schema";

export type MoveOutcome =
  | { ok: true; event: AcceptedEvent }
  | Extract<ApplyResult<Json>, { ok: false }>;

/** One match per instance. Snapshots are privileged server data, never client payloads. */
export interface RulesSandbox {
  create(init: MatchInit): Promise<void>;
  apply(seat: SeatId, intent: MoveIntent): Promise<MoveOutcome>;
  views(): Promise<Record<SeatId, ClientView>>;
  hash(): Promise<string>;
  exportState(): Promise<MatchState>;
  restore(snapshot: MatchState, events: AcceptedEvent[]): Promise<void>;
  dispose(): void;
}

export interface SandboxOptions {
  timeoutMs?: number;
  memoryLimitBytes?: number;
}
