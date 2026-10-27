import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { filesUnder, isInside, slash } from "./files.js";

interface Policy {
  imports: readonly string[];
  node?: boolean;
  pure?: boolean;
}

// Runtime dependencies are admitted here when their owning task installs them.
// Test tooling is allowed only in test files, never in game/runtime sources.
const POLICIES: Record<string, Policy> = {
  "packages/schema": { imports: ["zod"], pure: true },
  "packages/rules": { imports: ["@bgp/schema", "immer"], pure: true },
  "packages/testing": { imports: ["@bgp/rules", "@bgp/schema"], node: true },
  "packages/rules-host": { imports: ["@bgp/schema", "quickjs-emscripten"], node: true },
  "packages/table-2d": { imports: ["@bgp/schema", "pixi.js"] },
  "packages/card-generator": { imports: ["@bgp/schema"] },
  "packages/cli": { imports: ["@bgp/rules", "@bgp/schema", "@bgp/testing", "esbuild"], node: true },
  "apps/web": { imports: ["@bgp/schema", "@bgp/table-2d", "@bgp/card-generator"] },
  "apps/server": {
    imports: ["@bgp/schema", "@bgp/rules-host", "drizzle-orm", "postgres"],
    node: true,
  },
};
const GAME_POLICY: Policy = { imports: ["@bgp/rules", "@bgp/schema"], pure: true };
const NODE_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const FORBIDDEN_GLOBALS = new Set([
  "Date",
  "process",
  "Buffer",
  "require",
  "window",
  "document",
  "navigator",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "indexedDB",
  "caches",
  "BroadcastChannel",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "queueMicrotask",
  "performance",
  "crypto",
  "globalThis",
  "global",
  "self",
]);

function packageName(specifier: string): string {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : (specifier.split("/")[0] ?? specifier);
}

function typeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) return node.isTypeOnly;
  if (node.importClause?.isTypeOnly) return true;
  const bindings = node.importClause?.namedBindings;
  return (
    !node.importClause?.name &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

export function checkSource(root: string, file: string, source: string): string[] {
  const path = slash(relative(root, file));
  const owner = path.split("/").slice(0, 2).join("/");
  const candidate = path.startsWith("games/") ? GAME_POLICY : POLICIES[owner];
  if (!candidate) return [];
  const policy: Policy = candidate;
  const testFile = /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(path) || path.includes("/test/");
  const worker =
    owner === "apps/web" && (path.includes("/src/workers/") || /\.worker\.ts$/.test(path));
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  function report(node: ts.Node, message: string): void {
    const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    errors.push(`${path}:${line + 1}: ${message}`);
  }
  function checkImport(node: ts.Node, specifier: string, onlyTypes = false): void {
    if (specifier.startsWith(".")) {
      if (!isInside(resolve(root, owner), resolve(dirname(file), specifier))) {
        report(
          node,
          "Relative imports must stay inside their package; use a public workspace export.",
        );
      }
      return;
    }
    const name = packageName(specifier);
    if (testFile && (name === "vitest" || name === "fast-check")) return;
    if (path === "apps/server/drizzle.config.ts" && name === "drizzle-kit") return;
    if (path === "apps/server/vitest.config.ts" && name === "vitest") return;
    if (specifier.startsWith("node:") || NODE_MODULES.has(specifier)) {
      if (!policy.node) report(node, `Node import ${specifier} is forbidden in ${owner}.`);
      return;
    }
    if (worker && name === "@bgp/rules") return;
    if (owner === "packages/rules-host" && name === "@bgp/rules" && onlyTypes) return;
    if (!policy.imports.includes(name)) {
      report(node, `Import ${specifier} is outside the allowed dependencies of ${owner}.`);
    } else if (path.startsWith("games/") && name === "@bgp/schema" && !onlyTypes) {
      report(node, "Games may import @bgp/schema types only; use SDK helpers from @bgp/rules.");
    }
  }
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      checkImport(node, node.moduleSpecifier.text, typeOnly(node));
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (expression && ts.isStringLiteralLike(expression))
        checkImport(node, expression.text, node.isTypeOnly);
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      checkImport(node, node.argument.literal.text, true);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) checkImport(node, argument.text);
      else report(node, "Computed module imports cannot be checked against package boundaries.");
    }
    if (policy.pure && !testFile && ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      // Property names such as { process: ... } are data, not access to a host global.
      const parent = node.parent;
      const propertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node);
      // D-006 permits the deterministic SHA-256 capability in this one module.
      // No entropy APIs (including getRandomValues) are admitted by this exception.
      const hashCapability =
        path === "packages/rules/src/hash.ts" &&
        node.text === "crypto" &&
        ((ts.isVariableDeclaration(parent) && parent.name === node) ||
          (ts.isPropertyAccessExpression(parent) && parent.name.text === "subtle"));
      if (!propertyName && !hashCapability) report(node, `Pure code must not access ${node.text}.`);
    }
    if (
      policy.pure &&
      !testFile &&
      ((ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Math" &&
        node.name.text === "random") ||
        (ts.isElementAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "Math" &&
          node.argumentExpression &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === "random"))
    ) {
      report(node, "Randomness must come from ctx.random, never Math.random.");
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return errors;
}

export async function checkBoundaries(root: string): Promise<string[]> {
  const files = await filesUnder(
    root,
    new Set([
      "node_modules",
      ".git",
      ".turbo",
      "dist",
      "coverage",
      ".scratch",
      ".tools",
      "test-results",
      "playwright-report",
    ]),
  );
  const errors: string[] = [];
  for (const file of files.filter((path) => /\.[cm]?[jt]sx?$/.test(path))) {
    errors.push(...checkSource(root, file, await readFile(file, "utf8")));
  }
  return errors;
}

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = await checkBoundaries(root);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.info("Package boundaries passed.");
}
