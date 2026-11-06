import { describe, expect, it } from "vitest";
import { findModuleImports } from "../src/index.js";

describe("findModuleImports", () => {
  it.each([
    ['import { a } from "./a.js";', "Bundles may not contain import statements"],
    ['import "./side-effect.js";', "Bundles may not contain import statements"],
    ["import * as all from 'x';", "Bundles may not contain import statements"],
    ["import def from 'x';", "Bundles may not contain import statements"],
    ["const m = import('node:fs');", "Bundles may not use dynamic import()"],
    ["const u = import.meta.url;", "Bundles may not use import.meta"],
    ["export * from './a.js';", "Bundles may not re-export other modules"],
    ["export { a as b } from './a.js';", "Bundles may not re-export other modules"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source under test
    ["const x = `${1}`; import('a');", "Bundles may not use dynamic import()"],
  ])("finds %s", (source, message) => {
    expect(findModuleImports(source)).toEqual([message]);
  });

  it.each([
    "export default { sdk: 1 };",
    "const a = 1; export { a as default };",
    "// import x from 'y';\nexport default {};",
    "/* import('x') */ export default {};",
    'const s = "import x from y"; export default s;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source under test
    "const t = `import ${'{'} a } from 'b'`; export default t;",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source under test
    "const t = `outer ${`inner import('x')`} end`; export default t;",
    "const r = /import\\s+x/g; export default r;",
    "const r = x / 2 / 3; const o = { import: 1 }; o.import; export default r;",
    "if (a) /import('x')/.test(s); export default 1;",
  ])("accepts %s", (source) => {
    expect(findModuleImports(source)).toEqual([]);
  });
});
