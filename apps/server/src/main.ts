import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { RulesHostClient } from "@bgp/rules-host";
import { buildApp } from "./app.js";
import { createAuthService } from "./auth/service.js";
import { createUserStore } from "./auth/user-store.js";
import { type BlobStore, createFsBlobStore, createS3BlobStore } from "./blob/blob-store.js";
import { type BlobConfig, loadConfig } from "./config.js";
import { connectDatabase } from "./db/connection.js";
import { RoomManager } from "./room/manager.js";
import { createRulesSetupChecker, createVersionBuildStore } from "./versions/rules-builds.js";

function blobStore(config: BlobConfig): BlobStore {
  if (config.driver === "fs") return createFsBlobStore(config.dir);
  const client = new S3Client({
    region: config.region,
    // Self-hosted S3-compatible stores generally need path-style addressing.
    ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return createS3BlobStore({ client, bucket: config.bucket });
}

// Same depth from src/ and dist/; existing environment variables take precedence.
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig(process.env);
const connection = connectDatabase(config.databaseUrl, { max: 10 });
const blobs = blobStore(config.blob);
const builds = createVersionBuildStore(connection.db, blobs);
// Created before the rooms so a crashed match process can be reported to its room.
let rooms: RoomManager | undefined;
const rulesHost = new RulesHostClient(builds, {
  ...config.rules,
  onProcessExit: (matchId) => rooms?.hostExited(matchId),
});
rooms = new RoomManager({ db: connection.db, engine: rulesHost });
const app = await buildApp({
  db: connection.db,
  auth: createAuthService({
    oidc: config.oidc,
    guestTokenSecret: config.guestTokenSecret,
    users: createUserStore(connection.db),
  }),
  blobs,
  setup: createRulesSetupChecker(rulesHost, builds),
  publicWebOrigin: config.publicWebOrigin,
  logger: { level: config.logLevel },
  rooms,
});

async function shutdown(): Promise<void> {
  await app.close();
  rulesHost.close();
  await connection.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: config.host, port: config.port });
