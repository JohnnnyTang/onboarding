/** The invite links of a match this tab created, one per seat. */
export interface MatchInvites {
  matchId: string;
  invites: { seat: string; url: string }[];
}

/**
 * Invite links are returned once, when the match is created; the server keeps only their
 * hashes. The host's tab keeps them in session storage so a reload in that tab still shows
 * them (Q-025), as guest seats are kept (Q-018). Nothing here reaches the game worker.
 */
export interface InviteStore {
  get(matchId: string): MatchInvites | undefined;
  set(entry: MatchInvites): void;
}

export type InviteStorage = Pick<Storage, "getItem" | "setItem">;

export const MATCH_INVITES_KEY = "bgp.matchInvites";
/** Older entries are dropped first. */
export const MAX_STORED_INVITES = 20;

function isEntry(value: unknown): value is MatchInvites {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.matchId === "string" &&
    Array.isArray(entry.invites) &&
    entry.invites.every(
      (invite: unknown) =>
        typeof invite === "object" &&
        invite !== null &&
        typeof (invite as Record<string, unknown>).seat === "string" &&
        typeof (invite as Record<string, unknown>).url === "string",
    )
  );
}

function copy(entry: MatchInvites): MatchInvites {
  return {
    matchId: entry.matchId,
    invites: entry.invites.map((invite) => ({ seat: invite.seat, url: invite.url })),
  };
}

export function createInviteStore(storage: InviteStorage | null = null): InviteStore {
  const entries = new Map<string, MatchInvites>();
  if (storage) {
    try {
      const parsed: unknown = JSON.parse(storage.getItem(MATCH_INVITES_KEY) ?? "[]");
      if (Array.isArray(parsed)) {
        for (const entry of parsed.filter(isEntry)) entries.set(entry.matchId, copy(entry));
      }
    } catch {
      // Unreadable: start empty.
    }
  }
  const save = () => {
    if (!storage) return;
    try {
      storage.setItem(MATCH_INVITES_KEY, JSON.stringify([...entries.values()]));
    } catch {
      // Storage full or blocked: the links still show until the next reload.
    }
  };
  return {
    get: (matchId) => {
      const entry = entries.get(matchId);
      return entry ? copy(entry) : undefined;
    },
    set: (entry) => {
      entries.delete(entry.matchId);
      entries.set(entry.matchId, copy(entry));
      while (entries.size > MAX_STORED_INVITES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      save();
    },
  };
}

/** The invite token at the end of a `/join/<token>` link, or null. */
export function inviteToken(url: string): string | null {
  try {
    const match = /^\/join\/([A-Za-z0-9_-]+)$/.exec(new URL(url).pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
