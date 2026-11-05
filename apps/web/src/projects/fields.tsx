import { useEffect, useId, useState } from "react";
import styles from "./projects.module.css";

/**
 * A number input that keeps what the designer types. It reports a value only when the text
 * is a number within range, so half-typed input never reaches the project.
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  integer = false,
  unit,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  integer?: boolean;
  unit?: string;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((current) => (Number(current) === value ? current : String(value)));
  }, [value]);
  const parsed = Number(text);
  const valid =
    text.trim() !== "" &&
    Number.isFinite(parsed) &&
    (!integer || Number.isInteger(parsed)) &&
    (min === undefined || parsed >= min) &&
    (max === undefined || parsed <= max);
  return (
    <div className={styles.field}>
      <label htmlFor={id}>
        {label}
        {unit ? <span className={styles.unit}> ({unit})</span> : null}
      </label>
      <input
        id={id}
        type="number"
        inputMode={integer ? "numeric" : "decimal"}
        step={integer ? 1 : "any"}
        min={min}
        max={max}
        value={text}
        aria-invalid={!valid}
        onChange={(event) => {
          setText(event.target.value);
          const next = Number(event.target.value);
          if (
            event.target.value.trim() !== "" &&
            Number.isFinite(next) &&
            (!integer || Number.isInteger(next)) &&
            (min === undefined || next >= min) &&
            (max === undefined || next <= max)
          ) {
            onChange(next);
          }
        }}
      />
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  maxLength = 80,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Chooses one of the project's images; a path that is not imported shows as missing. */
export function ImageField({
  label,
  value,
  images,
  onChange,
}: {
  label: string;
  value: string;
  images: readonly string[];
  onChange(path: string): void;
}) {
  const options = images.includes(value)
    ? images.map((path) => ({ value: path, label: path.replace(/^assets\//, "") }))
    : [
        { value, label: `${value.replace(/^assets\//, "")} (missing)` },
        ...images.map((path) => ({ value: path, label: path.replace(/^assets\//, "") })),
      ];
  return <SelectField label={label} value={value} options={options} onChange={onChange} />;
}

export function Problems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className={styles.problems} role="alert">
      {problems.map((problem) => (
        <li key={problem}>{problem}</li>
      ))}
    </ul>
  );
}
