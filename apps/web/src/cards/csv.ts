import { MAX_CSV_CELL_LENGTH, MAX_CSV_COLUMNS, MAX_CSV_ROWS } from "@bgp/schema";
import Papa from "papaparse";

// CSV files for the card generator (contracts/card-generator.md#csv-source). Papa Parse
// (tech-stack default) stays behind `parseCsv`; it runs on the page, never in its worker
// mode, so no extra scripts are loaded.

export const MAX_CSV_BYTES = 1024 * 1024;

export interface CsvTable {
  columns: string[];
  rows: string[][];
}

export type CsvResult = { ok: true; table: CsvTable } | { ok: false; problems: string[] };

const MAX_REPORTED = 5;

/**
 * Parses CSV text: the first row names the columns, fully empty rows are skipped, cells are
 * trimmed, short rows are padded and long rows refused. The delimiter is detected
 * (comma, semicolon or tab).
 */
export function parseCsv(text: string): CsvResult {
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), {
    header: false,
    skipEmptyLines: "greedy",
    delimitersToGuess: [",", ";", "\t"],
  });
  const problems = parsed.errors
    .filter((error) => error.type !== "Delimiter")
    .map((error) =>
      error.row === undefined ? error.message : `Row ${error.row + 1}: ${error.message}`,
    );
  const [header, ...body] = parsed.data.map((row) => row.map((value) => value.trim()));
  if (!header) return { ok: false, problems: ["The file has no header row."] };

  const columns = header;
  if (columns.length > MAX_CSV_COLUMNS) problems.push(`More than ${MAX_CSV_COLUMNS} columns.`);
  if (columns.some((column) => column === "")) problems.push("Every column needs a name.");
  const duplicates = columns.filter((column, index) => columns.indexOf(column) !== index);
  if (duplicates.length > 0) {
    problems.push(`Column names repeat: ${[...new Set(duplicates)].join(", ")}.`);
  }
  if (columns.some((column) => column.length > 80)) {
    problems.push("Column names are at most 80 characters.");
  }
  if (body.length > MAX_CSV_ROWS) problems.push(`More than ${MAX_CSV_ROWS} rows.`);

  const rows: string[][] = [];
  for (const [index, row] of body.entries()) {
    const line = index + 2;
    if (row.length > columns.length) {
      problems.push(`Row ${line} has ${row.length} cells for ${columns.length} columns.`);
      continue;
    }
    if (row.some((value) => value.length > MAX_CSV_CELL_LENGTH)) {
      problems.push(`Row ${line} has a cell longer than ${MAX_CSV_CELL_LENGTH} characters.`);
      continue;
    }
    rows.push([...row, ...Array<string>(columns.length - row.length).fill("")]);
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_REPORTED);
    if (problems.length > MAX_REPORTED) shown.push(`…and ${problems.length - MAX_REPORTED} more.`);
    return { ok: false, problems: shown };
  }
  return { ok: true, table: { columns, rows } };
}

/** Reads a chosen CSV file, refusing files over 1 MB. */
export async function readCsvFile(file: Blob & { name: string }): Promise<CsvResult> {
  if (file.size > MAX_CSV_BYTES) {
    return { ok: false, problems: [`${file.name} is larger than 1 MB.`] };
  }
  return parseCsv(await file.text());
}
