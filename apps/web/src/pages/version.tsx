import type { Json, Manifest, ManifestOption, VersionResponse } from "@bgp/schema";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { errorMessage } from "../app/messages";
import { useAuthUser, useServices } from "../app/services";
import { ErrorNotice, Loading, PageHeader, RequireUser, ui } from "../components/ui";
import { matchPath } from "./matches";

/** Where a version lives in the app. */
export function versionPath(gameId: string, versionId: string): string {
  return `/games/${encodeURIComponent(gameId)}/versions/${encodeURIComponent(versionId)}`;
}

export function defaultOptions(manifest: Manifest): Record<string, Json> {
  return Object.fromEntries((manifest.options ?? []).map((option) => [option.id, option.default]));
}

function OptionField({
  option,
  value,
  onChange,
}: {
  option: ManifestOption;
  value: Json | undefined;
  onChange(value: Json): void;
}) {
  const id = useId();
  switch (option.type) {
    case "boolean":
      return (
        <div className={ui.field}>
          <label htmlFor={id}>
            <input
              id={id}
              type="checkbox"
              checked={value === true}
              onChange={(event) => onChange(event.target.checked)}
            />{" "}
            {option.label}
          </label>
        </div>
      );
    case "integer":
      return (
        <div className={ui.field}>
          <label htmlFor={id}>{option.label}</label>
          <input
            id={id}
            type="number"
            min={option.min}
            max={option.max}
            step={1}
            value={typeof value === "number" ? value : option.default}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (Number.isSafeInteger(next)) onChange(next);
            }}
          />
        </div>
      );
    case "choice":
      return (
        <div className={ui.field}>
          <label htmlFor={id}>{option.label}</label>
          <select
            id={id}
            value={typeof value === "string" ? value : option.default}
            onChange={(event) => onChange(event.target.value)}
          >
            {option.choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </div>
      );
  }
}

/** Seat count and options for a new match; creating it shows the invites in the lobby. */
export function CreateMatchForm({ version }: { version: VersionResponse }) {
  const { api, invites } = useServices();
  const navigate = useNavigate();
  const { players } = version.manifest;
  const seatsId = useId();
  const [seatCount, setSeatCount] = useState(players.max);
  const [options, setOptions] = useState(() => defaultOptions(version.manifest));
  const create = useMutation({
    mutationFn: () => api.createMatch({ versionId: version.id, seatCount, options }),
    onSuccess: (created) => {
      invites.set({ matchId: created.match.id, invites: created.invites });
      void navigate(matchPath(created.match));
    },
  });
  const counts = Array.from({ length: players.max - players.min + 1 }, (_, n) => players.min + n);

  function submit(event: FormEvent) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <form onSubmit={submit} aria-label="Create a match">
      <div className={ui.field}>
        <label htmlFor={seatsId}>Seats</label>
        <select
          id={seatsId}
          value={seatCount}
          onChange={(event) => setSeatCount(Number(event.target.value))}
        >
          {counts.map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
      </div>
      {(version.manifest.options ?? []).map((option) => (
        <OptionField
          key={option.id}
          option={option}
          value={options[option.id]}
          onChange={(value) => setOptions({ ...options, [option.id]: value })}
        />
      ))}
      {create.isError ? (
        <p className={ui.notice} role="alert">
          {errorMessage(create.error)}
        </p>
      ) : null}
      <button type="submit" className={ui.button} disabled={create.isPending}>
        {create.isPending ? "Creating…" : "Create match"}
      </button>
    </form>
  );
}

export function VersionDetails({ version }: { version: VersionResponse }) {
  const { manifest } = version;
  return (
    <dl className={ui.details}>
      <dt>Status</dt>
      <dd>
        <span className={ui.badge}>{version.status}</span>
      </dd>
      <dt>Mode</dt>
      <dd>{manifest.mode === "sandbox" ? "Sandbox (manual play)" : "Enforced rules"}</dd>
      <dt>Players</dt>
      <dd>
        {manifest.players.min === manifest.players.max
          ? manifest.players.min
          : `${manifest.players.min}–${manifest.players.max}`}
      </dd>
      {version.buildHash ? (
        <>
          <dt>Build hash</dt>
          <dd>
            <code data-testid="build-hash">{version.buildHash}</code>
          </dd>
        </>
      ) : null}
      {manifest.description ? (
        <>
          <dt>Description</dt>
          <dd>{manifest.description}</dd>
        </>
      ) : null}
    </dl>
  );
}

function Version({ gameId, versionId }: { gameId: string; versionId: string }) {
  const { api } = useServices();
  const user = useAuthUser();
  const version = useQuery({
    queryKey: ["version", user?.subject, versionId],
    queryFn: () => api.getVersion(versionId),
  });
  if (version.isPending) return <Loading />;
  if (version.isError)
    return <ErrorNotice error={version.error} onRetry={() => void version.refetch()} />;
  const { manifest } = version.data;
  return (
    <>
      <PageHeader title={`${manifest.name} ${manifest.version}`}>
        <Link to={`/games/${encodeURIComponent(gameId)}`}>All versions</Link>
      </PageHeader>
      <VersionDetails version={version.data} />
      {version.data.status === "failed" ? (
        <>
          <h2>Validation errors</h2>
          <ul className={ui.list} aria-label="Validation errors">
            {(version.data.validationErrors ?? []).map((error) => (
              <li key={`${error.path}:${error.message}`}>
                <span>
                  {error.path === "" ? null : <code>{error.path}</code>} {error.message}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {version.data.status === "draft" ? (
        <p className={ui.muted}>This version was not finalized. Publish again to finish it.</p>
      ) : null}
      {version.data.status === "ready" ? (
        <>
          <h2>Create a match</h2>
          <CreateMatchForm version={version.data} />
        </>
      ) : null}
    </>
  );
}

/** `/games/:gameId/versions/:versionId`: a version, its checks and match creation (T17). */
export function VersionPage() {
  const { gameId = "", versionId = "" } = useParams();
  return (
    <RequireUser what="games">
      <Version gameId={gameId} versionId={versionId} />
    </RequireUser>
  );
}
