import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

/** Content-addressed object storage (D-014). Keys are `blobs/<sha256>`. */
export interface BlobStore {
  /** Store bytes under a key; storing an existing key is a no-op. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** The stored bytes, or null when the key is absent. */
  get(key: string): Promise<Uint8Array | null>;
}

const KEY = /^blobs\/[a-f0-9]{64}$/;

export function blobKey(sha256: string): string {
  return checkKey(`blobs/${sha256}`);
}

function checkKey(key: string): string {
  if (!KEY.test(key)) throw new Error("Invalid blob key");
  return key;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/** Local driver for development and tests. Writes are atomic renames of complete files. */
export function createFsBlobStore(directory: string): BlobStore {
  const root = resolve(directory);
  const pathOf = (key: string) => join(root, checkKey(key));
  return {
    async put(key, bytes) {
      const path = pathOf(key);
      try {
        await stat(path);
        return;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: "wx" });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(pathOf(key)));
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
    },
  };
}

export interface S3BlobStoreOptions {
  client: Pick<S3Client, "send">;
  bucket: string;
}

/** S3-compatible driver for production; the provider stays open (Q-002). */
export function createS3BlobStore({ client, bucket }: S3BlobStoreOptions): BlobStore {
  return {
    async put(key, bytes) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: checkKey(key),
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: "application/octet-stream",
        }),
      );
    },
    async get(key) {
      try {
        const output = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: checkKey(key) }),
        );
        if (!output.Body) return null;
        return await output.Body.transformToByteArray();
      } catch (error) {
        if (
          error instanceof NoSuchKey ||
          (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)
        ) {
          return null;
        }
        throw error;
      }
    },
  };
}
