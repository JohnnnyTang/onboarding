import type { ActionButton, Gesture } from "@bgp/schema";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { errorMessage, seatLabel } from "../app/messages";
import { useAuthUser, useServices } from "../app/services";
import { EmptyState, Loading, PageHeader, SignInButton, ui } from "../components/ui";
import { GamePackageError } from "../match/game-package";
import { GameWorkerError } from "../match/game-worker-client";
import styles from "../match/match.module.css";
import {
  ActionBar,
  ChatPanel,
  ConnectionBanner,
  Hud,
  RejectedNotice,
  ResultPanel,
  roomErrorMessage,
} from "../match/match-panels";
import { preloadTable, TableView } from "../match/table-view";
import { roomAuth, useGame, useRoom, useTable } from "../match/use-match";

/** Game failures carry no details by design; request failures use the shared messages. */
export function gameErrorMessage(error: unknown): string {
  if (error instanceof GamePackageError || error instanceof GameWorkerError) return error.message;
  return errorMessage(error);
}

function lobbyPath(matchId: string) {
  return `/matches/${encodeURIComponent(matchId)}/lobby`;
}

/** `/matches/:matchId`: the live table for the seat claimed in this tab or by the designer. */
export function MatchPage() {
  const { matchId = "" } = useParams();
  const { api, auth, seats, roomUrl } = useServices();
  const user = useAuthUser();
  const claimed = seats.get(matchId);
  const identity = claimed?.guestToken ? `guest:${claimed.seat}` : user?.subject;
  const credentials = useCallback(() => roomAuth(matchId, seats, auth), [matchId, seats, auth]);
  const { client, state: room } = useRoom(roomUrl, matchId, identity, credentials);
  const game = useGame(
    api,
    matchId,
    room?.match?.versionId,
    // The seat is known once the welcome has arrived with the first view.
    room?.view ? room.seat : undefined,
  );
  const presenter = game.kind === "ready" ? game.presenter : null;
  const table = useTable(presenter);
  const [dismissed, setDismissed] = useState(0);
  const [dismissedError, setDismissedError] = useState(0);
  // The renderer is only needed once the game is ready; fetch it meanwhile.
  useEffect(() => {
    void preloadTable().catch(() => {});
  }, []);

  const view = room?.view ?? null;
  useEffect(() => {
    if (presenter && view) presenter.setView(view);
  }, [presenter, view]);

  const send = useCallback(
    (intent: ActionButton["intent"]) => {
      if (!client || !intent) return;
      if (client.move(intent)) {
        setDismissed(client.getState().rejected?.id ?? 0);
        presenter?.setSelection([]);
      }
    },
    [client, presenter],
  );
  const onGesture = useCallback(
    (gesture: Gesture) => {
      void presenter?.interpret(gesture).then((intent) => {
        if (intent) send(intent);
      });
    },
    [presenter, send],
  );
  const onSelectionChange = useCallback(
    (ids: string[]) => presenter?.setSelection(ids),
    [presenter],
  );

  if (identity === undefined) {
    return (
      <>
        <PageHeader title="Match" />
        <EmptyState title="You are not seated in this match">
          <p>Open your invite link to take a seat. Designers sign in to return to their seat.</p>
          <SignInButton />
        </EmptyState>
      </>
    );
  }

  if (room?.status === "closed" && room.error) {
    const notActive = room.error.code === "MATCH_NOT_ACTIVE";
    return (
      <>
        <PageHeader title="Match" />
        <EmptyState title={roomErrorMessage(room.error)}>
          <p>
            {notActive ? (
              <Link to={lobbyPath(matchId)}>Go to the lobby</Link>
            ) : room.error.code === "UNAUTHORIZED" ? (
              <SignInButton />
            ) : (
              <Link to="/matches">Back to matches</Link>
            )}
          </p>
        </EmptyState>
      </>
    );
  }

  const seatsInfo = room?.match?.seats ?? [];
  const mySeat = room?.seat ?? null;
  const result = room?.result ?? view?.result ?? null;
  const rejection = room?.rejected && room.rejected.id > dismissed ? room.rejected : null;
  // Non-fatal errors (a dropped action) are shown like a rejection until dismissed.
  const notice =
    room?.error && !room.error.fatal && room.error.id > dismissedError ? room.error : null;
  const gameError = game.kind === "error" ? game.error : table.error;
  const title = game.kind === "ready" ? game.pkg.manifest.name : "Match";

  return (
    <>
      <PageHeader title={title}>
        {mySeat === null ? null : `You are playing ${seatLabel(mySeat)}.`}
      </PageHeader>
      <ConnectionBanner status={room?.status ?? "connecting"} />
      {gameError ? (
        <p className={ui.notice} role="alert">
          {gameErrorMessage(gameError)}
        </p>
      ) : null}
      <div className={styles.layout}>
        <div>
          {game.kind === "ready" ? (
            <TableView
              components={game.pkg.components}
              assetUrl={game.pkg.assetUrl}
              seat={mySeat}
              snapshot={table.snapshot}
              selection={table.selection}
              onGesture={onGesture}
              onSelectionChange={onSelectionChange}
            />
          ) : (
            <Loading label="Setting up the table…" />
          )}
        </div>
        <aside className={styles.side} aria-label="Match">
          {result ? <ResultPanel result={result} seats={seatsInfo} mySeat={mySeat} /> : null}
          {result ? (
            <p>
              <Link to={`/matches/${encodeURIComponent(matchId)}/replay`}>Watch the replay</Link>
            </p>
          ) : null}
          {table.snapshot?.prompt ? (
            <p className={styles.prompt} aria-live="polite" data-testid="prompt">
              {table.snapshot.prompt}
            </p>
          ) : null}
          {view ? (
            <p className={ui.muted} data-testid="move-count">
              {view.ctx.moveNumber} {view.ctx.moveNumber === 1 ? "move" : "moves"} so far
            </p>
          ) : null}
          <RejectedNotice
            rejection={rejection}
            onDismiss={() => setDismissed(rejection?.id ?? dismissed)}
          />
          <RejectedNotice
            rejection={
              notice
                ? { id: notice.id, code: notice.code, message: roomErrorMessage(notice) }
                : null
            }
            onDismiss={() => setDismissedError(notice?.id ?? dismissedError)}
          />
          <ActionBar
            actions={result ? [] : table.actions}
            disabled={room?.status !== "open" || room.movePending}
            onAction={(action) => send(action.intent)}
          />
          <Hud entries={table.snapshot?.hud ?? []} seats={seatsInfo} mySeat={mySeat} />
          <ChatPanel
            entries={room?.chat ?? []}
            canSend={room?.status === "open"}
            onSend={(text) => client?.chat(text) ?? false}
          />
        </aside>
      </div>
    </>
  );
}
