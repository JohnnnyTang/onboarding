import { EmptyState, PageHeader } from "../components/ui";

/** Local-first projects live in IndexedDB and need no account (T15 adds the editor). */
export function ProjectsPage() {
  return (
    <>
      <PageHeader title="Projects">Projects stay on this device until you publish them.</PageHeader>
      <EmptyState title="No projects yet">
        <p>The project editor is not available yet.</p>
      </EmptyState>
    </>
  );
}
