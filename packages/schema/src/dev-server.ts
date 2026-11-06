import { z } from "zod";
import { NonnegativeIntegerSchema } from "./common.js";
import { ValidationErrorSchema } from "./http.js";
import { ManifestSchema } from "./manifest.js";
import { ComponentsFileSchema } from "./table.js";
import { MAX_BUNDLE_BYTES } from "./version-files.js";

// What `bgp dev` serves to the web app's /dev page (contracts/dev-server.md).

export const DEV_SERVER_PROTOCOL = 1;

/**
 * `GET /game`: the package as last built. For an enforced game, `source` is the bundle, or null
 * with `errors` while the build is broken. Sandbox games have no bundle.
 */
export const DevGameResponseSchema = z
  .strictObject({
    protocol: z.literal(DEV_SERVER_PROTOCOL),
    buildId: NonnegativeIntegerSchema,
    manifest: ManifestSchema,
    components: ComponentsFileSchema,
    source: z.string().max(MAX_BUNDLE_BYTES).nullable(),
    errors: z.array(ValidationErrorSchema),
  })
  .refine(
    (game) =>
      game.manifest.mode === "enforced"
        ? (game.source === null) === game.errors.length > 0
        : game.source === null,
    "An enforced build has either a bundle or errors; a sandbox game has no bundle",
  );
export type DevGameResponse = z.infer<typeof DevGameResponseSchema>;

/** The data of each `build` server-sent event on `GET /events`. */
export const DevBuildEventSchema = z.strictObject({ buildId: NonnegativeIntegerSchema });
export type DevBuildEvent = z.infer<typeof DevBuildEventSchema>;
