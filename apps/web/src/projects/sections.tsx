import type { ComponentDef, LocalProject } from "@bgp/schema";
import { type FormEvent, useId, useState } from "react";
import { ui } from "../components/ui";
import { ImageField, NumberField, Problems, SelectField, TextField } from "./fields";
import { IMAGE_ACCEPT } from "./images";
import {
  addComponent,
  COMPONENT_KINDS,
  type ComponentKind,
  MAX_PLAYERS,
  missingImages,
  PLACEHOLDER_IMAGE,
  removalBlocker,
  removeComponent,
  updateComponent,
  updateDetails,
  usedImages,
} from "./project-model";
import styles from "./projects.module.css";
import type { ProjectEditor } from "./use-project";

export interface SectionProps {
  project: LocalProject;
  editor: ProjectEditor;
  images: readonly string[];
}

function useSaver(editor: ProjectEditor) {
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const run = async (change: (current: LocalProject) => LocalProject) => {
    setSaved(false);
    try {
      const found = await editor.save(change);
      setProblems(found);
      setSaved(found.length === 0);
      return found.length === 0;
    } catch {
      setProblems(["The change could not be saved on this device."]);
      return false;
    }
  };
  return { problems, saved, run };
}

export function DetailsSection({ project, editor }: SectionProps) {
  const [draft, setDraft] = useState({
    name: project.name,
    playersMin: project.manifest.players.min,
    playersMax: project.manifest.players.max,
    description: project.manifest.description ?? "",
  });
  const { problems, saved, run } = useSaver(editor);
  const descriptionId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run((current) => updateDetails(current, draft));
  };
  return (
    <form className={styles.panel} onSubmit={submit} aria-label="Game details">
      <TextField
        label="Name"
        value={draft.name}
        onChange={(name) => setDraft({ ...draft, name })}
      />
      <div className={styles.fieldRow}>
        <NumberField
          label="Fewest players"
          integer
          min={1}
          max={MAX_PLAYERS}
          value={draft.playersMin}
          onChange={(playersMin) => setDraft({ ...draft, playersMin })}
        />
        <NumberField
          label="Most players"
          integer
          min={1}
          max={MAX_PLAYERS}
          value={draft.playersMax}
          onChange={(playersMax) => setDraft({ ...draft, playersMax })}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor={descriptionId}>Description</label>
        <textarea
          id={descriptionId}
          rows={3}
          maxLength={2000}
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </div>
      <Problems problems={problems} />
      <p className={styles.formActions}>
        <button type="submit" className={ui.button}>
          Save details
        </button>
        {saved ? <span role="status">Saved</span> : null}
      </p>
    </form>
  );
}

export function ImagesSection({ project, editor }: SectionProps) {
  const inputId = useId();
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const used = usedImages(project);
  const assets = editor.data.status === "ready" ? editor.data.assets : [];
  const missing = missingImages(
    project,
    assets.map((asset) => asset.path),
  );
  return (
    <section className={styles.panel} aria-label="Images">
      <div className={styles.field}>
        <label htmlFor={inputId}>Import images (PNG, JPEG, WebP or AVIF, up to 5 MB each)</label>
        <input
          id={inputId}
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          disabled={busy}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length === 0) return;
            setBusy(true);
            void editor
              .importImages(files)
              .then(setProblems, () => setProblems(["The images could not be saved."]))
              .finally(() => setBusy(false));
          }}
        />
      </div>
      <Problems problems={problems} />
      {missing.length > 0 ? (
        <p className={ui.muted}>
          Components use images you have not imported yet: {missing.join(", ")}. The table shows a
          labeled placeholder for them.
        </p>
      ) : null}
      {assets.length === 0 ? (
        <p className={ui.muted}>No images yet.</p>
      ) : (
        <ul className={styles.images} aria-label="Project images">
          {assets.map((asset) => (
            <li key={asset.path}>
              <img src={editor.urls.get(asset.path)} alt="" />
              <span className={styles.imageName}>{asset.path.replace(/^assets\//, "")}</span>
              <span className={ui.muted}>
                {Math.max(1, Math.round(asset.size / 1024))} KB
                {used.has(asset.path) ? " · in use" : ""}
              </span>
              <button
                type="button"
                className={`${ui.button} ${ui.secondary}`}
                aria-label={`Remove ${asset.path}`}
                onClick={() => void editor.removeImage(asset.path)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ComponentsSection({ project, editor, images }: SectionProps) {
  const [kind, setKind] = useState<ComponentKind>("card");
  const [open, setOpen] = useState<string | null>(null);
  const { problems, run } = useSaver(editor);
  const add = async () => {
    let id = "";
    const added = await run((current) => {
      const result = addComponent(current, kind, images[0] ?? PLACEHOLDER_IMAGE);
      id = result.id;
      return result.project;
    });
    if (added) setOpen(id);
  };
  return (
    <section className={styles.panel} aria-label="Components">
      <div className={styles.fieldRow}>
        <SelectField<ComponentKind>
          label="Kind"
          value={kind}
          options={COMPONENT_KINDS.map((entry) => ({ value: entry.kind, label: entry.label }))}
          onChange={(value) => setKind(value)}
        />
        <p className={styles.formActions}>
          <button type="button" className={ui.button} onClick={() => void add()}>
            Add component
          </button>
        </p>
      </div>
      <Problems problems={problems} />
      {project.components.defs.length === 0 ? (
        <p className={ui.muted}>No components yet. Cards, tokens, dice, boards and pieces.</p>
      ) : (
        <ul className={styles.defs} aria-label="Component list">
          {project.components.defs.map((def) => (
            <li key={def.id}>
              <details
                open={open === def.id}
                onToggle={(event) => {
                  const isOpen = (event.currentTarget as HTMLDetailsElement).open;
                  if (isOpen) setOpen(def.id);
                  else if (open === def.id) setOpen(null);
                }}
              >
                <summary>
                  <strong>{def.name ?? def.id}</strong>{" "}
                  <span className={ui.muted}>
                    {COMPONENT_KINDS.find((entry) => entry.kind === def.kind)?.label} · {def.id}
                  </span>
                </summary>
                {open === def.id ? (
                  <ComponentForm
                    key={def.id}
                    project={project}
                    def={def}
                    editor={editor}
                    images={images}
                  />
                ) : null}
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const SIDES = [4, 6, 8, 10, 12, 20] as const;

function ComponentForm({
  project,
  def,
  editor,
  images,
}: {
  project: LocalProject;
  def: ComponentDef;
  editor: ProjectEditor;
  images: readonly string[];
}) {
  const [draft, setDraft] = useState<ComponentDef>(def);
  const { problems, saved, run } = useSaver(editor);
  const blocker = removalBlocker(project, def.id);
  const backs = project.components.defs.filter((other) => other.kind === "cardBack");
  const set = (change: Partial<ComponentDef>) => setDraft({ ...draft, ...change } as ComponentDef);
  const size2 = (label: string, value: [number, number], update: (v: [number, number]) => void) => (
    <div className={styles.fieldRow}>
      <NumberField
        label={`${label} width`}
        unit="mm"
        min={0.1}
        value={value[0]}
        onChange={(w) => update([w, value[1]])}
      />
      <NumberField
        label={`${label} height`}
        unit="mm"
        min={0.1}
        value={value[1]}
        onChange={(h) => update([value[0], h])}
      />
    </div>
  );
  return (
    <form
      className={styles.defForm}
      aria-label={`Edit ${def.name ?? def.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        void run((current) => updateComponent(current, draft));
      }}
    >
      <TextField label="Name" value={draft.name ?? ""} onChange={(name) => set({ name })} />
      {draft.kind === "card" ? (
        <>
          {size2("Card", draft.size_mm, (size_mm) => set({ size_mm }))}
          <ImageField
            label="Front image"
            value={draft.front}
            images={images}
            onChange={(front) => set({ front })}
          />
          <SelectField
            label="Back"
            value={draft.back}
            options={backs.map((back) => ({ value: back.id, label: back.name ?? back.id }))}
            onChange={(back) => set({ back })}
          />
        </>
      ) : null}
      {draft.kind === "cardBack" || draft.kind === "board" || draft.kind === "piece" ? (
        <ImageField
          label="Image"
          value={draft.image}
          images={images}
          onChange={(image) => set({ image })}
        />
      ) : null}
      {draft.kind === "board" ? size2("Board", draft.size_mm, (size_mm) => set({ size_mm })) : null}
      {draft.kind === "piece" ? (
        <div className={styles.fieldRow}>
          {(["Width", "Depth", "Height"] as const).map((label, axis) => (
            <NumberField
              key={label}
              label={label}
              unit="mm"
              min={0.1}
              value={draft.size_mm[axis] ?? 1}
              onChange={(value) => {
                const size_mm: [number, number, number] = [...draft.size_mm];
                size_mm[axis] = value;
                set({ size_mm });
              }}
            />
          ))}
        </div>
      ) : null}
      {draft.kind === "token" ? (
        <>
          <SelectField
            label="Shape"
            value={draft.shape}
            options={[
              { value: "circle", label: "Circle" },
              { value: "square", label: "Square" },
              { value: "rect", label: "Rectangle" },
              { value: "hex", label: "Hexagon" },
            ]}
            onChange={(shape) => set({ shape })}
          />
          {size2("Token", draft.size_mm, (size_mm) => set({ size_mm }))}
          <ImageField
            label="Front image"
            value={draft.front}
            images={images}
            onChange={(front) => set({ front })}
          />
        </>
      ) : null}
      {draft.kind === "die" ? (
        <div className={styles.fieldRow}>
          <SelectField
            label="Sides"
            value={String(draft.sides)}
            options={SIDES.map((sides) => ({ value: String(sides), label: `d${sides}` }))}
            onChange={(sides) => {
              const { faces: _faces, ...rest } = draft;
              setDraft({ ...rest, sides: Number(sides) as (typeof SIDES)[number] });
            }}
          />
          <NumberField
            label="Size"
            unit="mm"
            min={1}
            value={draft.size_mm}
            onChange={(size_mm) => set({ size_mm })}
          />
          <TextField
            label="Color"
            value={draft.color ?? ""}
            maxLength={40}
            onChange={(color) => {
              const { color: _color, ...rest } = draft;
              setDraft(color.trim() === "" ? rest : { ...rest, color: color.trim() });
            }}
          />
        </div>
      ) : null}
      <Problems problems={problems} />
      <p className={styles.formActions}>
        <button type="submit" className={ui.button}>
          Save component
        </button>
        <button
          type="button"
          className={`${ui.button} ${ui.secondary}`}
          disabled={blocker !== null}
          title={blocker ?? undefined}
          onClick={() => void run((current) => removeComponent(current, def.id))}
        >
          Remove component
        </button>
        {saved ? <span role="status">Saved</span> : null}
      </p>
      {blocker ? <p className={ui.muted}>{blocker}.</p> : null}
    </form>
  );
}
