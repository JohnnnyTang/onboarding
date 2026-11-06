import type { ActionButton, GameResult, HudEntry, SeatId, SeatInfo } from "@bgp/schema";
import { type FormEvent, useState } from "react";
import { seatLabel } from "../app/messages";
import { ui } from "../components/ui";
import styles from "./match.module.css";
import type { ChatEntry, Rejection, RoomError, RoomStatus } from "./room-client";

/** "Seat 2 · Tess", or just the seat when nobody has a name. */
export function playerName(seat: SeatId, seats: readonly SeatInfo[]): string {
  const name = seats.find((info) => info.seat === seat)?.name ?? "";
  return name === "" ? seatLabel(seat) : `${seatLabel(seat)} · ${name}`;
}

export function roomErrorMessage(error: RoomError): string {
  switch (error.code) {
    case "SEAT_TAKEN_OVER":
      return "This seat was opened in another tab or on another device.";
    case "MATCH_NOT_ACTIVE":
      return "This match is not running.";
    case "MATCH_NOT_FOUND":
      return "This match could not be found.";
    case "UNAUTHORIZED":
      return "Your seat could not be confirmed. Open your invite link again, or sign in.";
    case "FORBIDDEN":
      return "You are not seated in this match.";
    case "PROTOCOL_VERSION":
      return "This page is out of date. Reload it to continue.";
    default:
      return error.message;
  }
}

export function ConnectionBanner({ status }: { status: RoomStatus }) {
  if (status === "open" || status === "closed") return null;
  return (
    <p className={styles.banner} role="status">
      {status === "connecting" ? "Connecting to the table…" : "Connection lost. Reconnecting…"}
    </p>
  );
}

export function Hud({
  entries,
  seats,
  mySeat,
}: {
  entries: readonly HudEntry[];
  seats: readonly SeatInfo[];
  mySeat: SeatId | null;
}) {
  if (entries.length === 0) return null;
  return (
    <ul className={styles.hud} aria-label="Players">
      {entries.map((entry) => {
        const info = seats.find((seat) => seat.seat === entry.seat);
        return (
          <li key={entry.seat} className={entry.active ? styles.active : undefined}>
            <span>
              <strong>{playerName(entry.seat, seats)}</strong>
              {entry.seat === mySeat ? " (you)" : null}
              {entry.active ? <span className={styles.turn}> · to play</span> : null}
              {info && !info.connected ? <span className={ui.muted}> · away</span> : null}
            </span>
            <span className={styles.stats}>
              {entry.score === undefined ? null : <span>Score {entry.score}</span>}
              {entry.handCount === undefined ? null : <span>Hand {entry.handCount}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The question an action asks before it is sent, with its confirm and cancel buttons. */
export function ConfirmAction({
  action,
  disabled,
  onConfirm,
  onCancel,
}: {
  action: ActionButton;
  disabled: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <div className={styles.confirm} role="alertdialog" aria-label={action.label}>
      <p>{action.confirm}</p>
      <div className={styles.actions}>
        <button type="button" className={ui.button} disabled={disabled} onClick={onConfirm}>
          {action.label}
        </button>
        <button type="button" className={`${ui.button} ${ui.secondary}`} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The game's buttons for this seat. A button with a `confirm` question asks it first; the
 * question goes away if the button is no longer offered (another move changed the table).
 */
export function ActionBar({
  actions,
  disabled,
  onAction,
}: {
  actions: readonly ActionButton[];
  disabled: boolean;
  onAction(action: ActionButton): void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const pending = actions.find(
    (action) => action.id === confirming && action.enabled && action.intent,
  );
  if (actions.length === 0) return null;
  if (pending) {
    return (
      <ConfirmAction
        action={pending}
        disabled={disabled}
        onConfirm={() => {
          setConfirming(null);
          onAction(pending);
        }}
        onCancel={() => setConfirming(null)}
      />
    );
  }
  return (
    <fieldset className={styles.actions}>
      <legend className={styles.visuallyHidden}>Actions</legend>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className={ui.button}
          disabled={disabled || !action.enabled || !action.intent}
          title={action.hint}
          onClick={() => (action.confirm ? setConfirming(action.id) : onAction(action))}
        >
          {action.label}
        </button>
      ))}
    </fieldset>
  );
}

export function RejectedNotice({
  rejection,
  onDismiss,
}: {
  rejection: Rejection | null;
  onDismiss(): void;
}) {
  if (!rejection) return null;
  return (
    <div className={styles.rejected} role="alert">
      <span>{rejection.message}</span>
      <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

export function ResultPanel({
  result,
  seats,
  mySeat,
}: {
  result: GameResult;
  seats: readonly SeatInfo[];
  mySeat: SeatId | null;
}) {
  const scores = result.scores ?? {};
  const scored = Object.keys(scores).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
  const won = mySeat !== null && result.winners.includes(mySeat);
  return (
    <section className={styles.result} aria-label="Result">
      <h2>{won ? "You won!" : "Game over"}</h2>
      <p>
        {result.winners.length === 0
          ? "Nobody won."
          : `Winner${result.winners.length > 1 ? "s" : ""}: ${result.winners
              .map((seat) => playerName(seat, seats))
              .join(", ")}`}
      </p>
      {result.reason ? <p className={ui.muted}>{result.reason}</p> : null}
      {scored.length > 0 ? (
        <table className={styles.scores}>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Score</th>
            </tr>
          </thead>
          <tbody>
            {scored.map((seat) => (
              <tr key={seat}>
                <th scope="row">
                  {playerName(seat, seats)}
                  {seat === mySeat ? " (you)" : null}
                </th>
                <td>{scores[seat]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export function ChatPanel({
  entries,
  canSend,
  onSend,
}: {
  entries: readonly ChatEntry[];
  canSend: boolean;
  onSend(text: string): boolean;
}) {
  const [text, setText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (message === "" || !onSend(message.slice(0, 500))) return;
    setText("");
  };
  return (
    <section className={styles.chat} aria-label="Chat">
      <h2>Chat</h2>
      <ol className={styles.messages} aria-live="polite">
        {entries.map((entry) => (
          <li key={entry.id}>
            <strong>{entry.name || seatLabel(entry.from)}:</strong> {entry.text}
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className={styles.chatForm}>
        <label className={styles.visuallyHidden} htmlFor="chat-text">
          Message
        </label>
        <input
          id="chat-text"
          value={text}
          maxLength={500}
          onChange={(event) => setText(event.target.value)}
          placeholder="Say something"
        />
        <button type="submit" className={ui.button} disabled={!canSend || text.trim() === ""}>
          Send
        </button>
      </form>
    </section>
  );
}
