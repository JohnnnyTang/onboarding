import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { errorMessage } from "../app/messages";
import { useAuthUser, useServices } from "../app/services";
import styles from "./ui.module.css";

export { styles as ui };

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className={styles.pageHeader}>
      <h1>{title}</h1>
      {children ? <p>{children}</p> : null}
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className={styles.empty} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className={styles.muted} role="status">
      {label}
    </p>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  return (
    <p className={styles.notice} role="alert">
      {errorMessage(error)}
    </p>
  );
}

export function SignInButton({ label = "Sign in" }: { label?: string }) {
  const { auth } = useServices();
  const location = useLocation();
  return (
    <button
      type="button"
      className={styles.button}
      onClick={() => void auth.signIn(`${location.pathname}${location.search}`)}
    >
      {label}
    </button>
  );
}

/** Pages for designers. Guests never need an account, so this explains instead of redirecting. */
export function RequireUser({ what, children }: { what: string; children: ReactNode }) {
  const user = useAuthUser();
  if (user) return <>{children}</>;
  return (
    <EmptyState title={`Sign in to see your ${what}`}>
      <p>Designers sign in to publish games and host matches. Guests join from an invite link.</p>
      <SignInButton />
    </EmptyState>
  );
}
