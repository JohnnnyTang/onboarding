import type { ApiClient } from "../api/client";

const unused = () => Promise.reject(new Error("not expected in this test"));

/** An API client whose every call fails, with the given methods replaced. Tests only. */
export function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    listGames: unused,
    getGame: unused,
    listMatches: unused,
    getMatch: unused,
    getReplay: unused,
    claimInvite: unused,
    getVersion: unused,
    getVersionFile: unused,
    createGame: unused,
    updateGame: unused,
    createVersion: unused,
    uploadVersionFile: unused,
    finalizeVersion: unused,
    createMatch: unused,
    startMatch: unused,
    abandonMatch: unused,
    ...overrides,
  };
}
