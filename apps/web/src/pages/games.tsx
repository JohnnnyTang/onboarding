import type { GameDetailResponse, GameResponse } from "@bgp/schema";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { useAuthUser, useServices } from "../app/services";
import { EmptyState, ErrorNotice, Loading, PageHeader, RequireUser, ui } from "../components/ui";
import { versionPath } from "./version";

export function GameList({ games }: { games: readonly GameResponse[] }) {
  if (games.length === 0) {
    return (
      <EmptyState title="No games yet">
        <p>
          Publish a project, or run <code>bgp publish</code> in a game package, to add one.
        </p>
      </EmptyState>
    );
  }
  return (
    <ul className={ui.list} aria-label="Games">
      {games.map((game) => (
        <li key={game.id}>
          <Link to={`/games/${encodeURIComponent(game.id)}`}>{game.name}</Link>
          <span className={ui.badge}>{game.visibility}</span>
        </li>
      ))}
    </ul>
  );
}

function Games() {
  const { api } = useServices();
  const user = useAuthUser();
  const games = useQuery({
    queryKey: ["games", user?.subject],
    queryFn: () => api.listGames(),
  });
  if (games.isPending) return <Loading />;
  if (games.isError)
    return <ErrorNotice error={games.error} onRetry={() => void games.refetch()} />;
  return <GameList games={games.data.items} />;
}

export function GamesPage() {
  return (
    <>
      <PageHeader title="Games">Games you have published.</PageHeader>
      <RequireUser what="games">
        <Games />
      </RequireUser>
    </>
  );
}

export function VersionList({
  gameId,
  versions,
}: {
  gameId: string;
  versions: GameDetailResponse["versions"];
}) {
  if (versions.length === 0) {
    return (
      <EmptyState title="No versions yet">
        <p>Publishing uploads a version; matches are hosted from ready versions.</p>
      </EmptyState>
    );
  }
  return (
    <ul className={ui.list} aria-label="Versions">
      {versions.map((version) => (
        <li key={version.id}>
          <span>
            <Link to={versionPath(gameId, version.id)}>{version.manifest.version}</Link>{" "}
            <span className={ui.muted}>({version.manifest.mode})</span>
          </span>
          {version.buildHash ? (
            <code className={ui.muted} title={version.buildHash}>
              {version.buildHash.slice(0, 12)}
            </code>
          ) : null}
          <span className={ui.badge}>{version.status}</span>
        </li>
      ))}
    </ul>
  );
}

function Game({ gameId }: { gameId: string }) {
  const { api } = useServices();
  const user = useAuthUser();
  const game = useQuery({
    queryKey: ["game", user?.subject, gameId],
    queryFn: () => api.getGame(gameId),
  });
  if (game.isPending) return <Loading />;
  if (game.isError) return <ErrorNotice error={game.error} onRetry={() => void game.refetch()} />;
  return (
    <>
      <PageHeader title={game.data.name}>
        <code>{game.data.slug}</code> · {game.data.visibility}
      </PageHeader>
      <h2>Versions</h2>
      <p className={ui.muted}>Open a ready version to create a match.</p>
      <VersionList gameId={game.data.id} versions={game.data.versions} />
    </>
  );
}

export function GamePage() {
  const { gameId = "" } = useParams();
  return (
    <RequireUser what="games">
      <Game gameId={gameId} />
    </RequireUser>
  );
}
