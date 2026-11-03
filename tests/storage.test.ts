import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createLocalStorage,
  createMemoryStorage,
  createS3Storage,
  newPrivateKey,
  newPublicKey,
  readLocalPublic,
  resolveDriver,
} from "../src/server/storage";
import { GET } from "../src/app/api/dev-photos/[...key]/route";

describe("keys", () => {
  it("are random uuids with distinct prefixes and a jpg suffix", () => {
    const a = newPrivateKey();
    const b = newPublicKey();
    expect(a).toMatch(/^originals\/[0-9a-f-]{36}\.jpg$/);
    expect(b).toMatch(/^photos\/[0-9a-f-]{36}\.jpg$/);
    expect(newPrivateKey()).not.toBe(a);
  });
});

describe("resolveDriver", () => {
  it("defaults by environment", () => {
    expect(resolveDriver({ NODE_ENV: "production" })).toBe("s3");
    expect(resolveDriver({ NODE_ENV: "development" })).toBe("local");
    expect(resolveDriver({ NODE_ENV: "test" })).toBe("memory");
  });
  it("honours STORAGE_DRIVER outside production", () => {
    expect(resolveDriver({ NODE_ENV: "development", STORAGE_DRIVER: "memory" })).toBe("memory");
  });
  it("throws in production with a non-s3 driver", () => {
    expect(() => resolveDriver({ NODE_ENV: "production", STORAGE_DRIVER: "local" })).toThrow();
    expect(() => resolveDriver({ NODE_ENV: "production", STORAGE_DRIVER: "memory" })).toThrow();
  });
  it("throws on unknown drivers", () => {
    expect(() => resolveDriver({ NODE_ENV: "development", STORAGE_DRIVER: "ftp" })).toThrow();
  });
});

describe("memoryStorage", () => {
  it("keeps private and public objects apart", async () => {
    const s = createMemoryStorage();
    await s.putPrivate("originals/a.jpg", Buffer.from("p"), "image/jpeg");
    await s.putPublic("photos/a.jpg", Buffer.from("q"), "image/jpeg");
    expect((await s.getPrivate("originals/a.jpg")).toString()).toBe("p");
    await expect(s.getPrivate("photos/a.jpg")).rejects.toThrow();
    expect(s.publicUrl("photos/a.jpg")).toContain("photos/a.jpg");
  });
});

describe("s3Storage with a stub client", () => {
  function stub() {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === "GetObjectCommand") {
          return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
        }
        return {};
      },
    };
    const s = createS3Storage({
      client: client as never,
      privateBucket: "priv-bucket",
      publicBucket: "pub-bucket",
      publicBaseUrl: "https://cdn.example.com/",
    });
    return { s, sent };
  }

  it("puts private objects in the private bucket with no ACL", async () => {
    const { s, sent } = stub();
    await s.putPrivate("originals/x.jpg", Buffer.from("a"), "image/jpeg");
    expect(sent[0].name).toBe("PutObjectCommand");
    expect(sent[0].input).toMatchObject({ Bucket: "priv-bucket", Key: "originals/x.jpg", ContentType: "image/jpeg" });
    expect(sent[0].input.ACL).toBeUndefined();
  });

  it("puts public objects in the public bucket with no ACL", async () => {
    const { s, sent } = stub();
    await s.putPublic("photos/x.jpg", Buffer.from("a"), "image/jpeg");
    expect(sent[0].input).toMatchObject({ Bucket: "pub-bucket", Key: "photos/x.jpg", ContentType: "image/jpeg" });
    expect(sent[0].input.ACL).toBeUndefined();
  });

  it("reads private objects from the private bucket", async () => {
    const { s, sent } = stub();
    const buf = await s.getPrivate("originals/x.jpg");
    expect([...buf]).toEqual([1, 2, 3]);
    expect(sent[0].name).toBe("GetObjectCommand");
    expect(sent[0].input).toMatchObject({ Bucket: "priv-bucket", Key: "originals/x.jpg" });
  });

  it("builds public urls from the base url", () => {
    expect(stub().s.publicUrl("photos/x.jpg")).toBe("https://cdn.example.com/photos/x.jpg");
  });
});

describe("localStorage driver and dev route", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  async function make() {
    const dir = await mkdtemp(path.join(tmpdir(), "stray-"));
    dirs.push(dir);
    return { dir, s: createLocalStorage(dir) };
  }

  it("writes private and public files in separate directories", async () => {
    const { dir, s } = await make();
    const pk = newPrivateKey();
    const uk = newPublicKey();
    await s.putPrivate(pk, Buffer.from("secret"), "image/jpeg");
    await s.putPublic(uk, Buffer.from("open"), "image/jpeg");
    expect((await s.getPrivate(pk)).toString()).toBe("secret");
    expect((await readFile(path.join(dir, "public", uk))).toString()).toBe("open");
    expect(s.publicUrl(uk)).toBe(`/api/dev-photos/${uk}`);
    expect(await readLocalPublic(dir, pk)).toBeNull(); // private keys never resolve publicly
    expect((await readLocalPublic(dir, uk))?.toString()).toBe("open");
  });

  it("refuses keys that are not generated shapes", async () => {
    const { dir, s } = await make();
    await expect(s.putPublic("../escape.jpg", Buffer.from("x"), "image/jpeg")).rejects.toThrow();
    await expect(s.getPrivate("../../etc/passwd")).rejects.toThrow();
    expect(await readLocalPublic(dir, "photos/../../x.jpg")).toBeNull();
  });

  it("route returns 404 in production", async () => {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      const res = await GET(new Request("http://x"), { params: Promise.resolve({ key: ["photos", "a.jpg"] }) });
      expect(res.status).toBe(404);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev ?? "test";
    }
  });

  it("route rejects path traversal and private prefixes", async () => {
    for (const key of [
      ["..", "..", "etc", "passwd"],
      ["photos", "..", "private", "x.jpg"],
      ["originals", "00000000-0000-0000-0000-000000000000.jpg"],
      ["photos", "%2e%2e%2fx.jpg"],
      ["photos", "a.jpg"],
    ]) {
      const res = await GET(new Request("http://x"), { params: Promise.resolve({ key }) });
      expect(res.status, key.join("/")).toBe(404);
    }
  });
});
