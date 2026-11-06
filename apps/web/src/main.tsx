import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserManager } from "oidc-client-ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { createApiClient } from "./api/client";
import { AppRoutes } from "./app/app";
import { shouldRetry } from "./app/messages";
import { ServicesProvider } from "./app/services";
import { createAuthService, oidcSettings } from "./auth/auth";
import { createClaimedSeats, createTokenSource } from "./auth/claimed-seats";
import { loadWebConfig } from "./config";
import { createInviteStore } from "./match/match-invites";
import { openProjectStore, type ProjectStore } from "./projects/project-store";
import "./styles/global.css";

const config = loadWebConfig(import.meta.env);
const manager = new UserManager(oidcSettings(config, window.location.origin, sessionStorage));
// Abandoned sign-in attempts leave request state behind; it holds no tokens.
void manager.clearStaleState();
const auth = createAuthService(manager);
// Guest seats survive a reload in this tab (Q-018); designer tokens stay in memory (D-007).
const seats = createClaimedSeats(sessionStorage);
// Invite links come back once, at match creation; the host's tab keeps them (Q-025).
const invites = createInviteStore(sessionStorage);
const api = createApiClient({ baseUrl: config.apiUrl, tokens: createTokenSource(auth, seats) });
// Opened on first use, so pages without projects never touch IndexedDB.
let projectStore: Promise<ProjectStore> | undefined;
const projects = () => {
  projectStore ??= openProjectStore();
  projectStore.catch(() => {
    projectStore = undefined;
  });
  return projectStore;
};
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: shouldRetry, refetchOnWindowFocus: false } },
});
// Cached responses belong to one identity; drop them when it changes.
auth.subscribe(() => queryClient.clear());

// Production builds work offline: the service worker caches the app's own files (T15).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <ServicesProvider value={{ api, auth, seats, invites, roomUrl: config.wsUrl, projects }}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </QueryClientProvider>
    </ServicesProvider>
  </StrictMode>,
);
