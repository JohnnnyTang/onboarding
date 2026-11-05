import {
  CARD_DPI,
  defaultValues,
  missingColumns,
  paintCard,
  pixelSize,
  planCards,
  rowValues,
} from "@bgp/card-generator";
import type { CardField, CardTemplate, LocalProject } from "@bgp/schema";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { ui } from "../components/ui";
import { NumberField, Problems, SelectField, TextField } from "../projects/fields";
import { setupZoneChoices } from "../projects/project-model";
import styles from "../projects/projects.module.css";
import type { ProjectEditor } from "../projects/use-project";
import {
  addGeneratedToSetup,
  type Face,
  FIELD_KINDS,
  type FieldKind,
  findSource,
  newField,
  removeTemplate,
  updateTemplate,
} from "./card-model";
import cards from "./cards.module.css";
import { generationChange, renderGeneration } from "./generate";

const NONE = "";
const PREVIEW_WIDTH_PX = 280;

type GenerationStatus =
  | { state: "idle" }
  | { state: "running"; done: number; total: number }
  | { state: "done"; count: number; seconds: number; warnings: string[] };

/** `#abc` → `#aabbcc`, as color inputs need. */
function longHex(color: string): string {
  return color.length === 4
    ? `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`
    : color.toLowerCase();
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <span className={cards.color}>
        <input
          id={id}
          type="color"
          value={longHex(value)}
          onChange={(event) => onChange(event.target.value)}
        />
        <code>{longHex(value)}</code>
      </span>
    </div>
  );
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className={cards.group}>
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}

/** The card drawn on a page canvas at screen resolution, exactly as generation lays it out. */
function CardPreview({
  template,
  values,
  images,
  label,
}: {
  template: CardTemplate;
  values: Readonly<Record<string, string | null>>;
  images: ReadonlyMap<string, ImageBitmap>;
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const dpi = (PREVIEW_WIDTH_PX * scale * 25.4) / template.size_mm[0];
    const [width, height] = pixelSize(template.size_mm, dpi);
    canvas.width = width;
    canvas.height = height;
    paintCard(ctx, template, values, images, dpi);
  }, [template, values, images]);
  return (
    <canvas
      ref={ref}
      className={cards.preview}
      style={{ aspectRatio: `${template.size_mm[0]} / ${template.size_mm[1]}` }}
      data-testid="card-preview"
      role="img"
      aria-label={label}
    />
  );
}

function FieldForm({
  field,
  columns,
  column,
  images,
  onChange,
  onColumn,
}: {
  field: CardField;
  columns: readonly string[];
  column: string | undefined;
  images: readonly string[];
  onChange(field: CardField): void;
  onColumn(column: string | null): void;
}) {
  const rect = (key: keyof CardField["rect_mm"], label: string, min: number) => (
    <NumberField
      label={label}
      unit="mm"
      min={min}
      max={1000}
      value={field.rect_mm[key]}
      onChange={(value) => onChange({ ...field, rect_mm: { ...field.rect_mm, [key]: value } })}
    />
  );
  const columnHint =
    field.kind === "text"
      ? "Column (its text)"
      : field.kind === "image"
        ? "Column (image names)"
        : "Column (colors)";
  return (
    <div className={styles.defForm}>
      <div className={styles.fieldRow}>
        <TextField
          label="Label"
          maxLength={40}
          value={field.label}
          onChange={(label) =>
            onChange({ ...field, label: label.trim() === "" ? field.label : label })
          }
        />
        <SelectField
          label={columnHint}
          value={column ?? NONE}
          options={[
            { value: NONE, label: "No column (always the default)" },
            ...columns.map((name) => ({ value: name, label: name })),
          ]}
          onChange={(value) => onColumn(value === NONE ? null : value)}
        />
      </div>
      <div className={styles.fieldRow}>
        {rect("x", "Left", 0)}
        {rect("y", "Top", 0)}
        {rect("w", "Width", 0.1)}
        {rect("h", "Height", 0.1)}
      </div>
      {field.kind === "text" ? (
        <>
          <TextField
            label={column ? "Default text (for empty cells)" : "Text"}
            maxLength={2000}
            value={field.text}
            onChange={(text) => onChange({ ...field, text })}
          />
          <div className={styles.fieldRow}>
            <NumberField
              label="Text size"
              unit="mm"
              min={0.5}
              max={200}
              value={field.size_mm}
              onChange={(size_mm) => onChange({ ...field, size_mm })}
            />
            <SelectField
              label="Font"
              value={field.font}
              options={[
                { value: "sans-serif", label: "Sans serif" },
                { value: "serif", label: "Serif" },
                { value: "monospace", label: "Monospace" },
              ]}
              onChange={(font) => onChange({ ...field, font })}
            />
            <SelectField
              label="Align"
              value={field.align}
              options={[
                { value: "left", label: "Left" },
                { value: "center", label: "Center" },
                { value: "right", label: "Right" },
              ]}
              onChange={(align) => onChange({ ...field, align })}
            />
            <SelectField
              label="Vertical"
              value={field.valign}
              options={[
                { value: "top", label: "Top" },
                { value: "middle", label: "Middle" },
                { value: "bottom", label: "Bottom" },
              ]}
              onChange={(valign) => onChange({ ...field, valign })}
            />
          </div>
          <div className={styles.fieldRow}>
            <ColorField
              label="Text color"
              value={field.color}
              onChange={(color) => onChange({ ...field, color })}
            />
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={field.bold}
                onChange={(event) => onChange({ ...field, bold: event.target.checked })}
              />
              Bold
            </label>
          </div>
        </>
      ) : null}
      {field.kind === "image" ? (
        <div className={styles.fieldRow}>
          <SelectField
            label={column ? "Default image (for empty cells)" : "Image"}
            value={field.image ?? NONE}
            options={[
              { value: NONE, label: "None" },
              ...images.map((path) => ({ value: path, label: path.replace(/^assets\//, "") })),
            ]}
            onChange={(image) => onChange({ ...field, image: image === NONE ? null : image })}
          />
          <SelectField
            label="Fit"
            value={field.fit}
            options={[
              { value: "contain", label: "Whole image" },
              { value: "cover", label: "Fill and crop" },
            ]}
            onChange={(fit) => onChange({ ...field, fit })}
          />
        </div>
      ) : null}
      {field.kind === "box" ? (
        <div className={styles.fieldRow}>
          <ColorField
            label={column ? "Default color" : "Color"}
            value={field.color}
            onChange={(color) => onChange({ ...field, color })}
          />
          <NumberField
            label="Corner radius"
            unit="mm"
            min={0}
            max={500}
            value={field.radius_mm}
            onChange={(radius_mm) => onChange({ ...field, radius_mm })}
          />
        </div>
      ) : null}
    </div>
  );
}

export function TemplateEditor({
  project,
  template,
  editor,
  images,
  bitmaps,
}: {
  project: LocalProject;
  template: CardTemplate;
  editor: ProjectEditor;
  images: readonly string[];
  bitmaps: ReadonlyMap<string, ImageBitmap>;
}) {
  const [draft, setDraft] = useState(template);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [kind, setKind] = useState<FieldKind>("text");
  const [row, setRow] = useState(1);
  const [status, setStatus] = useState<GenerationStatus>({ state: "idle" });
  const source = findSource(project, draft.data.source);
  const columns = source?.columns ?? [];
  const rowCount = source?.rows.length ?? 0;
  const previewRow = Math.min(Math.max(1, row), Math.max(1, rowCount));
  const imported = images.filter((path) => !path.startsWith("assets/cards/"));

  const preview = useMemo(
    () =>
      source && rowCount > 0
        ? rowValues(draft, source, previewRow - 1, images)
        : { values: defaultValues(draft), warnings: [] },
    [draft, source, rowCount, previewRow, images],
  );
  const unknownColumns = source ? missingColumns(draft, source) : [];
  const backs = project.components.defs.filter((def) => def.kind === "cardBack");
  const willMake = source ? rowCount : 1;
  const busy = status.state === "running";

  const change = (next: Partial<CardTemplate>) => {
    setSaved(false);
    setDraft({ ...draft, ...next });
  };
  const changeData = (next: Partial<CardTemplate["data"]>) =>
    change({ data: { ...draft.data, ...next } });
  const changeField = (index: number, field: CardField) =>
    change({ fields: draft.fields.map((other, at) => (at === index ? field : other)) });
  const moveField = (index: number, by: number) => {
    const fields = [...draft.fields];
    const [moved] = fields.splice(index, 1);
    if (!moved) return;
    fields.splice(index + by, 0, moved);
    change({ fields });
  };
  const removeField = (id: string) => {
    const { [id]: _removed, ...columnsLeft } = draft.data.columns;
    change({
      fields: draft.fields.filter((field) => field.id !== id),
      data: { ...draft.data, columns: columnsLeft },
    });
  };
  const setColumn = (id: string, column: string | null) => {
    const { [id]: _old, ...rest } = draft.data.columns;
    changeData({ columns: column === null ? rest : { ...rest, [id]: column } });
  };

  const save = async (): Promise<boolean> => {
    try {
      const found = await editor.save((current) => updateTemplate(current, draft));
      setProblems(found);
      setSaved(found.length === 0);
      return found.length === 0;
    } catch {
      setProblems(["The template could not be saved on this device."]);
      return false;
    }
  };

  const generate = async () => {
    const started = performance.now();
    setStatus({ state: "running", done: 0, total: willMake });
    try {
      if (!(await save())) return setStatus({ state: "idle" });
      const latest = await editor.current();
      if (!latest) return setStatus({ state: "idle" });
      const result = await renderGeneration(
        latest.project,
        latest.assets,
        draft.id,
        (done, total) => setStatus({ state: "running", done, total }),
      );
      if (!result.ok) {
        setProblems(result.errors);
        return setStatus({ state: "idle" });
      }
      const found = await editor.saveWithImages(generationChange(result.generation));
      setProblems(found);
      setStatus(
        found.length > 0
          ? { state: "idle" }
          : {
              state: "done",
              count: result.generation.faces.length,
              seconds: (performance.now() - started) / 1000,
              warnings: result.generation.plan.warnings,
            },
      );
    } catch {
      setProblems(["The cards could not be generated on this device."]);
      setStatus({ state: "idle" });
    }
  };

  return (
    <div className={cards.editor}>
      <form
        className={styles.panel}
        aria-label={`Template ${template.name}`}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Group legend="Card">
          <div className={styles.fieldRow}>
            <TextField
              label="Template name"
              value={draft.name}
              onChange={(name) => change({ name })}
            />
            <NumberField
              label="Card width"
              unit="mm"
              min={1}
              max={500}
              value={draft.size_mm[0]}
              onChange={(width) => change({ size_mm: [width, draft.size_mm[1]] })}
            />
            <NumberField
              label="Card height"
              unit="mm"
              min={1}
              max={500}
              value={draft.size_mm[1]}
              onChange={(height) => change({ size_mm: [draft.size_mm[0], height] })}
            />
          </div>
          <div className={styles.fieldRow}>
            <ColorField
              label="Background"
              value={draft.background}
              onChange={(background) => change({ background })}
            />
            <SelectField
              label="Card back"
              value={draft.back ?? NONE}
              options={[
                {
                  value: NONE,
                  label: backs.length > 0 ? "The project's first card back" : "A new card back",
                },
                ...backs.map((back) => ({ value: back.id, label: back.name ?? back.id })),
              ]}
              onChange={(back) => change({ back: back === NONE ? null : back })}
            />
          </div>
        </Group>

        <Group legend="Data">
          <div className={styles.fieldRow}>
            <SelectField
              label="CSV file"
              value={draft.data.source ?? NONE}
              options={[
                { value: NONE, label: "None (one card from the defaults)" },
                ...project.csvSources.map((option) => ({ value: option.id, label: option.name })),
              ]}
              onChange={(value) => changeData({ source: value === NONE ? null : value })}
            />
          </div>
          {source ? (
            <div className={styles.fieldRow}>
              {(
                [
                  ["idColumn", "Card ids from"],
                  ["nameColumn", "Card names from"],
                  ["countColumn", "Copies in setup from"],
                ] as const
              ).map(([key, label]) => (
                <SelectField
                  key={key}
                  label={label}
                  value={draft.data[key] ?? NONE}
                  options={[
                    { value: NONE, label: "No column" },
                    ...columns.map((name) => ({ value: name, label: name })),
                  ]}
                  onChange={(value) => changeData({ [key]: value === NONE ? null : value })}
                />
              ))}
            </div>
          ) : null}
          {unknownColumns.length > 0 ? (
            <p className={ui.muted}>
              The CSV has no column {unknownColumns.join(", ")}; those choices are ignored.
            </p>
          ) : null}
        </Group>

        <Group legend="Fields">
          <p className={ui.muted}>
            Positions are measured from the card's top-left corner. Later fields are drawn on top.
          </p>
          <ul className={styles.defs} aria-label="Template fields">
            {draft.fields.map((field, index) => (
              <li key={field.id}>
                <details
                  open={open === field.id}
                  onToggle={(event) => {
                    const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                    if (isOpen) setOpen(field.id);
                    else if (open === field.id) setOpen(null);
                  }}
                >
                  <summary>
                    <strong>{field.label}</strong>{" "}
                    <span className={ui.muted}>
                      {FIELD_KINDS.find((entry) => entry.kind === field.kind)?.label}
                      {draft.data.columns[field.id]
                        ? ` · from ${draft.data.columns[field.id]}`
                        : ""}
                    </span>
                  </summary>
                  {open === field.id ? (
                    <section aria-label={`Field ${field.label}`}>
                      <FieldForm
                        field={field}
                        columns={columns}
                        column={draft.data.columns[field.id]}
                        images={imported}
                        onChange={(next) => changeField(index, next)}
                        onColumn={(column) => setColumn(field.id, column)}
                      />
                      <p className={`${styles.formActions} ${cards.fieldTools}`}>
                        <button
                          type="button"
                          className={`${ui.button} ${ui.secondary}`}
                          disabled={index === 0}
                          onClick={() => moveField(index, -1)}
                        >
                          Draw earlier
                        </button>
                        <button
                          type="button"
                          className={`${ui.button} ${ui.secondary}`}
                          disabled={index === draft.fields.length - 1}
                          onClick={() => moveField(index, 1)}
                        >
                          Draw later
                        </button>
                        <button
                          type="button"
                          className={`${ui.button} ${ui.secondary}`}
                          onClick={() => removeField(field.id)}
                        >
                          Remove field
                        </button>
                      </p>
                    </section>
                  ) : null}
                </details>
              </li>
            ))}
          </ul>
          <div className={styles.fieldRow}>
            <SelectField<FieldKind>
              label="New field"
              value={kind}
              options={FIELD_KINDS.map((entry) => ({ value: entry.kind, label: entry.label }))}
              onChange={setKind}
            />
            <p className={styles.formActions}>
              <button
                type="button"
                className={`${ui.button} ${ui.secondary}`}
                disabled={draft.fields.length >= 40}
                onClick={() => {
                  const field = newField(draft, kind);
                  change({ fields: [...draft.fields, field] });
                  setOpen(field.id);
                }}
              >
                Add field
              </button>
            </p>
          </div>
        </Group>

        <Problems problems={problems} />
        <p className={styles.formActions}>
          <button type="submit" className={ui.button} disabled={busy}>
            Save template
          </button>
          <button
            type="button"
            className={ui.button}
            disabled={busy}
            onClick={() => void generate()}
          >
            Generate {willMake} {willMake === 1 ? "card" : "cards"}
          </button>
          <button
            type="button"
            className={`${ui.button} ${ui.secondary}`}
            disabled={busy}
            onClick={() => void editor.save((current) => removeTemplate(current, template.id))}
          >
            Remove template
          </button>
          {saved && status.state === "idle" ? <span role="status">Saved</span> : null}
        </p>
        {status.state === "running" ? (
          <p role="status">
            <progress max={status.total} value={status.done} /> Drawing card {status.done} of{" "}
            {status.total}…
          </p>
        ) : null}
        {status.state === "done" ? (
          <div role="status">
            <p>
              Generated {status.count} {status.count === 1 ? "card" : "cards"} in{" "}
              {status.seconds.toFixed(1)} s at {CARD_DPI} dpi. They are listed under Components.
            </p>
            {status.warnings.length > 0 ? (
              <ul className={cards.warnings} aria-label="Generation warnings">
                {status.warnings.slice(0, 10).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
                {status.warnings.length > 10 ? (
                  <li>…and {status.warnings.length - 10} more</li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ) : null}
        {template.generated.length > 0 ? (
          <SetupPlacement project={project} template={template} editor={editor} images={images} />
        ) : null}
      </form>

      <aside className={cards.previewPane} aria-label="Card preview">
        <CardPreview
          template={draft}
          values={preview.values}
          images={bitmaps}
          label={`Preview of ${draft.name}${source && rowCount > 0 ? `, row ${previewRow}` : ""}`}
        />
        {source && rowCount > 0 ? (
          <div className={styles.fieldRow}>
            <NumberField
              label={`Preview row (of ${rowCount})`}
              integer
              min={1}
              max={rowCount}
              value={previewRow}
              onChange={setRow}
            />
          </div>
        ) : null}
        {preview.warnings.length > 0 ? (
          <ul className={cards.warnings} aria-label="Preview warnings">
            {preview.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        <p className={ui.muted}>
          {draft.size_mm[0]} × {draft.size_mm[1]} mm; faces are drawn at {CARD_DPI} dpi (
          {pixelSize(draft.size_mm, CARD_DPI).join(" × ")} px).
        </p>
      </aside>
    </div>
  );
}

/** Puts the generated cards into a zone of the starting setup. */
function SetupPlacement({
  project,
  template,
  editor,
  images,
}: {
  project: LocalProject;
  template: CardTemplate;
  editor: ProjectEditor;
  images: readonly string[];
}) {
  const zones = setupZoneChoices(project);
  const [zone, setZone] = useState(zones[0]?.id ?? "");
  const [face, setFace] = useState<Face>("down");
  const [shuffle, setShuffle] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const chosen = zones.some((option) => option.id === zone) ? zone : (zones[0]?.id ?? "");
  const shuffleId = useId();

  const place = async () => {
    const plan = planCards(template, findSource(project, template.data.source), images);
    const counts = new Map(plan.cards.map((card) => [card.id, card.count]));
    const total = template.generated.reduce((sum, id) => sum + (counts.get(id) ?? 1), 0);
    const found = await editor.save((current) =>
      addGeneratedToSetup(current, template.id, counts, chosen, face, shuffle),
    );
    setProblems(found);
    const label = zones.find((option) => option.id === chosen)?.label ?? chosen;
    setMessage(found.length === 0 ? `Setup places ${total} cards in ${label}.` : null);
  };

  return (
    <Group legend="Starting setup">
      {zones.length === 0 ? (
        <p className={ui.muted}>Draw a zone on the Table first, then place the cards in it.</p>
      ) : (
        <>
          <div className={styles.fieldRow}>
            <SelectField
              label="Put the generated cards in"
              value={chosen}
              options={zones.map((option) => ({ value: option.id, label: option.label }))}
              onChange={setZone}
            />
            <SelectField<Face>
              label="Facing"
              value={face}
              options={[
                { value: "down", label: "Face down" },
                { value: "up", label: "Face up" },
              ]}
              onChange={setFace}
            />
            <label className={styles.check} htmlFor={shuffleId}>
              <input
                id={shuffleId}
                type="checkbox"
                checked={shuffle}
                onChange={(event) => setShuffle(event.target.checked)}
              />
              Shuffle
            </label>
          </div>
          <Problems problems={problems} />
          <p className={styles.formActions}>
            <button type="button" className={ui.button} onClick={() => void place()}>
              Add {template.generated.length} cards to setup
            </button>
            {message ? <span role="status">{message}</span> : null}
          </p>
        </>
      )}
    </Group>
  );
}
