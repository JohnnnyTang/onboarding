import { expect, test } from "vitest";
import * as schema from "./index.js";

test("the public package exposes contract validators", () => {
  expect(schema.PROTOCOL_VERSION).toBe(1);
  expect(schema.ManifestSchema).toBeDefined();
});
