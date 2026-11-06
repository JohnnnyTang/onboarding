/**
 * Finds module imports in a game bundle so finalize can report a specific error.
 *
 * This is a diagnostic, not the security boundary: the QuickJS sandbox has no module
 * loader, so a bundle that slips an import past this scan still fails the setup check.
 * The tokenizer skips comments, strings, template literals and regular expressions,
 * using the usual previous-token rule to tell a regular expression from division.
 */

/** `control` marks the `)` closing `if (…)`, `while (…)`, `for (…)` or `with (…)`. */
type Token = { kind: "word" | "punct" | "string"; value: string; control?: boolean };
const CONTROL_WORDS = new Set(["if", "while", "for", "with"]);

const REGEX_AFTER_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function isWordStart(char: string): boolean {
  return /[A-Za-z_$\u0080-￿]/.test(char);
}
function isWordPart(char: string): boolean {
  return /[A-Za-z0-9_$\u0080-￿]/.test(char);
}

function regexAllowed(previous: Token | undefined): boolean {
  if (!previous) return true;
  if (previous.kind === "string") return false;
  if (previous.kind === "word") return REGEX_AFTER_WORDS.has(previous.value);
  if (previous.control) return true;
  return ![")", "]", "}"].includes(previous.value);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  // Brace depth at which each open template literal resumes after `${ ... }`.
  const templates: number[] = [];
  // For each open parenthesis: whether it follows a control keyword.
  const parens: boolean[] = [];
  let depth = 0;
  let index = 0;

  function skipString(quote: string): void {
    index++;
    while (index < source.length && source[index] !== quote) {
      if (source[index] === "\\") index++;
      if (source[index] === "\n") return;
      index++;
    }
    index++;
  }
  /** Reads template text; returns true when it stopped at `${`. */
  function skipTemplate(): boolean {
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") index += 2;
      else if (char === "`") {
        index++;
        return false;
      } else if (char === "$" && source[index + 1] === "{") {
        index += 2;
        return true;
      } else index++;
    }
    return false;
  }
  function skipRegex(): void {
    index++;
    let inClass = false;
    while (index < source.length) {
      const char = source[index];
      if (char === "\\") index++;
      else if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) break;
      else if (char === "\n") return;
      index++;
    }
    index++;
    while (index < source.length && isWordPart(source[index] ?? "")) index++;
  }
  function enterTemplate(): void {
    if (skipTemplate()) {
      templates.push(depth);
      depth++;
    }
    tokens.push({ kind: "string", value: "`" });
  }

  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1];
    if (/\s/.test(char)) index++;
    else if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
    } else if (char === '"' || char === "'") {
      skipString(char);
      tokens.push({ kind: "string", value: char });
    } else if (char === "`") {
      index++;
      enterTemplate();
    } else if (char === "/" && regexAllowed(tokens.at(-1))) {
      skipRegex();
      tokens.push({ kind: "string", value: "/" });
    } else if (isWordStart(char)) {
      const start = index;
      while (index < source.length && isWordPart(source[index] ?? "")) index++;
      tokens.push({ kind: "word", value: source.slice(start, index) });
    } else if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(next ?? ""))) {
      while (index < source.length && /[0-9A-Za-z_.]/.test(source[index] ?? "")) index++;
      tokens.push({ kind: "word", value: "0" });
    } else {
      index++;
      if (char === "?" && next === ".") {
        index++;
        tokens.push({ kind: "punct", value: "?." });
        continue;
      }
      if (char === "(") {
        const previous = tokens.at(-1);
        parens.push(previous?.kind === "word" && CONTROL_WORDS.has(previous.value));
      }
      if (char === ")" && parens.pop()) {
        tokens.push({ kind: "punct", value: char, control: true });
        continue;
      }
      if (char === "{") depth++;
      if (char === "}") {
        depth--;
        if (templates.at(-1) === depth) {
          templates.pop();
          enterTemplate();
          continue;
        }
      }
      tokens.push({ kind: "punct", value: char });
    }
  }
  return tokens;
}

/** Messages for each import or re-export found; empty when the bundle is import-free. */
export function findModuleImports(source: string): string[] {
  const tokens = tokenize(source);
  const found = new Set<string>();
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== "word") continue;
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const property = previous?.value === "." || previous?.value === "?." || next?.value === ":";
    if (token.value === "import" && !property) {
      if (next?.value === "(") found.add("Bundles may not use dynamic import()");
      else if (next?.value === ".") found.add("Bundles may not use import.meta");
      else found.add("Bundles may not contain import statements");
    }
    if (token.value === "export" && !property) {
      if (next?.value === "*") found.add("Bundles may not re-export other modules");
      if (next?.value === "{") {
        const close = tokens.findIndex((candidate, at) => at > index && candidate.value === "}");
        if (close > 0 && tokens[close + 1]?.value === "from") {
          found.add("Bundles may not re-export other modules");
        }
      }
    }
  }
  return [...found];
}
