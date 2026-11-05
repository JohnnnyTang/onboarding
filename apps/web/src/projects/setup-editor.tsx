import type { LocalProject } from "@bgp/schema";
import { useRef, useState } from "react";
import { ui } from "../components/ui";
import { NumberField, Problems, SelectField } from "./fields";
import { type SetupInstance, setInstances, setupZoneChoices } from "./project-model";
import styles from "./projects.module.css";
import type { ProjectEditor } from "./use-project";

/** The starting table: which components start in which zone, how many, and how. */
export function SetupEditor({ project, editor }: { project: LocalProject; editor: ProjectEditor }) {
  const [problems, setProblems] = useState<string[]>([]);
  const stored = project.components.setup?.instances ?? EMPTY;
  // While this editor is open its draft is the truth: nothing else on the screen edits setup
  // lines. Edits show at once and build on each other, and saves run in order behind them.
  // Following the stored lines instead would let a late render of an older save undo a
  // newer edit. A refused save goes back to the last lines that were saved.
  const [instances, setDraft] = useState(stored);
  const draft = useRef(stored);
  const accepted = useRef(stored);
  const pieces = project.components.defs.filter((def) => def.kind !== "cardBack");
  const zones = setupZoneChoices(project);

  const save = (next: SetupInstance[]) => {
    draft.current = next;
    setDraft(next);
    const settle = (problems: string[]) => {
      setProblems(problems);
      if (problems.length === 0) accepted.current = next;
      else if (draft.current === next) {
        draft.current = accepted.current;
        setDraft(accepted.current);
      }
    };
    editor
      .save((current) => setInstances(current, next))
      .then(settle, () => settle(["The change could not be saved on this device."]));
  };
  /** Applies a change to the newest version of a line, never to what a render saw. */
  const change = (index: number, update: (line: SetupInstance) => SetupInstance) =>
    save(draft.current.map((line, at) => (at === index ? update(line) : line)));

  const first = pieces[0];
  const firstZone = zones[0];
  return (
    <section className={styles.panel} aria-label="Starting setup">
      <p className={ui.muted}>
        Each line puts components into a zone when a game starts. A line for a zone that each seat
        gets fills every seat's copy. Shuffled zones are shuffled once, after every line has been
        placed.
      </p>
      {instances.length === 0 ? <p className={ui.muted}>The table starts empty.</p> : null}
      <ol className={styles.setupList} aria-label="Setup lines">
        {instances.map((instance, index) => (
          // Lines have no identity of their own; their position is their key.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <li key={index} aria-label={`Setup line ${index + 1}`}>
            <SelectField
              label="Component"
              value={instance.def}
              options={pieces.map((def) => ({ value: def.id, label: def.name ?? def.id }))}
              onChange={(def) => change(index, (line) => ({ ...line, def }))}
            />
            <SelectField
              label="Zone"
              value={instance.zone}
              options={zones.map((zone) => ({ value: zone.id, label: zone.label }))}
              onChange={(zone) => change(index, (line) => ({ ...line, zone }))}
            />
            <NumberField
              label="Count"
              integer
              min={1}
              max={500}
              value={instance.count ?? 1}
              onChange={(count) => change(index, (line) => ({ ...line, count }))}
            />
            <SelectField
              label="Face"
              value={instance.face ?? "up"}
              options={[
                { value: "up", label: "Face up" },
                { value: "down", label: "Face down" },
              ]}
              onChange={(face) => change(index, (line) => ({ ...line, face }))}
            />
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={instance.shuffle ?? false}
                onChange={(event) => {
                  const shuffle = event.target.checked;
                  change(index, ({ shuffle: _shuffle, ...rest }) =>
                    shuffle ? { ...rest, shuffle: true } : rest,
                  );
                }}
              />
              Shuffle the zone
            </label>
            <button
              type="button"
              className={`${ui.button} ${ui.secondary}`}
              onClick={() => save(draft.current.filter((_, at) => at !== index))}
            >
              Remove line
            </button>
          </li>
        ))}
      </ol>
      <Problems problems={problems} />
      {first && firstZone ? (
        <button
          type="button"
          className={ui.button}
          onClick={() => save([...draft.current, { def: first.id, zone: firstZone.id, count: 1 }])}
        >
          Add setup line
        </button>
      ) : (
        <p className={ui.muted}>Add a component and a zone before setting up the table.</p>
      )}
    </section>
  );
}

const EMPTY: SetupInstance[] = [];
