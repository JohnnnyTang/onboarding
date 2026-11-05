import { Link, NavLink, useParams } from "react-router";
import { CardsSection } from "../cards/cards-section";
import { EmptyState, Loading, PageHeader, ui } from "../components/ui";
import { missingImages } from "../projects/project-model";
import styles from "../projects/projects.module.css";
import {
  ComponentsSection,
  DetailsSection,
  ImagesSection,
  type SectionProps,
} from "../projects/sections";
import { SetupEditor } from "../projects/setup-editor";
import { useProject } from "../projects/use-project";
import { ZoneEditor } from "../projects/zone-editor";
import { projectPath } from "./projects";

const SECTIONS = [
  { path: "", label: "Details" },
  { path: "images", label: "Images" },
  { path: "components", label: "Components" },
  { path: "cards", label: "Cards" },
  { path: "table", label: "Table" },
  { path: "setup", label: "Setup" },
] as const;

function Section({ section, ...props }: SectionProps & { section: string }) {
  switch (section) {
    case "images":
      return <ImagesSection {...props} />;
    case "components":
      return <ComponentsSection {...props} />;
    case "cards":
      return <CardsSection {...props} />;
    case "table":
      return <ZoneEditor project={props.project} editor={props.editor} />;
    case "setup":
      return <SetupEditor project={props.project} editor={props.editor} />;
    default:
      return <DetailsSection key={props.project.id} {...props} />;
  }
}

/** `/projects/:projectId[/:section]`: edit a local project. Everything is saved on this device. */
export function ProjectPage() {
  const { projectId = "", section = "" } = useParams();
  const editor = useProject(projectId);
  const { data } = editor;

  if (data.status === "loading") return <Loading label="Opening the project…" />;
  if (data.status === "missing" || data.status === "error") {
    return (
      <>
        <PageHeader title="Project" />
        <EmptyState
          title={
            data.status === "missing"
              ? "This project is not on this device"
              : "This project could not be opened"
          }
        >
          <p>
            Projects are stored in the browser where they were made.{" "}
            <Link to="/projects">Back to projects</Link>
          </p>
        </EmptyState>
      </>
    );
  }

  const { project, assets } = data;
  const images = assets.map((asset) => asset.path);
  const missing = missingImages(project, images);
  const known = SECTIONS.some((entry) => entry.path === section);
  return (
    <>
      <PageHeader title={project.name}>
        {project.manifest.players.min}–{project.manifest.players.max} players · saved on this device
      </PageHeader>
      <nav className={styles.tabs} aria-label="Project sections">
        {SECTIONS.map((entry) => (
          <NavLink key={entry.path} end to={projectPath(project.id, entry.path)}>
            {entry.label}
          </NavLink>
        ))}
        <Link className={ui.button} to={projectPath(project.id, "play")}>
          Play hot-seat
        </Link>
      </nav>
      {missing.length > 0 && section !== "images" ? (
        <p className={ui.muted}>
          {missing.length === 1 ? "One image is" : `${missing.length} images are`} missing; the
          table shows placeholders.{" "}
          <Link to={projectPath(project.id, "images")}>Import images</Link>
        </p>
      ) : null}
      {known ? (
        <Section section={section} project={project} editor={editor} images={images} />
      ) : (
        <EmptyState title="Unknown section">
          <p>
            <Link to={projectPath(project.id)}>Back to the project</Link>
          </p>
        </EmptyState>
      )}
    </>
  );
}
