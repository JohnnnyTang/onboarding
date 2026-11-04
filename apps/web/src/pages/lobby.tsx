import type { MatchSummary, SeatInfo } from "@bgp/schema";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { seatLabel } from "../app/messages";
import { useAuthUser, useServices } from "../app/services";
import { EmptyState, ErrorNotice, Loading, PageHeader, SignInButton, ui } from "../components/ui";
import { matchPath, STATUS_LABELS } from "./matches";

/** The lobby refreshes over HTTP while it waits; the table connects to the room server. */
export const LOBBY_REFRESH_MS = 3000;

export function SeatList({
  seats,
  mySeat,
}: {
  seats: readonly SeatInfo[];
  mySeat: string | undefined;
}) {
  return (
    <ul className={ui.list} aria-label="Seats">
      {seats.map((seat) => (
        <li key={seat.seat}>
          <span>
            <strong>{seatLabel(seat.seat)}</strong>{" "}
            {seat.name === "" ? <span className={ui.muted}>Open</span> : seat.name}
            {seat.seat === mySeat ? " (you)" : null}
          </span>
          {seat.guest ? <span className={ui.badge}>Guest</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function LobbyStatus({ match }: { match: MatchSummary }) {
  switch (match.status) {
    case "lobby":
      return <p>Waiting for the host to start the match.</p>;
    case "active":
      return (
        <p>
          The match has started. <Link to={matchPath(match)}>Go to the table</Link>
        </p>
      );
    case "finished":
      return (
        <p>
          The match has finished. <Link to={matchPath(match)}>Watch the replay</Link>
        </p>
      );
    case "abandoned":
      return <p>The host ended this match.</p>;
  }
}

export function LobbyPage() {
  const { matchId = "" } = useParams();
  const { api, seats } = useServices();
  const user = useAuthUser();
  const claimed = seats.get(matchId);
  const identity = claimed?.guestToken ? `guest:${claimed.seat}` : user?.subject;
  const match = useQuery({
    queryKey: ["match", matchId, identity],
    queryFn: () => api.getMatch(matchId),
    enabled: identity !== undefined,
    refetchInterval: (query) => (query.state.data?.status === "lobby" ? LOBBY_REFRESH_MS : false),
  });
  const navigate = useNavigate();
  const started = match.data?.status === "active";
  const seated = claimed !== undefined;
  // A seated player goes to the table as soon as the host starts the match.
  useEffect(() => {
    if (started && seated)
      void navigate(matchPath({ id: matchId, status: "active" }), { replace: true });
  }, [started, seated, matchId, navigate]);

  if (identity === undefined) {
    return (
      <>
        <PageHeader title="Lobby" />
        <EmptyState title="You are not seated in this match">
          <p>Open your invite link to take a seat. Hosts sign in to see their matches.</p>
          <SignInButton />
        </EmptyState>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Lobby">
        {claimed ? `You are in ${seatLabel(claimed.seat)} as ${claimed.displayName}.` : null}
      </PageHeader>
      {match.isPending ? <Loading /> : null}
      {match.isError ? <ErrorNotice error={match.error} /> : null}
      {match.data ? (
        <>
          <p>
            <span className={ui.badge}>{STATUS_LABELS[match.data.status]}</span>
          </p>
          <LobbyStatus match={match.data} />
          <SeatList seats={match.data.seats} mySeat={claimed?.seat} />
        </>
      ) : null}
    </>
  );
}
