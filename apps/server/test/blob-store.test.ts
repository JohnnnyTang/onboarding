import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";
import { blobKey, createFsBlobStore, createS3BlobStore } from "../src/blob/blob-store.js";
import { loadConfig } from "../src/config.js";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const bytes = new TextEncoder().encode("hello blobs");
const key = blobKey(sha256(bytes));
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("fs BlobStore", () => {
  it("stores content-addressed bytes atomically and returns null for absent keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bgp-blob-test-"));
    directories.push(directory);
    const store = createFsBlobStore(directory);
    expect(await store.get(key)).toBeNull();
    await store.put(key, bytes);
    await store.put(key, bytes);
    expect(await store.get(key)).toEqual(bytes);
    expect(await readdir(join(directory, "blobs"))).toEqual([sha256(bytes)]);
  });

  it("rejects keys outside blobs/<sha256>", async () => {
    const store = createFsBlobStore(tmpdir());
    await expect(store.get("../etc/passwd")).rejects.toThrow("Invalid blob key");
    await expect(store.put(`blobs/${"A".repeat(64)}`, bytes)).rejects.toThrow("Invalid blob key");
    expect(() => blobKey("../x")).toThrow("Invalid blob key");
  });
});

describe("s3 BlobStore", () => {
  function fakeClient(objects = new Map<string, Uint8Array>()) {
    const sent: unknown[] = [];
    return {
      objects,
      sent,
      async send(command: unknown): Promise<unknown> {
        sent.push(command);
        if (command instanceof PutObjectCommand) {
          objects.set(String(command.input.Key), command.input.Body as Uint8Array);
          return {};
        }
        if (command instanceof GetObjectCommand) {
          const found = objects.get(String(command.input.Key));
          if (!found)
            throw new NoSuchKey({ message: "missing", $metadata: { httpStatusCode: 404 } });
          return { Body: { transformToByteArray: async () => found } };
        }
        throw new Error("unexpected command");
      },
    };
  }

  it("puts and gets objects in the configured bucket", async () => {
    const client = fakeClient();
    const store = createS3BlobStore({ client: client as never, bucket: "bgp" });
    expect(await store.get(key)).toBeNull();
    await store.put(key, bytes);
    expect(await store.get(key)).toEqual(bytes);
    const put = client.sent.find((command) => command instanceof PutObjectCommand);
    expect(put).toMatchObject({
      input: { Bucket: "bgp", Key: key, ContentLength: bytes.byteLength },
    });
  });

  it("maps 404 service errors to null and rethrows others", async () => {
    const notFound = new S3ServiceException({
      name: "NotFound",
      $fault: "client",
      $metadata: { httpStatusCode: 404 },
    });
    const denied = new S3ServiceException({
      name: "AccessDenied",
      $fault: "client",
      $metadata: { httpStatusCode: 403 },
    });
    let next: Error = notFound;
    const client = { send: async () => Promise.reject(next) };
    const store = createS3BlobStore({ client: client as never, bucket: "bgp" });
    expect(await store.get(key)).toBeNull();
    next = denied;
    await expect(store.get(key)).rejects.toBe(denied);
    await expect(store.get("blobs/nope")).rejects.toThrow("Invalid blob key");
  });
});

describe("loadConfig", () => {
  const base = {
    DATABASE_URL: "postgres://localhost/bgp",
    OIDC_ISSUER: "http://localhost:8080/realms/bgp",
    OIDC_JWKS_URL: "http://localhost:8080/certs",
    GUEST_TOKEN_SECRET: "x".repeat(32),
  };

  it("applies the documented local defaults", () => {
    expect(loadConfig(base)).toMatchObject({
      host: "127.0.0.1",
      port: 3000,
      publicWebOrigin: "http://localhost:5173",
      oidc: { audience: "bgp-api" },
      blob: { driver: "fs", dir: "./.data/blobs" },
      rules: { timeoutMs: 1000, memoryLimitBytes: 64 * 1024 * 1024 },
    });
  });

  it("configures S3 and rejects invalid values", () => {
    expect(
      loadConfig({
        ...base,
        BLOB_DRIVER: "s3",
        S3_BUCKET: "b",
        S3_REGION: "r",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
      }).blob,
    ).toEqual({
      driver: "s3",
      endpoint: undefined,
      bucket: "b",
      region: "r",
      accessKeyId: "id",
      secretAccessKey: "secret",
    });
    expect(() => loadConfig({ ...base, BLOB_DRIVER: "s3" })).toThrow("S3_BUCKET must be set");
    expect(() => loadConfig({ ...base, BLOB_DRIVER: "ftp" })).toThrow("BLOB_DRIVER");
    expect(() => loadConfig({ ...base, RULES_CALL_TIMEOUT_MS: "5000" })).toThrow(
      "RULES_CALL_TIMEOUT_MS",
    );
    expect(() => loadConfig({ ...base, RULES_SANDBOX: "node-vm" })).toThrow("RULES_SANDBOX");
    expect(() => loadConfig({ ...base, PORT: "3e3" })).toThrow("PORT");
    expect(() => loadConfig({ ...base, DATABASE_URL: "" })).toThrow("DATABASE_URL must be set");
  });
});
