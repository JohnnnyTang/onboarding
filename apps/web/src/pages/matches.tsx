import type { MatchStatus, MatchSummary } from "@bgp/schema";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useAuthUser, useServices } from "../app/services";
import { EmptyState, ErrorNotice, Loading, PageHeader, RequireUser, ui } from "../components/ui";

export const STATUS_LABELS: Record<MatchStatus, string> = {
  lobby: "In the lobby",
  active: "In progress",
  finished: "Finished",
  abandoned: "Abandoned",
};

/** Where a match lives in the app for its current status. */
export function matchPath(match: Pick<MatchSummary, "id" | "status">): string {
  const base = `/matches/${encodeURIComponent(match.id)}`;
  if (match.status === "active") return base;
  if (match.status === "finished") return `${base}/replay`;
  return `${base}/lobby`;
}

export function MatchList({ matches }: { matches: readonly MatchSummary[] }) {
  if (matches.length === 0) {
    return (
      <EmptyState title="No matches yet">
        <p>Matches you create from a ready game version, or join by invite, appear here.</p>
      </EmptyState>
    );
  }
  return (
    <ul className={ui.list} aria-label="Matches">
      {matches.map((match) => {
        const filled = match.seats.filter((seat) => seat.name !== "").length;
        return (
          <li key={match.id}>
            <Link to={matchPath(match)}>Match {match.id.slice(-8)}</Link>
            <span className={ui.muted}>
              {filled} of {match.seats.length} seats filled
            </span>
            <span className={ui.badge}>{STATUS_LABELS[match.status]}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Matches() {
  const { api } = useServices();
  const user = useAuthUser();
  const matches = useQuery({
    queryKey: ["matches", user?.subject],
    queryFn: () => api.listMatches(),
  });
  if (matches.isPending) return <Loading />;
  if (matches.isError)
    return <ErrorNotice error={matches.error} onRetry={() => void matches.refetch()} />;
  return <MatchList matches={matches.data.items} />;
}

export function MatchesPage() {
  return (
    <>
      <PageHeader title="Matches">Matches you host or play in.</PageHeader>
      <RequireUser what="matches">
        <Matches />
      </RequireUser>
    </>
  );
}
