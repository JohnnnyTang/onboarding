import type { LocalProject } from "@bgp/schema";
import { useId, useState } from "react";
import { ui } from "../components/ui";
import { Problems } from "../projects/fields";
import styles from "../projects/projects.module.css";
import { now, type ProjectEditor } from "../projects/use-project";
import { addCsvSource, removeCsvSource } from "./card-model";
import cards from "./cards.module.css";
import { readCsvFile } from "./csv";

const PREVIEW_ROWS = 5;

/** Imports CSV files for the card generator and shows what each one holds. */
export function CsvPanel({ project, editor }: { project: LocalProject; editor: ProjectEditor }) {
  const inputId = useId();
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const importFiles = async (files: readonly File[]) => {
    const found: string[] = [];
    for (const file of files) {
      const result = await readCsvFile(file);
      if (!result.ok) {
        found.push(...result.problems.map((problem) => `${file.name}: ${problem}`));
        continue;
      }
      const saved = await editor.save(
        (current) =>
          addCsvSource(current, file.name, result.table, crypto.randomUUID(), now()).project,
      );
      found.push(...saved.map((problem) => `${file.name}: ${problem}`));
    }
    setProblems(found);
  };

  return (
    <section className={styles.panel} aria-label="Card data">
      <h2 className={cards.heading}>Card data</h2>
      <div className={styles.field}>
        <label htmlFor={inputId}>
          Import CSV (first row names the columns; a file with the same name replaces the old one)
        </label>
        <input
          id={inputId}
          type="file"
          accept=".csv,text/csv,text/plain"
          multiple
          disabled={busy}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length === 0) return;
            setBusy(true);
            void importFiles(files)
              .catch(() => setProblems(["The CSV could not be saved on this device."]))
              .finally(() => setBusy(false));
          }}
        />
      </div>
      <Problems problems={problems} />
      {project.csvSources.length === 0 ? (
        <p className={ui.muted}>No CSV files yet. One row per card, one column per value.</p>
      ) : (
        <ul className={styles.defs} aria-label="CSV files">
          {project.csvSources.map((source) => (
            <li key={source.id}>
              <details>
                <summary>
                  <strong>{source.name}</strong>{" "}
                  <span className={ui.muted}>
                    {source.rows.length} {source.rows.length === 1 ? "row" : "rows"} ·{" "}
                    {source.columns.join(", ")}
                  </span>
                </summary>
                <div className={styles.defForm}>
                  <div className={cards.tableScroll}>
                    <table className={cards.csvTable}>
                      <thead>
                        <tr>
                          {source.columns.map((column) => (
                            <th key={column} scope="col">
                              {column}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {source.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity.
                          <tr key={index}>
                            {row.map((value, column) => (
                              // biome-ignore lint/suspicious/noArrayIndexKey: cells follow columns.
                              <td key={column}>{value}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {source.rows.length > PREVIEW_ROWS ? (
                    <p className={ui.muted}>First {PREVIEW_ROWS} rows shown.</p>
                  ) : null}
                  <p className={styles.formActions}>
                    <button
                      type="button"
                      className={`${ui.button} ${ui.secondary}`}
                      onClick={() =>
                        void editor
                          .save((current) => removeCsvSource(current, source.id))
                          .then(setProblems)
                      }
                    >
                      Remove {source.name}
                    </button>
                  </p>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
