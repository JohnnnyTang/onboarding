import { Link } from "react-router";
import { EmptyState, PageHeader } from "../components/ui";

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
