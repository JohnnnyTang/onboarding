import { type OidcClaims, type UserResponse, UserResponseSchema } from "@bgp/schema";
import type { DatabaseConnection } from "../db/connection.js";
import { createId } from "../db/id.js";
import { users } from "../db/schema.js";

export interface UserStore {
  upsert(claims: OidcClaims): Promise<UserResponse>;
}

export function createUserStore(db: Pick<DatabaseConnection["db"], "insert">): UserStore {
  return {
    async upsert(claims) {
      const profile = {
        displayName: (claims.name ?? claims.preferred_username ?? claims.sub).slice(0, 80),
        email: claims.email ?? null,
      };
      const [user] = await db
        .insert(users)
        .values({
          id: createId(),
          oidcIssuer: claims.iss,
          oidcSubject: claims.sub,
          ...profile,
        })
        .onConflictDoUpdate({
          target: [users.oidcIssuer, users.oidcSubject],
          set: profile,
        })
        .returning({ id: users.id, displayName: users.displayName, email: users.email });
      return UserResponseSchema.parse(user);
    },
  };
}
