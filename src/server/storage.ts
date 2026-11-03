import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/** The object is gone, as opposed to storage being unreachable. Retrying will not help. */
export class StoredObjectMissing extends Error {
  constructor() {
    super("No such stored object");
    this.name = "StoredObjectMissing";
  }
}

/**
 * Photo storage. Originals live in a private area that has no public route anywhere.
 * Only scrubbed copies go to the public area.
 */
export interface Storage {
  putPrivate(key: string, buf: Buffer, type: string): Promise<void>;
  putPublic(key: string, buf: Buffer, type: string): Promise<void>;
  getPrivate(key: string): Promise<Buffer>;
  publicUrl(key: string): string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PRIVATE_KEY = new RegExp(`^originals/${UUID}\\.jpg$`);
const PUBLIC_KEY = new RegExp(`^photos/${UUID}\\.jpg$`);

/** Keys are random and never derived from user input. */
export const newPrivateKey = () => `originals/${randomUUID()}.jpg`;
export const newPublicKey = () => `photos/${randomUUID()}.jpg`;

export type Driver = "s3" | "local" | "memory";

export function resolveDriver(env: Record<string, string | undefined>): Driver {
  const production = env.NODE_ENV === "production";
  const fallback: Driver = production ? "s3" : env.NODE_ENV === "test" ? "memory" : "local";
  const driver = env.STORAGE_DRIVER || fallback;
  if (driver !== "s3" && driver !== "local" && driver !== "memory") {
    throw new Error(`Unknown STORAGE_DRIVER "${driver}"`);
  }
  if (production && driver !== "s3") {
    throw new Error("Production requires STORAGE_DRIVER=s3");
  }
  return driver;
}

export type MemoryStorage = Storage & { readPublic(key: string): Buffer };

export function createMemoryStorage(): MemoryStorage {
  const priv = new Map<string, Buffer>();
  const pub = new Map<string, Buffer>();
  return {
    async putPrivate(key, buf) {
      priv.set(key, Buffer.from(buf));
    },
    async putPublic(key, buf) {
      pub.set(key, Buffer.from(buf));
    },
    async getPrivate(key) {
      const b = priv.get(key);
      if (!b) throw new StoredObjectMissing();
      return Buffer.from(b);
    },
    publicUrl: (key) => `/memory-photos/${key}`,
    readPublic(key) {
      const b = pub.get(key);
      if (!b) throw new Error(`No public object ${key}`);
      return Buffer.from(b);
    },
  };
}

type S3Like = Pick<S3Client, "send">;

export interface S3Options {
  client?: S3Like;
  region?: string;
  privateBucket?: string;
  publicBucket?: string;
  publicBaseUrl?: string;
}

/** The client and settings are resolved on first use, so importing this module needs no AWS config. */
export function createS3Storage(opts: S3Options = {}): Storage {
  let client = opts.client;
  const getClient = (): S3Like => {
    client ??= new S3Client({ region: opts.region ?? process.env.AWS_REGION });
    return client;
  };
  const need = (value: string | undefined, name: string): string => {
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const privateBucket = () => need(opts.privateBucket ?? process.env.S3_PRIVATE_BUCKET, "S3_PRIVATE_BUCKET");
  const publicBucket = () => need(opts.publicBucket ?? process.env.S3_PUBLIC_BUCKET, "S3_PUBLIC_BUCKET");
  return {
    async putPrivate(key, buf, type) {
      // No ACL: access is governed by the bucket policy, and the bucket blocks public access.
      await getClient().send(
        new PutObjectCommand({ Bucket: privateBucket(), Key: key, Body: buf, ContentType: type }),
      );
    },
    async putPublic(key, buf, type) {
      await getClient().send(
        new PutObjectCommand({ Bucket: publicBucket(), Key: key, Body: buf, ContentType: type }),
      );
    },
    async getPrivate(key) {
      const res = await getClient()
        .send(new GetObjectCommand({ Bucket: privateBucket(), Key: key }))
        .catch((e: unknown) => {
          throw e instanceof Error && e.name === "NoSuchKey" ? new StoredObjectMissing() : e;
        });
      if (!res.Body) throw new StoredObjectMissing();
      return Buffer.from(await res.Body.transformToByteArray());
    },
    publicUrl(key) {
      const base = need(opts.publicBaseUrl ?? process.env.S3_PUBLIC_BASE_URL, "S3_PUBLIC_BASE_URL");
      return `${base.replace(/\/+$/, "")}/${key}`;
    },
  };
}

export const LOCAL_DATA_DIR = path.join(process.cwd(), ".data");

function localPath(dir: string, area: "private" | "public", key: string): string {
  const ok = area === "private" ? PRIVATE_KEY.test(key) : PUBLIC_KEY.test(key);
  if (!ok) throw new Error("Invalid storage key");
  return path.join(dir, area, key);
}

/** Development only. Writes under a gitignored directory. */
export function createLocalStorage(dir: string = LOCAL_DATA_DIR): Storage {
  const write = async (p: string, buf: Buffer) => {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, buf);
  };
  return {
    putPrivate: async (key, buf) => write(localPath(dir, "private", key), buf),
    putPublic: async (key, buf) => write(localPath(dir, "public", key), buf),
    getPrivate: async (key) =>
      readFile(localPath(dir, "private", key)).catch((e: NodeJS.ErrnoException) => {
        throw e.code === "ENOENT" ? new StoredObjectMissing() : e;
      }),
    publicUrl: (key) => `/api/dev-photos/${key}`,
  };
}

/** Reads a public file from the local driver. Returns null for any key that is not a public key or is missing. */
export async function readLocalPublic(dir: string, key: string): Promise<Buffer | null> {
  if (!PUBLIC_KEY.test(key)) return null;
  try {
    return await readFile(localPath(dir, "public", key));
  } catch {
    return null;
  }
}

/** Exposed as a lazy singleton-free handle to the S3 driver, per the Storage interface. */
export const s3Storage: Storage = createS3Storage();
export const memoryStorage: MemoryStorage = createMemoryStorage();

let cached: Storage | undefined;

export function getStorage(): Storage {
  if (cached) return cached;
  const driver = resolveDriver(process.env);
  cached = driver === "s3" ? s3Storage : driver === "local" ? createLocalStorage() : memoryStorage;
  return cached;
}
