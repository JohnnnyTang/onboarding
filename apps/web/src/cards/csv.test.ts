import { describe, expect, it } from "vitest";
import { parseCsv, readCsvFile } from "./csv";

describe("CSV import", () => {
  it("reads a header and rows, trimming cells and padding short rows", () => {
    expect(parseCsv("﻿id, name ,value\nfish-1,Fish,1\n\n  ,  ,  \nsalt-1,Salt\n")).toEqual({
      ok: true,
      table: {
        columns: ["id", "name", "value"],
        rows: [
          ["fish-1", "Fish", "1"],
          ["salt-1", "Salt", ""],
        ],
      },
    });
  });

  it("keeps quoted commas and line breaks, and detects semicolons", () => {
    expect(parseCsv('name;text\nFish;"Catch, then\nsell"\n')).toEqual({
      ok: true,
      table: { columns: ["name", "text"], rows: [["Fish", "Catch, then\nsell"]] },
    });
  });

  it.each([
    ["an empty file", "", "The file has no header row."],
    ["a blank column name", "id,,x\n1,2,3", "Every column needs a name."],
    ["repeated column names", "id,id\n1,2", "Column names repeat: id."],
    ["a row with extra cells", "id,name\n1,2,3", "Row 2 has 3 cells for 2 columns."],
  ])("refuses %s", (_name, text, problem) => {
    const result = parseCsv(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems).toContain(problem);
  });

  it("refuses more rows than a source may hold, and files over 1 MB", async () => {
    const many = `n\n${"1\n".repeat(2001)}`;
    expect(parseCsv(many)).toEqual({ ok: false, problems: ["More than 2000 rows."] });
    const big = Object.assign(new Blob(["x".repeat(1024 * 1024 + 1)]), { name: "big.csv" });
    expect(await readCsvFile(big)).toEqual({
      ok: false,
      problems: ["big.csv is larger than 1 MB."],
    });
  });
});
