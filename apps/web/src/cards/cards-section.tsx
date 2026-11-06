import { useEffect, useState } from "react";
import { ui } from "../components/ui";
import { Problems, TextField } from "../projects/fields";
import styles from "../projects/projects.module.css";
import type { SectionProps } from "../projects/sections";
import { addTemplate } from "./card-model";
import cards from "./cards.module.css";
import { CsvPanel } from "./csv-panel";
import { ensureCardFonts } from "./fonts";
import { TemplateEditor } from "./template-editor";
import { useCardImages } from "./use-card-images";

/** `/projects/:id/cards`: CSV data and card templates that generate card components. */
export function CardsSection({ project, editor, images }: SectionProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const assets = editor.data.status === "ready" ? editor.data.assets : [];
  const bitmaps = useCardImages(assets);
  const [fonts, setFonts] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    let cancelled = false;
    ensureCardFonts().then(
      () => !cancelled && setFonts("ready"),
      () => !cancelled && setFonts("failed"),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const template =
    project.cardTemplates.find((candidate) => candidate.id === selected) ??
    project.cardTemplates[0];

  const add = async () => {
    let id = "";
    const found = await editor.save((current) => {
      const result = addTemplate(current, name || `Cards ${current.cardTemplates.length + 1}`);
      id = result.id;
      return result.project;
    });
    setProblems(found);
    if (found.length === 0) {
      setSelected(id);
      setName("");
    }
  };

  return (
    <div className={cards.sections}>
      <CsvPanel project={project} editor={editor} />
      <section className={styles.panel} aria-label="Card templates">
        <h2 className={cards.heading}>Card templates</h2>
        <div className={styles.fieldRow}>
          <TextField label="New template name" value={name} onChange={setName} />
          <p className={styles.formActions}>
            <button type="button" className={ui.button} onClick={() => void add()}>
              Add template
            </button>
          </p>
        </div>
        <Problems
          problems={
            fonts === "failed"
              ? [...problems, "The card fonts could not be loaded; previews use system fonts."]
              : problems
          }
        />
        {project.cardTemplates.length === 0 ? (
          <p className={ui.muted}>
            A template lays out text, images and colored boxes on a card. Each CSV row becomes one
            card.
          </p>
        ) : (
          <ul className={styles.zoneList} aria-label="Templates">
            {project.cardTemplates.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  aria-pressed={candidate.id === template?.id}
                  className={`${ui.button} ${candidate.id === template?.id ? "" : ui.secondary}`}
                  onClick={() => setSelected(candidate.id)}
                >
                  {candidate.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        {template ? (
          <TemplateEditor
            key={template.id}
            project={project}
            template={template}
            editor={editor}
            images={images}
            bitmaps={bitmaps}
            fontsReady={fonts === "ready"}
          />
        ) : null}
      </section>
    </div>
  );
}
