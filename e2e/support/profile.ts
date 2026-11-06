import { rmSync } from "node:fs";
import { test } from "@playwright/test";

/**
 * Removes a closed browser's profile folder. Windows can hold its files for seconds after
 * the browser closes, longer under load (EPERM). A leftover folder in the temp directory is
 * harmless, so cleanup never fails a test whose checks passed; it notes the folder instead.
 */
export function removeProfile(profile: string): void {
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    test.info().annotations.push({ type: "cleanup", description: `Left ${profile} behind` });
  }
}
