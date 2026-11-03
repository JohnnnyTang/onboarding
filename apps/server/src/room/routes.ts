import websocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import type { AuthService } from "../auth/service.js";
import type { Database } from "../db/connection.js";
import { ClientConnection } from "./connection.js";
import type { RoomManager } from "./manager.js";

export interface RoomRouteOptions {
  db: Database;
  auth: AuthService;
  rooms: RoomManager;
  /** Defaults to the protocol's 10 seconds. */
  helloTimeoutMs?: number;
}

/** Largest accepted client frame; `ws` closes the socket (1009) above it. */
export const MAX_CLIENT_FRAME_BYTES = 64 * 1024;

/** `GET /ws`: the room server endpoint. Authentication happens in the `hello` message. */
export const roomRoutes: FastifyPluginAsync<RoomRouteOptions> = async (app, options) => {
  const { rooms } = options;
  rooms.log = app.log;
  await app.register(websocket, { options: { maxPayload: MAX_CLIENT_FRAME_BYTES } });
  app.addHook("onClose", async () => rooms.close());
  app.get("/ws", { websocket: true, config: { auth: "none" } }, (socket) => {
    const connection = new ClientConnection(
      {
        isOpen: () => socket.readyState === socket.OPEN,
        send: (text) => socket.send(text),
        close: (code, reason) => socket.close(code, reason),
      },
      {
        db: options.db,
        auth: options.auth,
        rooms,
        log: app.log,
        helloTimeoutMs: options.helloTimeoutMs ?? 10_000,
      },
    );
    socket.on("message", (data, isBinary) => {
      connection.receive(!isBinary && Buffer.isBuffer(data) ? data.toString("utf8") : null);
    });
    socket.on("close", () => connection.closed());
    socket.on("error", () => connection.closed());
  });
};
