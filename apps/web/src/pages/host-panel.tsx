import type { Manifest, MatchSummary } from "@bgp/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "../api/client";
import { errorMessage, seatLabel } from "../app/messages";
import { type Services, useAuthUser, useServices } from "../app/services";
import { ui } from "../components/ui";
import { inviteToken } from "../match/match-invites";

/**
 * Whether the signed-in designer owns the match's game, and the version's manifest. Only the
 * owner may read the game (contracts/http-api.md), so a 403 means "not the host"; no
 * contract change is needed to tell hosts from players.
 */
export function useHostInfo(match: MatchSummary | undefined) {
  const { api } = useServices();
  const user = useAuthUser();
  return useQuery({
    queryKey: ["host", user?.subject, match?.versionId],
    enabled: user !== null && match !== undefined,
    queryFn: async (): Promise<{ host: boolean; manifest: Manifest } | null> => {
      if (!match) return null;
      const version = await api.getVersion(match.versionId);
      try {
        await api.getGame(version.gameId);
        return { host: true, manifest: version.manifest };
      } catch (error) {
        if (error instanceof ApiError && error.code === "FORBIDDEN") {
          return { host: false, manifest: version.manifest };
        }
        throw error;
      }
    },
  });
}

/** Start needs the first `players.min` seats claimed: rules seats are numbered without gaps. */
export function canStart(match: MatchSummary, minPlayers: number): boolean {
  return (
    match.status === "lobby" &&
    match.seats.slice(0, minPlayers).length === minPlayers &&
    match.seats.slice(0, minPlayers).every((seat) => seat.name !== "")
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`${ui.button} ${ui.secondary}`}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function useTakeSeat(services: Services, matchId: string, name: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ seat, token }: { seat: string; token: string }) => {
      const claimed = await services.api.claimInvite(token, { displayName: name });
      return { claimed, seat };
    },
    onSuccess: ({ claimed }) => {
      // A signed-in host plays with their own account: no guest token (http-api.md).
      services.seats.set({
        matchId: claimed.matchId,
        seat: claimed.seat,
        displayName: name,
        guestToken: claimed.guestToken ?? null,
      });
      void queryClient.invalidateQueries({ queryKey: ["match", matchId] });
    },
  });
}

/** The host's controls in the lobby: invite links, taking a seat, start and end (T17). */
export function HostPanel({ match, manifest }: { match: MatchSummary; manifest: Manifest }) {
  const services = useServices();
  const user = useAuthUser();
  const queryClient = useQueryClient();
  const name = (user?.name ?? "Host").slice(0, 80);
  const links = services.invites.get(match.id);
  const seated = services.seats.get(match.id);
  const take = useTakeSeat(services, match.id, name);
  const refresh = (next: MatchSummary) => {
    queryClient.setQueriesData({ queryKey: ["match", match.id] }, next);
    void queryClient.invalidateQueries({ queryKey: ["match", match.id] });
  };
  const start = useMutation({
    mutationFn: () => services.api.startMatch(match.id),
    onSuccess: refresh,
  });
  const abandon = useMutation({
    mutationFn: () => services.api.abandonMatch(match.id),
    onSuccess: refresh,
  });
  const min = manifest.players.min;
  const ready = canStart(match, min);
  const failure = take.error ?? start.error ?? abandon.error;

  if (match.status !== "lobby") return null;
  return (
    <section aria-label="Host controls">
      <h2>Invite players</h2>
      {links ? (
        <p className={ui.muted}>
          Send each player the link for one seat. Each link works once.
          {seated ? null : " Take a seat yourself to play."}
        </p>
      ) : (
        <p className={ui.notice}>
          Invite links are shown only in the tab that created the match. Create a new match to get
          new links.
        </p>
      )}
      <ul className={ui.list} aria-label="Invites">
        {match.seats.map((seat) => {
          const url = links?.invites.find((invite) => invite.seat === seat.seat)?.url;
          const token = url ? inviteToken(url) : null;
          const label = seatLabel(seat.seat);
          return (
            <li key={seat.seat} aria-label={`Invite for ${label}`}>
              <strong>{label}</strong>
              {seat.name !== "" ? (
                <span>Taken by {seat.name}</span>
              ) : url ? (
                <span className={ui.copyRow}>
                  <code data-testid={`invite-${seat.seat}`}>{url}</code>
                  <CopyButton text={url} label={`Copy invite for ${label}`} />
                  {!seated && token ? (
                    <button
                      type="button"
                      className={`${ui.button} ${ui.secondary}`}
                      disabled={take.isPending}
                      onClick={() => take.mutate({ seat: seat.seat, token })}
                    >
                      Take this seat
                    </button>
                  ) : null}
                </span>
              ) : (
                <span className={ui.muted}>Open</span>
              )}
            </li>
          );
        })}
      </ul>
      <div className={ui.actions}>
        <button
          type="button"
          className={ui.button}
          disabled={!ready || start.isPending}
          onClick={() => start.mutate()}
        >
          {start.isPending ? "Starting…" : "Start match"}
        </button>
        <button
          type="button"
          className={`${ui.button} ${ui.secondary}`}
          disabled={abandon.isPending}
          onClick={() => abandon.mutate()}
        >
          End match
        </button>
      </div>
      {ready ? null : (
        <p className={ui.muted}>
          {min === 1
            ? "Start when Seat 1 is taken."
            : `Start when Seats 1 to ${min} are taken; open seats after them are removed.`}
        </p>
      )}
      {failure ? (
        <p className={ui.notice} role="alert">
          {errorMessage(failure)}
        </p>
      ) : null}
    </section>
  );
}
