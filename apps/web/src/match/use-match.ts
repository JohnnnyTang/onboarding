import type { SeatId } from "@bgp/schema";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ApiClient } from "../api/client";
import type { AuthService } from "../auth/auth";
import type { ClaimedSeats } from "../auth/claimed-seats";
import { type GamePackage, loadGamePackage } from "./game-package";
import { bootGameWorker } from "./game-worker-client";
import { createRoomClient, type RoomAuth, type RoomClient, type RoomState } from "./room-client";
import { createTablePresenter, type TablePresenter, type TableState } from "./table-presenter";

/** Credentials for a match: the guest token claimed in this tab, else the designer's token. */
export function roomAuth(matchId: string, seats: ClaimedSeats, auth: AuthService): RoomAuth | null {
  const guestToken = seats.get(matchId)?.guestToken;
  if (guestToken) return { kind: "guest", token: guestToken };
  const token = auth.accessToken();
  return token ? { kind: "user", token } : null;
}

/** One room connection per match and identity, closed when the page leaves. */
export function useRoom(
  url: string,
  matchId: string,
  identity: string | undefined,
  credentials: () => RoomAuth | null,
): { client: RoomClient | null; state: RoomState | null } {
  const [client, setClient] = useState<RoomClient | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect only for a new identity
  useEffect(() => {
    if (identity === undefined) return;
    const room = createRoomClient({ url, matchId, auth: credentials });
    setClient(room);
    room.connect();
    return () => {
      room.close();
      setClient(null);
    };
  }, [url, matchId, identity]);
  const store = useMemo(
    () =>
      client
        ? { subscribe: client.subscribe, get: client.getState }
        : { subscribe: () => () => {}, get: () => null },
    [client],
  );
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  return { client, state };
}

export type GameStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; pkg: GamePackage; presenter: TablePresenter }
  | { kind: "error"; error: unknown };

/**
 * Loads the version and starts its game worker once the room says which version and seat
 * this is. Both are released when the page leaves or the version changes.
 */
export function useGame(
  api: ApiClient,
  matchId: string,
  versionId: string | undefined,
  seat: SeatId | null | undefined,
): GameStatus {
  const [status, setStatus] = useState<GameStatus>({ kind: "idle" });
  useEffect(() => {
    if (versionId === undefined || seat === undefined) return;
    let cancelled = false;
    setStatus({ kind: "loading" });
    // Download the version while the worker boots; neither depends on the other.
    const booting = bootGameWorker();
    const loading = loadGamePackage(api, versionId, matchId);
    const release = () => {
      void booting.then(
        (booted) => booted.destroy(),
        () => {},
      );
      void loading.then(
        (pkg) => pkg.dispose(),
        () => {},
      );
    };
    (async () => {
      const [booted, pkg] = await Promise.all([booting, loading]);
      if (cancelled) return;
      const worker = await booted.load(pkg.game, pkg.components);
      if (cancelled) return;
      setStatus({ kind: "ready", pkg, presenter: createTablePresenter(worker, seat) });
    })().catch((error: unknown) => {
      release();
      if (!cancelled) setStatus({ kind: "error", error });
    });
    return () => {
      cancelled = true;
      release();
    };
  }, [api, matchId, versionId, seat]);
  return status;
}

const EMPTY_TABLE: TableState = { snapshot: null, actions: [], selection: [], error: null };

export function useTable(presenter: TablePresenter | null): TableState {
  const store = useMemo(
    () =>
      presenter
        ? { subscribe: presenter.subscribe, get: presenter.getState }
        : { subscribe: () => () => {}, get: () => EMPTY_TABLE },
    [presenter],
  );
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
