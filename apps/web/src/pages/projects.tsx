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
      <PageHeader title="Projects" art="workshop">
        Projects stay on this device until you publish them. They work offline and need no account.
      </PageHeader>
      <div className={styles.library}>
        <form className={styles.create} onSubmit={create}>
          <h2>Start a prototype</h2>
          <label htmlFor="project-name">New project</label>
          <input
            id="project-name"
            value={name}
            maxLength={80}
            placeholder="Name of your game"
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className={ui.button} disabled={busy || name.trim() === ""}>
            {busy ? "Creating…" : "Create project"}
          </button>
        </form>
        <section aria-label="Saved projects" className={styles.saved}>
          <h2>On this device</h2>
          {failed ? (
            <p className={ui.notice} role="alert">
              Projects could not be opened. This browser may block local storage in this window.
            </p>
          ) : list === null ? (
            <Loading label="Opening projects…" />
          ) : (
            <ProjectListView list={list} onDelete={(project) => void remove(project)} />
          )}
        </section>
      </div>
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
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const term = query.trim().toLocaleLowerCase();
  const visible = list.projects.filter((project) =>
    project.name.toLocaleLowerCase().includes(term),
  );
  if (sort === "name") visible.sort((left, right) => left.name.localeCompare(right.name));
  return (
    <>
      {list.unreadable > 0 ? (
        <p className={ui.notice} role="alert">
          {list.unreadable === 1
            ? "One saved project could not be read and is not shown."
            : `${list.unreadable} saved projects could not be read and are not shown.`}
        </p>
      ) : null}
      {(list.projects.length > 1 || query !== "") && (
        <div className={styles.libraryTools}>
          <label className={styles.field}>
            Find a project
            <input
              type="search"
              placeholder="Project name"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setConfirming(null);
              }}
            />
          </label>
          <label className={styles.field}>
            Sort by
            <select value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="recent">Last edited</option>
              <option value="name">Name (A–Z)</option>
            </select>
          </label>
        </div>
      )}
      {list.projects.length === 0 ? (
        <EmptyState title="No projects yet">
          <p>Give your prototype a name to start laying out its pieces.</p>
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState title="No matching projects">
          <p>Try another name or clear your search to see all projects.</p>
          <button type="button" className={ui.button} onClick={() => setQuery("")}>
            Clear search
          </button>
        </EmptyState>
      ) : (
        <ul className={ui.list} aria-label="Your projects">
          {visible.map((project) => (
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
