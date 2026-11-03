import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useServices } from "../app/services";
import { EmptyState, Loading, SignInButton } from "../components/ui";

/** Redirect target for the OIDC provider (`/auth/callback`). */
export function AuthCallbackPage() {
  const { auth } = useServices();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    auth.completeSignIn(window.location.href).then(
      // Replace the history entry so the authorization code never stays in the URL.
      (returnTo) => active && navigate(returnTo, { replace: true }),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [auth, navigate]);

  if (!failed) return <Loading label="Signing in…" />;
  return (
    <EmptyState title="Sign-in did not complete">
      <p>The sign-in link may have expired or been used already.</p>
      <SignInButton label="Try again" />
    </EmptyState>
  );
}
