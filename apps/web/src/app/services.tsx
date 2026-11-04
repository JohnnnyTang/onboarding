import { createContext, type ReactNode, useContext, useSyncExternalStore } from "react";
import type { ApiClient } from "../api/client";
import type { AuthService, AuthUser } from "../auth/auth";
import type { ClaimedSeats } from "../auth/claimed-seats";
import type { ProjectStore } from "../projects/project-store";

export interface Services {
  api: ApiClient;
  auth: AuthService;
  seats: ClaimedSeats;
  /** Room server WebSocket endpoint (`VITE_WS_URL`). */
  roomUrl: string;
  /** The local project database, opened on first use (D-015). */
  projects(): Promise<ProjectStore>;
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ value, children }: { value: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error("useServices must be used inside ServicesProvider");
  return services;
}

/** The signed-in designer, or null. Re-renders on sign-in and sign-out only. */
export function useAuthUser(): AuthUser | null {
  const { auth } = useServices();
  return useSyncExternalStore(auth.subscribe, auth.current, auth.current);
}
