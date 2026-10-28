import { z } from "zod";
import { IdSchema, PositiveIntegerSchema, SeatIdSchema } from "./common.js";

// Extra provider claims are discarded after cryptographic verification.
export const OidcClaimsSchema = z.object({
  iss: z.url(),
  sub: IdSchema,
  aud: z.union([IdSchema, z.array(IdSchema).min(1)]),
  exp: PositiveIntegerSchema,
  name: z.string().min(1).optional(),
  preferred_username: z.string().min(1).optional(),
  email: z.email().optional(),
});
export type OidcClaims = z.infer<typeof OidcClaimsSchema>;

export const GuestScopeSchema = z.strictObject({ matchId: IdSchema, seat: SeatIdSchema });
export type GuestScope = z.infer<typeof GuestScopeSchema>;
export const GuestClaimsSchema = GuestScopeSchema.extend({
  iss: z.literal("bgp:guest"),
  aud: z.literal("bgp:api"),
  sub: IdSchema,
  iat: PositiveIntegerSchema,
  exp: PositiveIntegerSchema,
}).refine((claims) => claims.exp - claims.iat === 30 * 24 * 60 * 60, "Guest lifetime is 30 days");
export type GuestClaims = z.infer<typeof GuestClaimsSchema>;
