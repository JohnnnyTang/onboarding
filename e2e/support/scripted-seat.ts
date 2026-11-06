import {
  type ClientView,
  type GameResult,
  type MoveIntent,
  PROTOCOL_VERSION,
  type ServerMessage,
  ServerMessageSchema,
} from "../../packages/schema/src/index.js";

const WAIT_MS = 15_000;

/**
 * One seat played by a script over the room server's WebSocket protocol. It does not apply
 * patches: it notes their `seq` and asks for a `snapshot` (`resync`) when it needs its view
 * to choose a move.
 */
export class ScriptedSeat {
  seq = 0;
  result: GameResult | null = null;
  private view: ClientView | null = null;
  private clientSeq = 0;
  private readonly waiters = new Set<() => void>();
  private failure: string | null = null;

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      const parsed = ServerMessageSchema.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) this.failure = "Invalid server message";
      else this.receive(parsed.data);
      for (const wake of this.waiters) wake();
    };
    socket.onclose = () => {
      this.failure ??= "Connection closed";
      for (const wake of this.waiters) wake();
    };
  }

  /** Connects with a guest token and waits for `welcome`. */
  static async connect(url: string, matchId: string, token: string): Promise<ScriptedSeat> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket failed"));
    });
    const seat = new ScriptedSeat(socket);
    seat.send({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      matchId,
      auth: { kind: "guest", token },
    });
    await seat.until(() => seat.view !== null);
    return seat;
  }

  private receive(message: ServerMessage) {
    switch (message.t) {
      case "welcome":
      case "snapshot":
        this.view = message.view;
        this.seq = message.seq;
        break;
      case "patch":
        // The kept view is now out of date; `currentView` fetches a fresh one.
        if (this.view?.ctx.moveNumber !== message.seq) this.view = null;
        this.seq = message.seq;
        break;
      case "ended":
        this.result = message.result;
        break;
      case "rejected":
        this.failure = `Move rejected: ${message.message}`;
        break;
      case "error":
        this.failure = `${message.code}: ${message.message}`;
        break;
      default:
        break;
    }
  }

  private send(message: unknown) {
    this.socket.send(JSON.stringify(message));
  }

  /** Resolves once `test` holds; rejects on a rejection, an error or a timeout. */
  until(test: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Seat timed out")), WAIT_MS);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.failure) finish(new Error(this.failure));
        else if (test()) finish();
      };
      this.waiters.add(check);
      check();
    });
  }

  /** This seat's view at the current `seq`. */
  async currentView(): Promise<ClientView> {
    if (!this.view) {
      this.send({ t: "resync" });
      await this.until(() => this.view !== null);
    }
    if (!this.view) throw new Error("No view");
    return this.view;
  }

  move(intent: MoveIntent): void {
    this.send({ t: "move", clientSeq: this.clientSeq++, intent });
  }

  close(): void {
    this.socket.close();
  }
}
