import type { ActionButton, ClientView, TableSnapshot } from "@bgp/schema";
import { describe, expect, it } from "vitest";
import { GameWorkerError } from "./game-worker-client";
import { createTablePresenter } from "./table-presenter";

const view = (count: number): ClientView => ({
  ctx: {
    seats: ["0"],
    currentSeat: "0",
    activeSeats: ["0"],
    phase: "main",
    turn: 1,
    moveNumber: count,
    options: {},
  },
  game: { count },
  result: null,
});

const snapshot = (count: number, selectable: string[]): TableSnapshot => ({
  table: { size_mm: [400, 300] },
  zones: [{ id: "z", layout: "row", rect_mm: { x: 0, y: 0, w: 200, h: 100 } }],
  items: selectable.map((id, index) => ({ id, zone: "z", index, face: "up", selectable: true })),
  prompt: `count ${count}`,
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("table presenter", () => {
  it("presents the view, then asks for actions with the selection", async () => {
    const calls: string[][] = [];
    const presenter = createTablePresenter(
      {
        present: async (v) => snapshot(Number((v.game as { count: number }).count), ["a", "b"]),
        actions: async (_v, _seat, selection) => {
          calls.push(selection);
          return [{ id: "go", label: `Go ${selection.length}`, enabled: false }];
        },
        interpret: async () => ({ move: "go" }),
      },
      "0",
    );
    presenter.setView(view(1));
    await flush();
    expect(presenter.getState().snapshot?.prompt).toBe("count 1");
    expect(presenter.getState().actions).toEqual([{ id: "go", label: "Go 0", enabled: false }]);
    presenter.setSelection(["a", "a", "b"]);
    await flush();
    expect(calls.at(-1)).toEqual(["a", "b"]);
    expect(presenter.getState().actions[0]?.label).toBe("Go 2");
    expect(await presenter.interpret({ kind: "click", item: "a" })).toEqual({ move: "go" });
  });

  it("drops results from views that were replaced meanwhile", async () => {
    const first = deferred<TableSnapshot>();
    const second = deferred<TableSnapshot>();
    const pending = [first, second];
    const presenter = createTablePresenter(
      {
        present: () => pending.shift()?.promise ?? Promise.reject(new Error("extra")),
        actions: async () => [] as ActionButton[],
        interpret: async () => null,
      },
      "0",
    );
    presenter.setView(view(1));
    presenter.setView(view(2));
    second.resolve(snapshot(2, []));
    await flush();
    first.resolve(snapshot(1, []));
    await flush();
    expect(presenter.getState().snapshot?.prompt).toBe("count 2");
  });

  it("prunes selected items that are no longer selectable", async () => {
    let selectable = ["a", "b"];
    const presenter = createTablePresenter(
      {
        present: async () => snapshot(1, selectable),
        actions: async () => [],
        interpret: async () => null,
      },
      "0",
    );
    presenter.setView(view(1));
    await flush();
    presenter.setSelection(["a", "b"]);
    selectable = ["b"];
    presenter.setView(view(2));
    await flush();
    expect(presenter.getState().selection).toEqual(["b"]);
  });

  it("keeps the last snapshot and reports game failures", async () => {
    let fail = false;
    const presenter = createTablePresenter(
      {
        present: async () => {
          if (fail) throw new GameWorkerError("timeout");
          return snapshot(1, []);
        },
        actions: async () => [],
        interpret: async () => {
          throw new Error("boom");
        },
      },
      "0",
    );
    presenter.setView(view(1));
    await flush();
    fail = true;
    presenter.setView(view(2));
    await flush();
    expect(presenter.getState().snapshot?.prompt).toBe("count 1");
    expect(presenter.getState().error?.reason).toBe("timeout");
    expect(await presenter.interpret({ kind: "click", item: "x" })).toBeNull();
    expect(presenter.getState().error?.reason).toBe("failed");
  });
});
