/**
 * Evaluates a game bundle (one ES module without imports, checked at finalize) and returns
 * its default export. Call only after `lockDownGlobals`: the module's top level runs here.
 *
 * This is the one place in the web app that imports a computed URL; the package-boundary
 * check allows it in this file only.
 */
export async function importGameModule(source: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const module = (await import(/* @vite-ignore */ url)) as { default?: unknown };
    return module.default;
  } finally {
    URL.revokeObjectURL(url);
  }
}
