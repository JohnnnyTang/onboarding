import type { SeatId } from "@bgp/schema";
import type { Database } from "../db/connection.js";
import { Room, type RoomClient, type RoomEngine, type RoomLogger } from "./room.js";

export interface RoomManagerOptions {
  db: Database;
  engine: RoomEngine;
  /** Dispose an empty room after this many milliseconds (default 30 seconds). */
  idleMs?: number;
}

const silent: RoomLogger = { error() {} };

/** Live rooms by match ID. Rooms load lazily on the first `hello` and close when idle. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  /** Server-side log only; the Fastify logger is attached when the routes register. */
  log: RoomLogger = silent;

  constructor(private readonly options: RoomManagerOptions) {}

  /** Joins the client to its match room; a failed join has already closed the client. */
  async join(matchId: string, client: RoomClient): Promise<Room | null> {
    // A room that closed while this join waited in its queue is replaced once.
    for (let attempt = 0; attempt < 2; attempt++) {
      const room = this.room(matchId);
      const result = await room.join(client);
      if (result === "joined") return room;
      if (result === "failed") return null;
    }
    client.fail("INTERNAL", "Internal server error");
    return null;
  }

  /** Connected seats for the HTTP match summaries. */
  isConnected(matchId: string, seat: SeatId): boolean {
    return this.rooms.get(matchId)?.isConnected(seat) ?? false;
  }

  /** Wire to `RulesHostClientOptions.onProcessExit`. */
  hostExited(matchId: string): void {
    void this.rooms
      .get(matchId)
      ?.hostExited()
      .catch(() => {});
  }

  /** Called by the HTTP API after a match is abandoned. */
  abandoned(matchId: string): void {
    void this.rooms
      .get(matchId)
      ?.abandoned()
      .catch(() => {});
  }

  close(): void {
    for (const room of this.rooms.values()) room.close();
    this.rooms.clear();
  }

  private room(matchId: string): Room {
    let room = this.rooms.get(matchId);
    if (!room) {
      room = new Room(
        matchId,
        {
          db: this.options.db,
          engine: this.options.engine,
          idleMs: this.options.idleMs ?? 30_000,
          log: { error: (details, message) => this.log.error(details, message) },
        },
        (closed) => {
          if (this.rooms.get(matchId) === closed) this.rooms.delete(matchId);
        },
      );
      this.rooms.set(matchId, room);
    }
    return room;
  }
}
