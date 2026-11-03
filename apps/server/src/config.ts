export type BlobConfig =
  | { driver: "fs"; dir: string }
  | {
      driver: "s3";
      endpoint: string | undefined;
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
    };

export interface ServerConfig {
  host: string;
  port: number;
  publicWebOrigin: string;
  databaseUrl: string;
  oidc: { issuer: string; audience: string; jwksUrl: string };
  guestTokenSecret: string;
  blob: BlobConfig;
  rules: { timeoutMs: number; memoryLimitBytes: number };
  logLevel: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`${name} must be set`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function origin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("PUBLIC_WEB_ORIGIN must be http(s)");
  return url.origin;
}

/** Reads the variables documented in dev-environment.md. Secrets are never logged. */
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const driver = env.BLOB_DRIVER ?? "fs";
  let blob: BlobConfig;
  if (driver === "fs") {
    blob = { driver, dir: env.BLOB_FS_DIR || "./.data/blobs" };
  } else if (driver === "s3") {
    blob = {
      driver,
      endpoint: env.S3_ENDPOINT || undefined,
      bucket: required(env, "S3_BUCKET"),
      region: required(env, "S3_REGION"),
      accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
    };
  } else {
    throw new Error("BLOB_DRIVER must be fs or s3");
  }
  const sandbox = env.RULES_SANDBOX ?? "quickjs";
  // D-008 accepted QuickJS; the node-vm spike implementation is not a production sandbox.
  if (sandbox !== "quickjs") throw new Error("RULES_SANDBOX must be quickjs");
  return {
    host: env.HOST || "127.0.0.1",
    port: integer(env, "PORT", 3000, 0, 65_535),
    publicWebOrigin: origin(env.PUBLIC_WEB_ORIGIN || "http://localhost:5173"),
    databaseUrl: required(env, "DATABASE_URL"),
    oidc: {
      issuer: required(env, "OIDC_ISSUER"),
      audience: env.OIDC_AUDIENCE || "bgp-api",
      jwksUrl: required(env, "OIDC_JWKS_URL"),
    },
    guestTokenSecret: required(env, "GUEST_TOKEN_SECRET"),
    blob,
    rules: {
      timeoutMs: integer(env, "RULES_CALL_TIMEOUT_MS", 1000, 1, 1000),
      memoryLimitBytes: integer(env, "RULES_MEMORY_MB", 64, 1, 64) * 1024 * 1024,
    },
    logLevel: env.LOG_LEVEL || "info",
  };
}
