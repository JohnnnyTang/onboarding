import type { MatchState } from "@bgp/schema";
import { canonicalJson } from "./canonical.js";

// Minimal Web Crypto/encoding capabilities, available in Node 24 and browsers.
// Do not add DOM or Node types to the pure runtime to type these built-ins.
declare const crypto: {
  subtle: { digest(algorithm: "SHA-256", data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> };
};
declare const TextEncoder: { new (): { encode(text: string): Uint8Array<ArrayBuffer> } };

export async function hashState(state: MatchState): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(state));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
