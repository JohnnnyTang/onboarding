import type { LocalProject } from "@bgp/schema";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useServices } from "../app/services";
import { EmptyState, Loading, PageHeader, ui } from "../components/ui";
import { createProject } from "../projects/project-model";
import type { ProjectList } from "../projects/project-store";
import styles from "../projects/projects.module.css";
import { now } from "../projects/use-project";

export function projectPath(id: string, section?: string): string {
  return `/projects/${encodeURIComponent(id)}${section ? `/${section}` : ""}`;
}

/** Asks the browser not to evict local data under storage pressure. Best effort. */
function persistStorage() {
  void navigator.storage?.persist?.().catch(() => false);
}

/** Local-first projects live in IndexedDB and need no account (D-015). */
export function ProjectsPage() {
  const { projects } = useServices();
  const navigate = useNavigate();
  const [list, setList] = useState<ProjectList | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    projects()
      .then((store) => store.listProjects())
      .then(setList, () => setFailed(true));
  }, [projects]);
  useEffect(reload, [reload]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return;
    setBusy(true);
    try {
      const project = createProject(name, crypto.randomUUID(), now());
      await (await projects()).putProject(project);
      persistStorage();
      navigate(projectPath(project.id));
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  const remove = async (project: LocalProject) => {
    await (await projects()).deleteProject(project.id);
    reload();
  };

  return (
    <>
      <PageHeader title="Projects">
        Projects stay on this device until you publish them. They work offline and need no account.
      </PageHeader>
      <form className={styles.create} onSubmit={create}>
        <label htmlFor="project-name">New project</label>
        <input
          id="project-name"
          value={name}
          maxLength={80}
          placeholder="Name of your game"
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className={ui.button} disabled={busy || name.trim() === ""}>
          Create project
        </button>
      </form>
      {failed ? (
        <p className={ui.notice} role="alert">
          Projects could not be opened. This browser may block local storage in this window.
        </p>
      ) : list === null ? (
        <Loading label="Opening projects…" />
      ) : (
        <ProjectListView list={list} onDelete={(project) => void remove(project)} />
      )}
    </>
  );
}

export function ProjectListView({
  list,
  onDelete,
}: {
  list: ProjectList;
  onDelete(project: LocalProject): void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <>
      {list.unreadable > 0 ? (
        <p className={ui.notice} role="alert">
          {list.unreadable === 1
            ? "One saved project could not be read and is not shown."
            : `${list.unreadable} saved projects could not be read and are not shown.`}
        </p>
      ) : null}
      {list.projects.length === 0 ? (
        <EmptyState title="No projects yet">
          <p>Name your game above to start putting it on the table.</p>
        </EmptyState>
      ) : (
        <ul className={ui.list} aria-label="Your projects">
          {list.projects.map((project) => (
            <li key={project.id} className={styles.projectRow}>
              <span>
                <Link to={projectPath(project.id)}>
                  <strong>{project.name}</strong>
                </Link>
                <span className={ui.muted}>
                  {" "}
                  · {project.manifest.players.min}–{project.manifest.players.max} players ·{" "}
                  {project.components.defs.length} components · changed{" "}
                  {new Date(project.updatedAt).toLocaleString()}
                </span>
              </span>
              <span className={styles.rowActions}>
                <Link className={ui.button} to={projectPath(project.id, "play")}>
                  Play
                </Link>
                {confirming === project.id ? (
                  <>
                    <button
                      type="button"
                      className={`${ui.button} ${styles.danger}`}
                      onClick={() => onDelete(project)}
                    >
                      Delete {project.name}
                    </button>
                    <button
                      type="button"
                      className={`${ui.button} ${ui.secondary}`}
                      onClick={() => setConfirming(null)}
                    >
                      Keep
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={`${ui.button} ${ui.secondary}`}
                    onClick={() => setConfirming(project.id)}
                  >
                    Delete
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
