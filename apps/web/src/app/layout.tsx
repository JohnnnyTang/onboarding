import { Link, NavLink, Outlet, useLocation, useMatch } from "react-router";
import { SignInButton, ui } from "../components/ui";
import { PageErrorBoundary } from "./error-boundary";
import styles from "./layout.module.css";
import { useAuthUser, useServices } from "./services";

function Account() {
  const { auth } = useServices();
  const user = useAuthUser();
  if (!user) return <SignInButton />;
  return (
    <>
      <span>{user.name}</span>
      <button
        type="button"
        className={`${ui.button} ${ui.secondary}`}
        onClick={() => void auth.signOut()}
      >
        Sign out
      </button>
    </>
  );
}

export function Layout() {
  const { pathname } = useLocation();
  const project = useMatch("/projects/:projectId/:section?");
  // Editor sections share the loaded project and its object URLs. The play table has its own lifetime.
  const pageKey =
    project && project.params.section !== "play"
      ? `project-editor:${project.params.projectId}`
      : pathname;
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#content">
        Skip to content
      </a>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          Board Game Platform
        </Link>
        <nav className={styles.nav} aria-label="Main">
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/games">Games</NavLink>
          <NavLink to="/matches">Matches</NavLink>
        </nav>
        <div className={styles.account}>
          <Account />
        </div>
      </header>
      <main id="content" tabIndex={-1} className={styles.main}>
        <PageErrorBoundary key={pageKey}>
          <Outlet />
        </PageErrorBoundary>
      </main>
    </div>
  );
}
