import { expect, test } from "vitest";
import { SandboxViewSchema } from "./table.js";

test("sandbox view accepts hidden identities but rejects non-JSON data and extra secrets", () => {
  const hidden = {
    id: "opaque",
    zone: "deck",
    index: 0,
    rotation_deg: 0,
    face: "down",
    back: "back",
  };
  expect(SandboxViewSchema.safeParse({ items: [hidden] }).success).toBe(true);
  for (const item of [
    { ...hidden, rotation_deg: 0.5 },
    { ...hidden, def: undefined },
    { ...hidden, secret: "fish" },
  ]) {
    expect(SandboxViewSchema.safeParse({ items: [item] }).success).toBe(false);
  }
});
