import { Link, NavLink, Outlet, useLocation } from "react-router";
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
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          Board Game Platform
        </Link>
        <nav className={styles.nav} aria-label="Main">
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/games">Games</NavLink>
          <NavLink to="/matches">Matches</NavLink>
        </nav>
        <div className={styles.account}>
          <Account />
        </div>
      </header>
      <main className={styles.main}>
        <PageErrorBoundary key={pathname}>
          <Outlet />
        </PageErrorBoundary>
      </main>
    </div>
  );
}
