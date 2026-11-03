import { Link } from "react-router";
import { useAuthUser } from "../app/services";
import { PageHeader, SignInButton, ui } from "../components/ui";

export function HomePage() {
  const user = useAuthUser();
  return (
    <>
      <PageHeader title="Playtest your board games">
        Put a game on a virtual table and play it with remote guests in the browser.
      </PageHeader>
      <ul className={ui.list}>
        <li>
          <span>
            <Link to="/projects">Projects</Link>
            <span className={ui.muted}> — work in progress, stored on this device</span>
          </span>
        </li>
        <li>
          <span>
            <Link to="/games">Games</Link>
            <span className={ui.muted}> — published games and their versions</span>
          </span>
        </li>
        <li>
          <span>
            <Link to="/matches">Matches</Link>
            <span className={ui.muted}> — matches you host or play in</span>
          </span>
        </li>
      </ul>
      {user ? null : (
        <p>
          Designers sign in to publish games and host matches. Playtesters join from an invite link,
          without an account. <SignInButton />
        </p>
      )}
    </>
  );
}
