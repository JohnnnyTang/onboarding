import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PageErrorBoundary } from "./error-boundary";

describe("page error boundary", () => {
  test("shows the page until it throws, then a reload offer without the error", () => {
    expect(
      renderToStaticMarkup(
        <PageErrorBoundary>
          <p>Fine</p>
        </PageErrorBoundary>,
      ),
    ).toBe("<p>Fine</p>");
    expect(PageErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new PageErrorBoundary({ children: <p>Secret hand</p> });
    boundary.state = PageErrorBoundary.getDerivedStateFromError();
    const html = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(html).toContain("This page stopped working");
    expect(html).toContain("Reload");
    expect(html).not.toContain("Secret hand");
  });
});
