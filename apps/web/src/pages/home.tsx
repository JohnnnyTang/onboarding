import { Link } from "react-router";
import { WorkspaceArt } from "../components/workspace-art";
import styles from "./home.module.css";
import tabletop from "./tabletop.webp";
import tabletopSmall from "./tabletop-small.webp";

const destinations = [
  {
    path: "/projects",
    name: "Project workshop",
    summary: "Build cards, place pieces, and try a hot-seat playtest.",
    kind: "workshop",
  },
  {
    path: "/games",
    name: "Game shelf",
    summary: "Find a published version and set up a table for guests.",
    kind: "shelf",
  },
  {
    path: "/matches",
    name: "Match room",
    summary: "Take your seat, return to a match, or watch a replay.",
    kind: "room",
  },
] as const;

export function HomePage() {
  return (
    <section className={styles.home} aria-labelledby="home-heading" data-enter="">
      <div
        className={styles.hero}
        onPointerMove={(event) => {
          if (
            event.pointerType !== "mouse" ||
            !window.matchMedia("(prefers-reduced-motion: no-preference)").matches
          )
            return;
          const frame = event.currentTarget;
          const bounds = frame.getBoundingClientRect();
          frame.style.setProperty("--spot-x", `${event.clientX - bounds.left}px`);
          frame.style.setProperty("--spot-y", `${event.clientY - bounds.top}px`);
        }}
      >
        <div className={styles.copy}>
          <p className={styles.kicker}>
            <span aria-hidden="true">✳</span> Designer workspace
          </p>
          <h1 id="home-heading">
            Playtest your board games<span aria-hidden="true">.</span>
          </h1>
          <p className={styles.lead}>
            Lay out your pieces and deal the first hand. Each guest gets one invite link to join
            your table in their browser.
          </p>
          <Link to="/projects" className={styles.cta}>
            Open projects <span aria-hidden="true">→</span>
          </Link>
        </div>
        <picture className={styles.art} data-visual="">
          <source media="(max-width: 720px)" srcSet={tabletopSmall} />
          <img
            src={tabletop}
            alt="A golden meeple, illustrated forest cards, and a red die on a checkered board"
            width="1050"
            height="700"
            fetchPriority="high"
          />
        </picture>
      </div>
      <div className={styles.rule}>
        <h2>Your workspace</h2>
        <span aria-hidden="true" />
      </div>
      <div className={styles.paths}>
        {destinations.map(({ path, name, summary, kind }) => (
          <Link key={path} to={path} className={styles.path}>
            <WorkspaceArt kind={kind} className={styles.symbol} />
            <span className={styles.arrow} aria-hidden="true">
              ↗
            </span>
            <h3>{name}</h3>
            <p>{summary}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
