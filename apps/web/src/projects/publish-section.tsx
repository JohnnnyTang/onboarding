import type { ValidationError, Visibility } from "@bgp/schema";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { errorMessage } from "../app/messages";
import { useAuthUser, useServices } from "../app/services";
import { EmptyState, SignInButton, ui } from "../components/ui";
import { SelectField, TextField } from "./fields";
import styles from "./projects.module.css";
import {
  findGame,
  type PublishProgress,
  type PublishResult,
  packageFiles,
  publishProject,
  suggestVersion,
} from "./publish";
import type { SectionProps } from "./sections";

const VISIBILITY_OPTIONS: readonly { value: Visibility; label: string }[] = [
  { value: "private", label: "Private: only you and the players you invite" },
  { value: "unlisted", label: "Unlisted: anyone with a match invite" },
];

const STAGE_LABELS: Record<PublishProgress["stage"], string> = {
  game: "Preparing the game…",
  draft: "Creating the version…",
  upload: "Uploading files…",
  finalize: "Checking the version on the server…",
};

function progressLabel(progress: PublishProgress): string {
  if (progress.stage === "upload" && progress.total !== undefined) {
    return `Uploading files… ${progress.done ?? 0} of ${progress.total}`;
  }
  return STAGE_LABELS[progress.stage];
}

export function gamePath(gameId: string): string {
  return `/games/${encodeURIComponent(gameId)}`;
}

function ValidationErrors({ errors }: { errors: readonly ValidationError[] }) {
  if (errors.length === 0) return null;
  return (
    <ul className={styles.problems} aria-label="Validation errors">
      {errors.map((error) => (
        <li key={`${error.path}:${error.message}`}>
          {error.path === "" ? null : <code>{error.path}</code>} {error.message}
        </li>
      ))}
    </ul>
  );
}

/** The versions this designer already published for the project's game id. */
function usePublishedVersions(slug: string, enabled: boolean) {
  const { api } = useServices();
  const user = useAuthUser();
  return useQuery({
    queryKey: ["published-versions", user?.subject, slug],
    enabled,
    queryFn: async () => {
      const game = await findGame(api, slug);
      if (!game) return { game: null, versions: [] as string[] };
      const detail = await api.getGame(game.id);
      return { game, versions: detail.versions.map((version) => version.manifest.version) };
    },
  });
}

function PublishForm({ project, editor, images }: SectionProps) {
  const { api } = useServices();
  const queryClient = useQueryClient();
  const published = usePublishedVersions(project.manifest.id, true);
  const [visibility, setVisibility] = useState<Visibility | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<PublishProgress | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const suggested = published.data
    ? suggestVersion(project.manifest.version, published.data.versions)
    : project.manifest.version;
  const chosenVersion = version ?? suggested;
  const chosenVisibility = visibility ?? published.data?.game?.visibility ?? "private";
  const empty = project.components.defs.length === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    setFailure(null);
    const current = await editor.current();
    if (!current) return;
    const { files, missing: absent } = await packageFiles(current.project, current.assets);
    if (absent.length > 0) {
      setFailure(
        `Import the missing images first: ${absent.map((path) => path.replace(/^assets\//, "")).join(", ")}.`,
      );
      return;
    }
    setProgress({ stage: "game" });
    try {
      const outcome = await publishProject(api, {
        project: current.project,
        files,
        version: chosenVersion.trim(),
        visibility: chosenVisibility,
        onProgress: setProgress,
      });
      setResult(outcome);
      if (outcome.ok) {
        // Remember the version on this device; the next publish suggests the one after it.
        await editor.save((latest) => ({
          ...latest,
          manifest: { ...latest.manifest, version: outcome.manifest.version },
          publishedVersionIds: [...latest.publishedVersionIds, outcome.versionId],
        }));
        setVersion(null);
        await queryClient.invalidateQueries({ queryKey: ["published-versions"] });
        await queryClient.invalidateQueries({ queryKey: ["games"] });
      }
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setProgress(null);
    }
  }

  const busy = progress !== null;
  return (
    <>
      <form className={styles.panel} onSubmit={submit} aria-label="Publish">
        <p>
          Publishing uploads the components and the {images.length === 1 ? "image" : "images"} they
          use as a new version of the game <code>{project.manifest.id}</code>. The project stays on
          this device; card templates and CSV files are not uploaded.
        </p>
        {published.data?.game ? (
          <p>
            Published versions:{" "}
            {published.data.versions.length === 0 ? "none" : published.data.versions.join(", ")}.{" "}
            <Link to={gamePath(published.data.game.id)}>Open the game</Link>
          </p>
        ) : null}
        <div className={styles.fieldRow}>
          <TextField label="Version" value={chosenVersion} onChange={setVersion} maxLength={64} />
          <SelectField<Visibility>
            label="Who can play"
            value={chosenVisibility}
            options={VISIBILITY_OPTIONS}
            onChange={setVisibility}
          />
        </div>
        <button type="submit" className={ui.button} disabled={busy || empty}>
          {busy ? "Publishing…" : "Publish"}
        </button>
        {empty ? <p className={ui.muted}>Add components before publishing.</p> : null}
        {progress ? (
          <p className={ui.muted} role="status">
            {progressLabel(progress)}
          </p>
        ) : null}
      </form>
      {failure ? (
        <p className={ui.notice} role="alert">
          {failure}
        </p>
      ) : null}
      {result?.ok ? (
        <section className={styles.panel} aria-label="Published version">
          <p role="status">
            Version {result.manifest.version} is ready. Build hash{" "}
            <code title={result.buildHash}>{result.buildHash.slice(0, 12)}</code>
          </p>
          <p>
            <Link className={ui.button} to={gamePath(result.gameId)}>
              Create a match
            </Link>
          </p>
        </section>
      ) : null}
      {result && !result.ok ? (
        <section className={styles.panel} aria-label="Publishing failed" role="alert">
          <p>
            {result.stage === "finalize"
              ? "The server did not accept this version:"
              : `Publishing failed: ${result.message}`}
          </p>
          <ValidationErrors errors={result.errors} />
        </section>
      ) : null}
    </>
  );
}

/** `/projects/:id/publish`: publish the project as a game version (T17). */
export function PublishSection(props: SectionProps) {
  const user = useAuthUser();
  if (!user) {
    return (
      <EmptyState title="Sign in to publish">
        <p>
          Publishing uploads this project so you can host matches with invited players. Your work
          stays on this device until you publish.
        </p>
        <SignInButton />
      </EmptyState>
    );
  }
  return <PublishForm {...props} />;
}
