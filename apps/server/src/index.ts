export { type AuthPolicy, authPlugin } from "./auth/plugin.js";
export type { AuthOptions, AuthService, CallerIdentity } from "./auth/service.js";
export { AuthError, createAuthService, requireMatchScope } from "./auth/service.js";
export { createUserStore, type UserStore } from "./auth/user-store.js";
