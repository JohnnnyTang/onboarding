import { HOST_PROTOCOL_VERSION, type HostCommand, HostRequestSchema } from "@bgp/schema";
import { MAX_IPC_BYTES } from "./host-constants.js";
import { prepareQuickJs, QuickJsSandbox } from "./quickjs-sandbox.js";

let sandbox: QuickJsSandbox | undefined;
let busy = false;
process.on("disconnect", () => process.exit(0));
process.on("message", async (raw: unknown) => {
  // Malformed envelopes cannot be correlated safely. Never echo input or exceptions.
  let id: number;
  let command: HostCommand;
  try {
    if (busy || Buffer.byteLength(JSON.stringify(raw)) > MAX_IPC_BYTES) throw Error();
    const request = HostRequestSchema.parse(raw);
    id = request.id;
    command = request.command;
  } catch {
    process.exit(1);
  }
  busy = true;
  try {
    let value: unknown = null;
    if (command.op === "prepare") {
      if (sandbox) throw Error();
      await prepareQuickJs();
    } else if (command.op === "load") {
      if (sandbox) throw Error();
      sandbox = await QuickJsSandbox.load(command.source, command);
    } else {
      if (!sandbox) throw Error();
      switch (command.op) {
        case "create":
          await sandbox.create(command.init);
          break;
        case "apply":
          value = await sandbox.apply(command.seat, command.intent);
          break;
        case "views":
          value = await sandbox.views();
          break;
        case "hash":
          value = await sandbox.hash();
          break;
        case "exportState":
          value = await sandbox.exportState();
          break;
        case "restore":
          await sandbox.restore(command.snapshot, command.events);
          break;
        case "dispose":
          sandbox.dispose();
          break;
      }
    }
    const reply = { v: HOST_PROTOCOL_VERSION, id, ok: true, value };
    if (Buffer.byteLength(JSON.stringify(reply)) > MAX_IPC_BYTES) throw Error();
    process.send?.(reply);
  } catch {
    sandbox?.dispose();
    process.send?.({
      v: HOST_PROTOCOL_VERSION,
      id,
      ok: false,
      code: "GAME_ERROR",
      message: "Game execution failed",
    });
  } finally {
    busy = false;
  }
});
