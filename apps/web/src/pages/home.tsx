import { Link } from "react-router";
import styles from "./home.module.css";
import tabletop from "./tabletop.webp";

const destinations = [
  {
    path: "/projects",
    name: "Project workshop",
    summary: "Build cards, place pieces, and try a hot-seat playtest.",
    mark: "✎",
    tone: styles.workshop,
  },
  {
    path: "/games",
    name: "Game shelf",
    summary: "Find a published version and set up a table for guests.",
    mark: "▦",
    tone: styles.shelf,
  },
  {
    path: "/matches",
    name: "Match room",
    summary: "Take your seat, return to a match, or watch a replay.",
    mark: "⚄",
    tone: styles.room,
  },
];

export function HomePage() {
  return (
    <section className={styles.home} aria-labelledby="home-heading" data-enter="">
      <div className={styles.hero}>
        <div className={styles.copy}>
          <p className={styles.kicker}>
            <span aria-hidden="true">✳</span> Designer workspace
          </p>
          <h1 id="home-heading">
            Playtest your board games<span aria-hidden="true">.</span>
          </h1>
          <p className={styles.lead}>
            Lay out your pieces, deal the first hand, and invite friends to play right in their
            browsers.
          </p>
          <Link to="/projects" className={styles.cta}>
            Open projects <span aria-hidden="true">→</span>
          </Link>
        </div>
        <div className={styles.art}>
          <img
            src={tabletop}
            alt="A golden meeple, illustrated forest cards, and a red die on a checkered board"
            width="1050"
            height="700"
            fetchPriority="high"
          />
        </div>
      </div>
      <div className={styles.rule}>
        <h2>Your workspace</h2>
        <span aria-hidden="true" />
      </div>
      <div className={styles.paths}>
        {destinations.map(({ path, name, summary, mark, tone }) => (
          <Link key={path} to={path} className={`${styles.path} ${tone}`}>
            <span className={styles.symbol} aria-hidden="true">
              {mark}
            </span>
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
