import { Link, useParams } from "react-router";
import { EmptyState, PageHeader } from "../components/ui";

/** `/matches/:matchId`: the table, HUD and room connection arrive with T14. */
export function MatchPage() {
  const { matchId = "" } = useParams();
  return (
    <>
      <PageHeader title="Match" />
      <EmptyState title="The table is not available yet">
        <p>
          <Link to={`/matches/${encodeURIComponent(matchId)}/lobby`}>Back to the lobby</Link>
        </p>
      </EmptyState>
    </>
  );
}

/** `/matches/:matchId/replay`: the replay viewer arrives with T18. */
export function ReplayPage() {
  return (
    <>
      <PageHeader title="Replay" />
      <EmptyState title="Replays are not available yet">
        <p>
          <Link to="/matches">Back to matches</Link>
        </p>
      </EmptyState>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" />
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </>
  );
}
