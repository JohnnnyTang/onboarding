import { expect, test } from "vitest";
import { config } from "zod";

test("the jitless entry turns off Zod's compiled parsers before schemas are built", async () => {
  expect(config().jitless).not.toBe(true);
  await import("../src/jitless.js");
  expect(config().jitless).toBe(true);
  // Schemas still parse, without `new Function`.
  const { ManifestSchema } = await import("../src/index.js");
  expect(ManifestSchema.safeParse({}).success).toBe(false);
});
