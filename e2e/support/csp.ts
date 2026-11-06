import type { BrowserContext, Page } from "@playwright/test";

export interface Violation {
  directive: string;
  blocked: string;
  source: string;
}

/**
 * Records the page's content security policy violations (`securitypolicyviolation` events)
 * in every page of the context (or in one page). Read them with {@link violations}. Violations inside a
 * worker fire on the worker, not the page; tests cover workers by using them.
 */
export async function recordViolations(target: BrowserContext | Page): Promise<void> {
  await target.addInitScript(() => {
    const seen: { directive: string; blocked: string; source: string }[] = [];
    Object.defineProperty(window, "__bgpViolations", { value: seen });
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        source: `${event.sourceFile}:${event.lineNumber}`,
      });
    });
  });
}

/** Violations recorded so far in every open page of the context. */
export async function violations(context: BrowserContext): Promise<Violation[]> {
  const lists = await Promise.all(
    context
      .pages()
      .map((page) =>
        page.evaluate(
          () => (window as unknown as { __bgpViolations?: Violation[] }).__bgpViolations ?? [],
        ),
      ),
  );
  return lists.flat();
}
