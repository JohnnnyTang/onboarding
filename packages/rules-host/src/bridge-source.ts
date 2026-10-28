// Trusted code evaluated before the game. The returned factory and dispatcher are held
// by private interpreter handles, never on globalThis where the game could invoke them.
export const BRIDGE_SOURCE = `
(() => {
  const R = BGP_RUNTIME;
  delete globalThis.BGP_RUNTIME;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  return (def) => {
    let state;
    return (raw) => {
      const request = parse(raw);
      let value = null;
      switch (request.op) {
        case "create": state = R.createMatch(def, request.init); break;
        case "apply": {
          const result = R.applyIntent(def, state, request.seat, request.intent);
          if (result.ok) {
            state = result.state;
            value = { ok: true, event: result.event };
          } else value = result;
          break;
        }
        case "views": {
          value = {};
          for (const seat of state.ctx.seats) value[seat] = R.viewFor(def, state, seat);
          break;
        }
        case "canonical": value = R.canonicalJson(state); break;
        case "export": value = state; break;
        case "restore": {
          let restored = request.snapshot;
          for (const event of request.events) {
            if (event.seq !== restored.ctx.moveNumber + 1) throw Error();
            const result = R.applyIntent(def, restored, event.seat, event.intent);
            if (!result.ok) throw Error();
            restored = result.state;
          }
          state = restored;
          break;
        }
        default: throw Error();
      }
      return stringify(value);
    };
  };
})()
`;

// QuickJS has no I/O by default. Remove nondeterministic capabilities and the
// global constructor path as well. Function constructors still stay in QuickJS;
// unlike node:vm they cannot reach any Node object or host function.
export const LOCKDOWN_SOURCE = `
(() => {
  for (const key of [
    "Date", "performance", "crypto", "fetch", "XMLHttpRequest", "WebSocket",
    "EventSource", "process", "require", "console", "setTimeout", "setInterval",
    "setImmediate", "queueMicrotask", "SharedArrayBuffer", "Atomics", "WebAssembly",
    "Worker", "WeakRef", "FinalizationRegistry"
  ]) Object.defineProperty(globalThis, key, { get() { throw Error(); }, configurable: false });
  Object.defineProperty(Math, "random", { get() { throw Error(); }, configurable: false });
  Object.defineProperty(globalThis, "constructor", { get() { throw Error(); }, configurable: false });
})()
`;
