import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const envFile = resolve(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const composeFile = resolve(root, "infra/docker-compose.yml");
if (existsSync(composeFile)) {
  const result = spawnSync("docker", ["compose", "-f", composeFile, "up", "-d", "--wait"], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const migration = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve(root, "scripts/db-migrate.ts")],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if (migration.error) throw migration.error;
  if (migration.status !== 0) process.exit(migration.status ?? 1);
} else {
  console.info(
    "T01 scaffold: Docker services arrive in T07; API and web services arrive in T10/T12.",
  );
}

const turbo = resolve(root, "node_modules/turbo/bin/turbo");
const result = spawnSync(process.execPath, [turbo, "run", "dev"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, TURBO_UI: "stream" },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
