import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function worker() {
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  const child = fork(new URL("../dist/host-entry.js", import.meta.url), [], {
    execArgv: ["--permission", `--allow-fs-read=${dist}`],
    env: {},
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.on("error", () => {});
  return {
    dispose: () => child.kill("SIGKILL"),
    request(raw: unknown): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.removeListener("message", reply);
          child.removeListener("exit", failed);
        };
        const failed = () => {
          cleanup();
          reject(Error("Host worker disconnected"));
        };
        const reply = (value: unknown) => {
          cleanup();
          resolve(value);
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          failed();
        }, 1000);
        child.once("message", reply);
        child.once("exit", failed);
        child.send(raw as object, (error) => {
          if (error) failed();
        });
      });
    },
  };
}

describe("real host IPC boundary", () => {
  it.each([
    { v: 2, id: 1, command: { op: "prepare" } },
    { v: 1, id: 0, command: { op: "prepare" } },
    { v: 1, id: 1, command: { op: "eval", source: "hidden" } },
    { v: 1, id: 1, command: { op: "prepare", hidden: "private" } },
  ])("disconnects malformed request %# without echoing it", async (raw) => {
    const host = worker();
    try {
      await expect(host.request(raw)).rejects.toThrow("Host worker disconnected");
    } finally {
      host.dispose();
    }
  });

  it.each([1, 2])("rejects replayed or decreasing request ID %i", async (id) => {
    const host = worker();
    try {
      expect(await host.request({ v: 1, id: 2, command: { op: "prepare" } })).toEqual({
        v: 1,
        id: 2,
        ok: true,
        value: null,
      });
      await expect(host.request({ v: 1, id, command: { op: "prepare" } })).rejects.toThrow(
        "Host worker disconnected",
      );
    } finally {
      host.dispose();
    }
  });
});
