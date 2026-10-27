import { describe, expect, test } from "vitest";
import {
  type AcceptedEvent,
  type ApplyResult,
  applyIntent,
  createMatch,
  type GameDefinition,
  hashState,
  invalid,
  type Json,
  type MatchState,
  type MoveContext,
  replay,
  viewFor,
} from "../src/index.js";
import { ticTacToe } from "./tic-tac-toe.js";

type State = { count: number; trace: string[]; secret: string };
const init = { seats: ["0", "1", "2"], seed: 123, options: {} };
function game(overrides: Partial<GameDefinition<State>> = {}): GameDefinition<State> {
  return {
    sdk: 1,
    setup: () => ({ count: 0, trace: [], secret: "HIDDEN_FISH" }),
    moves: {
      act: {
        apply(state) {
          state.count += 1;
        },
      },
    },
    playerView: (state, _ctx, seat) => (seat === "0" ? state : { count: state.count }),
    present: () => ({ table: { size_mm: [300, 300] }, zones: [], items: [] }),
    ...overrides,
  };
}
function accepted<S extends Json>(result: ApplyResult<S>): MatchState<S> {
  if (!result.ok) throw new Error(`Expected acceptance: ${result.code}`);
  return result.state;
}

describe("match initialization", () => {
  test("setup, initial phase, and first turn run in order with isolated inputs", () => {
    const def = game({
      setup(input) {
        input.seats.reverse();
        return { count: input.random.die(6), trace: ["setup"], secret: "fish" };
      },
      phases: {
        opening: {
          onBegin(state, ctx) {
            state.trace.push(`phase:${ctx.seat}:${ctx.turn}`);
          },
        },
      },
      startPhase: "opening",
      turn: {
        onBegin(state, ctx) {
          state.trace.push(`turn:${ctx.seat}:${ctx.turn}`);
        },
      },
    });
    const state = createMatch(def, init);
    expect(state.game.trace).toEqual(["setup", "phase:0:1", "turn:0:1"]);
    expect(state.ctx).toEqual({
      seats: ["0", "1", "2"],
      currentSeat: "0",
      activeSeats: ["0"],
      phase: "opening",
      turn: 1,
      moveNumber: 0,
      options: {},
    });
    expect(createMatch(def, init)).toEqual(state);
    expect(init.seats).toEqual(["0", "1", "2"]);
  });

  test("flushes events from initialization hooks", () => {
    const def = game({
      turn: {
        onBegin(_state, ctx) {
          ctx.events.setActiveSeats(["0", "1"]);
        },
      },
    });
    expect(createMatch(def, init).ctx.activeSeats).toEqual(["0", "1"]);
  });

  test("invalid input, definitions, setup state and hooks fail with a fixed message", () => {
    for (const def of [
      game({ setup: () => ({ count: 0.5, trace: [], secret: "fish" }) }),
      game({ startPhase: "missing" }),
      game({
        setup: () => {
          throw new Error("HIDDEN_FISH");
        },
      }),
      game({
        turn: {
          onBegin() {
            throw new Error("HIDDEN_FISH");
          },
        },
      }),
    ]) {
      expect(() => createMatch(def, init)).toThrow("Game initialization failed");
    }
    expect(() => createMatch(game(), { ...init, seats: [] })).toThrow("Game initialization failed");
  });
});

describe("rejection precedence and rollback", () => {
  test("finished, unknown move, phase and seat gates follow contract order", () => {
    const def = game({ phases: { main: { moves: [] } }, startPhase: "main" });
    const state = createMatch(def, init);
    expect(
      applyIntent(def, { ...state, result: { winners: [] } }, "1", { move: "missing" }),
    ).toMatchObject({ ok: false, code: "MATCH_FINISHED" });
    expect(applyIntent(def, state, "1", { move: "missing" })).toMatchObject({
      ok: false,
      code: "UNKNOWN_MOVE",
    });
    expect(applyIntent(def, state, "1", { move: "act" })).toMatchObject({
      ok: false,
      code: "MOVE_NOT_ALLOWED",
    });
    expect(applyIntent(game(), state, "1", { move: "act" })).toMatchObject({
      ok: false,
      code: "NOT_YOUR_TURN",
    });
    expect(applyIntent(game(), state, "0", { move: "toString" })).toMatchObject({
      ok: false,
      code: "UNKNOWN_MOVE",
    });
  });

  test("anySeat bypasses active seats only for real match seats", () => {
    const def = game({ moves: { act: { anySeat: true, apply() {} } } });
    const state = createMatch(def, init);
    expect(applyIntent(def, state, "2", { move: "act" }).ok).toBe(true);
    expect(applyIntent(def, state, "99", { move: "act" })).toMatchObject({
      ok: false,
      code: "NOT_YOUR_TURN",
    });
  });

  test("parse invalid, throws and non-JSON outputs reject as INVALID_ARGS", () => {
    const parsers = [
      () => invalid("BAD_ARGS", "Choose a card"),
      () => {
        throw new Error("HIDDEN_FISH");
      },
      () => 0.5,
    ];
    for (const parse of parsers) {
      const def = game({
        moves: {
          act: {
            parse,
            apply() {
              throw new Error("must not run");
            },
          },
        },
      });
      expect(applyIntent(def, createMatch(def, init), "0", { move: "act" })).toMatchObject({
        ok: false,
        code: "INVALID_ARGS",
      });
    }
    const def = game();
    const result = applyIntent(def, createMatch(def, init), "0", { move: "act", args: 0.5 });
    expect(result).toEqual({ ok: false, code: "INVALID_ARGS", message: "Invalid arguments" });
  });

  test("omitted args reach parse as undefined and otherwise default to null", () => {
    const def = game({
      moves: {
        act: {
          parse(args) {
            expect(args).toBeUndefined();
            return 7;
          },
          apply(state, _ctx, args) {
            state.count = args as number;
          },
        },
      },
    });
    expect(
      accepted(applyIntent(def, createMatch(def, init), "0", { move: "act" })).game.count,
    ).toBe(7);
    const plain = game({
      moves: {
        act: {
          apply(_state, _ctx, args) {
            expect(args).toBeNull();
          },
        },
      },
    });
    expect(applyIntent(plain, createMatch(plain, init), "0", { move: "act" }).ok).toBe(true);
  });

  test("invalid moves discard mutation, random draws and queued events", () => {
    const def = game({
      moves: {
        act: {
          apply(state, ctx) {
            state.count = ctx.random.die(6);
            ctx.events.endTurn();
            ctx.events.endGame({ winners: ["0"] });
            return invalid("NO_CARDS", "No cards left");
          },
        },
      },
    });
    const state = createMatch(def, init);
    const before = JSON.stringify(state);
    expect(applyIntent(def, state, "0", { move: "act" })).toEqual({
      ok: false,
      code: "INVALID_MOVE",
      gameCode: "NO_CARDS",
      message: "No cards left",
    });
    expect(JSON.stringify(state)).toBe(before);
    const good = game({
      moves: {
        act: {
          apply(s, ctx) {
            s.count = ctx.random.die(6);
          },
        },
      },
    });
    expect(applyIntent(good, state, "0", { move: "act" })).toEqual(
      applyIntent(good, createMatch(good, init), "0", { move: "act" }),
    );
  });

  test.each(["apply", "phaseEnd", "phaseBegin", "turnEnd", "turnNext", "turnBegin", "endIf"])(
    "exceptions in %s discard the entire transaction without leaking",
    (location) => {
      const fail = () => {
        throw new Error("HIDDEN_FISH rng=[1,2,3,4]");
      };
      const def = game({ phases: { a: {}, b: {} }, startPhase: "a" });
      const state = createMatch(def, init);
      def.moves.act = {
        apply(s, ctx) {
          s.count += ctx.random.die(6);
          ctx.events.setPhase("b");
          ctx.events.endTurn();
          if (location === "apply") fail();
        },
      };
      def.phases = {
        a: { onEnd: location === "phaseEnd" ? fail : undefined },
        b: { onBegin: location === "phaseBegin" ? fail : undefined },
      } as NonNullable<GameDefinition<State>["phases"]>;
      def.turn = {
        onEnd: location === "turnEnd" ? fail : undefined,
        next: location === "turnNext" ? fail : undefined,
        onBegin: location === "turnBegin" ? fail : undefined,
      } as NonNullable<GameDefinition<State>["turn"]>;
      if (location === "endIf") def.endIf = fail;
      const before = JSON.stringify(state);
      expect(applyIntent(def, state, "0", { move: "act" })).toEqual({
        ok: false,
        code: "GAME_ERROR",
        message: "Game execution failed",
      });
      expect(JSON.stringify(state)).toBe(before);
    },
  );

  test.each([
    0.5,
    undefined,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    new Map(),
    new Set(),
    new Date(),
    () => 1,
  ])("rejects non-integer or non-JSON state: %s", (value) => {
    const def = game({
      moves: {
        act: {
          apply(s) {
            Object.assign(s, { bad: value });
          },
        },
      },
    });
    expect(applyIntent(def, createMatch(def, init), "0", { move: "act" })).toMatchObject({
      ok: false,
      code: "GAME_ERROR",
    });
  });

  test("rejects cyclic and sparse state and move counter overflow", () => {
    for (const mutate of [
      (s: State) => Object.assign(s, { cycle: s }),
      (s: State) => Object.assign(s, { sparse: new Array(2) }),
    ]) {
      const def = game({
        moves: {
          act: {
            apply(s) {
              mutate(s);
            },
          },
        },
      });
      expect(applyIntent(def, createMatch(def, init), "0", { move: "act" })).toMatchObject({
        ok: false,
        code: "GAME_ERROR",
      });
    }
    const def = game();
    const state = createMatch(def, init);
    state.ctx.moveNumber = Number.MAX_SAFE_INTEGER;
    expect(applyIntent(def, state, "0", { move: "act" })).toMatchObject({
      ok: false,
      code: "GAME_ERROR",
    });
  });
});

describe("queued events, turns and phases", () => {
  test.each(Array.from({ length: 16 }, (_, mask) => mask))(
    "event combination %i follows phase, active, turn, result ordering",
    (mask) => {
      const phase = (mask & 1) !== 0;
      const active = (mask & 2) !== 0;
      const turn = (mask & 4) !== 0;
      const end = (mask & 8) !== 0;
      const def = game({
        phases: {
          a: {
            onEnd(s, ctx) {
              s.trace.push(`a:end:${ctx.currentSeat}`);
            },
          },
          b: {
            onBegin(s, ctx) {
              s.trace.push(`b:begin:${ctx.currentSeat}:${ctx.activeSeats.join()}`);
            },
          },
        },
        startPhase: "a",
        turn: {
          onEnd(s, ctx) {
            s.trace.push(`turn:end:${ctx.phase}:${ctx.activeSeats.join()}`);
          },
          onBegin(s, ctx) {
            s.trace.push(`turn:begin:${ctx.seat}:${ctx.turn}`);
          },
        },
        moves: {
          act: {
            apply(s, ctx) {
              s.trace = [];
              if (end) ctx.events.endGame({ winners: ["0"] });
              if (turn) ctx.events.endTurn();
              if (active) ctx.events.setActiveSeats(["0", "2"]);
              if (phase) ctx.events.setPhase("b");
              expect(ctx.phase).toBe("a"); // Events are deferred.
            },
          },
        },
      });
      const next = accepted(applyIntent(def, createMatch(def, init), "0", { move: "act" }));
      const trace: string[] = [];
      if (phase) trace.push("a:end:0", "b:begin:0:0");
      if (turn)
        trace.push(`turn:end:${phase ? "b" : "a"}:${active ? "0,2" : "0"}`, "turn:begin:1:2");
      expect(next.game.trace).toEqual(trace);
      expect(next.ctx).toMatchObject({
        phase: phase ? "b" : "a",
        activeSeats: turn ? ["1"] : active ? ["0", "2"] : ["0"],
        currentSeat: turn ? "1" : "0",
        turn: turn ? 2 : 1,
        moveNumber: 1,
      });
      expect(next.result).toEqual(end ? { winners: ["0"] } : null);
    },
  );

  test("explicit next seat overrides custom order and default wraps", () => {
    const def = game({
      turn: { next: () => "2" },
      moves: {
        act: {
          anySeat: true,
          apply(_s, ctx, args) {
            if (args === true) ctx.events.endTurn("1");
            else ctx.events.endTurn();
          },
        },
      },
    });
    const initial = createMatch(def, init);
    expect(accepted(applyIntent(def, initial, "0", { move: "act" })).ctx.currentSeat).toBe("2");
    expect(
      accepted(applyIntent(def, initial, "0", { move: "act", args: true })).ctx.currentSeat,
    ).toBe("1");
    delete def.turn;
    const last = accepted(
      applyIntent(def, { ...initial, ctx: { ...initial.ctx, currentSeat: "2" } }, "0", {
        move: "act",
      }),
    );
    expect(last.ctx.currentSeat).toBe("0");
  });

  test("endIf runs after events, sees previous moveNumber and does not override endGame", () => {
    let calls = 0;
    const def = game({
      endIf(_s, ctx) {
        calls += 1;
        expect(ctx.turn).toBe(2);
        expect(ctx.moveNumber).toBe(0);
        return { winners: ["1"], scores: { "1": 7 } };
      },
      moves: {
        act: {
          apply(_s, ctx, args) {
            ctx.events.endTurn();
            if (args === true) ctx.events.endGame({ winners: ["0"] });
          },
        },
      },
    });
    const state = createMatch(def, init);
    expect(accepted(applyIntent(def, state, "0", { move: "act" })).result?.winners).toEqual(["1"]);
    expect(
      accepted(applyIntent(def, state, "0", { move: "act", args: true })).result?.winners,
    ).toEqual(["0"]);
    expect(calls).toBe(1);
  });

  test("duplicate event types use the last call and hook events run in another ordered batch", () => {
    const def = game({
      phases: {
        a: {},
        b: {
          onBegin(_s, ctx) {
            ctx.events.setActiveSeats(["0", "2"]);
          },
        },
      },
      startPhase: "a",
      moves: {
        act: {
          apply(_s, ctx) {
            ctx.events.endTurn("1");
            ctx.events.endTurn("2");
            ctx.events.setPhase("a");
            ctx.events.setPhase("b");
            ctx.events.setActiveSeats([]);
            ctx.events.setActiveSeats(["1"]);
          },
        },
      },
    });
    const state = accepted(applyIntent(def, createMatch(def, init), "0", { move: "act" }));
    expect(state.ctx).toMatchObject({
      phase: "b",
      currentSeat: "2",
      turn: 2,
      activeSeats: ["0", "2"],
    });
    def.moves.act = {
      apply(_s, ctx) {
        ctx.events.endGame({ winners: ["0"] });
        ctx.events.endGame({ winners: ["2"] });
      },
    };
    expect(
      accepted(applyIntent(def, createMatch(def, init), "0", { move: "act" })).result?.winners,
    ).toEqual(["2"]);
  });

  test.each([
    (ctx: MoveContext) => ctx.events.setPhase("missing"),
    (ctx: MoveContext) => ctx.events.endTurn("99"),
    (ctx: MoveContext) => ctx.events.setActiveSeats(["99"]),
    (ctx: MoveContext) => ctx.events.setActiveSeats(["0", "0"]),
    (ctx: MoveContext) => ctx.events.endGame({ winners: ["99"] }),
    (ctx: MoveContext) => ctx.events.endGame({ winners: [], scores: { "99": 1 } }),
    (ctx: MoveContext) => ctx.events.endGame({ winners: [], scores: { "0": 0.5 } }),
  ])("rejects invalid event inputs without committing", (enqueue) => {
    const def = game({
      moves: {
        act: {
          apply(_s, ctx) {
            enqueue(ctx);
          },
        },
      },
    });
    expect(applyIntent(def, createMatch(def, init), "0", { move: "act" })).toMatchObject({
      ok: false,
      code: "GAME_ERROR",
    });
  });

  test("invalid turn order and hook cascades fail deterministically", () => {
    const def = game({
      turn: { next: () => "99" },
      moves: {
        act: {
          apply(_s, ctx) {
            ctx.events.endTurn();
          },
        },
      },
    });
    const state = createMatch(def, init);
    expect(applyIntent(def, state, "0", { move: "act" })).toMatchObject({
      ok: false,
      code: "GAME_ERROR",
    });
    def.turn = {
      onBegin(_s, ctx) {
        ctx.events.endTurn();
      },
    };
    expect(applyIntent(def, state, "0", { move: "act" })).toMatchObject({
      ok: false,
      code: "GAME_ERROR",
    });
    expect(() => createMatch(def, init)).toThrow("Game initialization failed");
  });
});

describe("views and alias isolation", () => {
  test("views contain only playerView, public context and result", () => {
    const def = game();
    const state = createMatch(def, init);
    expect(viewFor(def, state, "0").game).toMatchObject({ secret: "HIDDEN_FISH" });
    for (const seat of ["1", "2", null]) {
      const view = viewFor(def, state, seat);
      expect(view).toEqual({ ctx: state.ctx, game: { count: 0 }, result: null });
      expect(JSON.stringify(view)).not.toContain("HIDDEN_FISH");
      expect(view).not.toHaveProperty("rng");
    }
    expect(() => viewFor(def, state, "99")).toThrow("Game view failed");
  });

  test("game callbacks and returned views cannot mutate authoritative context or input objects", () => {
    const def = game({
      moves: {
        act: {
          parse(args) {
            if (args && typeof args === "object") Object.assign(args, { parsed: true });
            return args ?? null;
          },
          apply(s, ctx) {
            ctx.seats.reverse();
            ctx.activeSeats.push("2");
            if (ctx.options && typeof ctx.options === "object")
              Object.assign(ctx.options, { bad: true });
            s.count += 1;
          },
        },
      },
      playerView(s, ctx) {
        s.count = 99;
        ctx.seats.reverse();
        return s;
      },
    });
    const state = createMatch(def, init);
    const intent = { move: "act", args: { value: 1 } };
    const next = accepted(applyIntent(def, state, "0", intent));
    expect(next.ctx).toEqual({ ...state.ctx, moveNumber: 1 });
    expect(intent.args).toEqual({ value: 1 });
    const view = viewFor(def, next, "0");
    view.ctx.seats.reverse();
    expect(next.game.count).toBe(1);
    expect(next.ctx.seats).toEqual(["0", "1", "2"]);
  });

  test("invalid or throwing playerView does not expose exception text", () => {
    const state = createMatch(game(), init);
    expect(() => viewFor(game({ playerView: () => 0.5 }), state, "0")).toThrow("Game view failed");
    expect(() =>
      viewFor(
        game({
          playerView: () => {
            throw new Error("HIDDEN_FISH");
          },
        }),
        state,
        null,
      ),
    ).toThrow("Game view failed");
  });
});

describe("tic-tac-toe and replay", () => {
  const boardInit = { seats: ["0", "1"], seed: 42, options: {} };
  test.each([
    { cells: [0, 3, 1, 4, 2], winners: ["0"] },
    { cells: [0, 1, 2, 4, 3, 7], winners: ["1"] },
    { cells: [0, 1, 2, 4, 3, 5, 7, 6, 8], winners: [] },
  ])("plays to completion and reproduces every hash: $cells", async ({ cells, winners }) => {
    let state = createMatch(ticTacToe, boardInit);
    const events: AcceptedEvent[] = [];
    for (const cell of cells) {
      const result = applyIntent(ticTacToe, state, state.ctx.currentSeat, {
        move: "place",
        args: cell,
      });
      if (!result.ok) throw new Error(result.code);
      events.push(result.event);
      state = result.state;
      expect(await hashState(replay(ticTacToe, boardInit, events))).toBe(await hashState(state));
    }
    expect(state.result?.winners).toEqual(winners);
    expect(
      applyIntent(ticTacToe, state, state.ctx.currentSeat, { move: "place", args: 0 }),
    ).toMatchObject({ ok: false, code: "MATCH_FINISHED" });
    expect(await hashState(replay(ticTacToe, boardInit, events))).toBe(
      await hashState(replay(ticTacToe, boardInit, events)),
    );
  });

  test("illegal cells are rejected, and replay rejects gaps, duplicates and illegal moves", () => {
    const initial = createMatch(ticTacToe, boardInit);
    expect(applyIntent(ticTacToe, initial, "0", { move: "place", args: 9 })).toMatchObject({
      ok: false,
      code: "INVALID_ARGS",
      gameCode: "BAD_CELL",
    });
    const state = accepted(applyIntent(ticTacToe, initial, "0", { move: "place", args: 0 }));
    expect(applyIntent(ticTacToe, state, "1", { move: "place", args: 0 })).toMatchObject({
      ok: false,
      code: "INVALID_MOVE",
      gameCode: "OCCUPIED",
    });
    const event = { seq: 1, seat: "0", intent: { move: "place", args: 0 } };
    expect(replay(ticTacToe, boardInit, [])).toEqual(initial);
    expect(() => replay(ticTacToe, boardInit, [{ ...event, seq: 2 }])).toThrow(
      "Invalid replay sequence",
    );
    expect(() => replay(ticTacToe, boardInit, [event, event])).toThrow("Invalid replay sequence");
    expect(() => replay(ticTacToe, boardInit, [{ ...event, seat: "1" }])).toThrow(
      "Replay event rejected: NOT_YOUR_TURN",
    );
  });
});
