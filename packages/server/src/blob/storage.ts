import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface BlobMeta {
  storeId: string;
  pathname: string;
  size: number;
  contentType: string;
  contentDisposition: string;
  cacheControl: string;
  access: "public" | "private";
  uploadedAt: string;
  etag: string;
}

/** Pluggable byte storage for blobs. Metadata is indexed in memory for fast listing. */
export interface BlobStorage {
  readonly kind: string;
  init(): Promise<void>;
  put(meta: BlobMeta, data: Uint8Array): Promise<void>;
  get(storeId: string, pathname: string): Promise<{ meta: BlobMeta; data: Uint8Array } | null>;
  head(storeId: string, pathname: string): BlobMeta | null;
  delete(storeId: string, pathname: string): Promise<boolean>;
  /** Lexicographically sorted metadata for a store. */
  list(storeId: string): BlobMeta[];
}

const key = (storeId: string, pathname: string) => `${storeId}\u0000${pathname}`;

export class MemoryBlobStorage implements BlobStorage {
  readonly kind: string = "memory";
  protected index = new Map<string, BlobMeta>();
  private bytes = new Map<string, Uint8Array>();
  async init(): Promise<void> {}
  async put(meta: BlobMeta, data: Uint8Array): Promise<void> {
    this.index.set(key(meta.storeId, meta.pathname), meta);
    this.bytes.set(key(meta.storeId, meta.pathname), data);
  }
  async get(storeId: string, pathname: string) {
    const meta = this.index.get(key(storeId, pathname));
    return meta ? { meta, data: this.bytes.get(key(storeId, pathname))! } : null;
  }
  head(storeId: string, pathname: string) {
    return this.index.get(key(storeId, pathname)) ?? null;
  }
  async delete(storeId: string, pathname: string) {
    this.bytes.delete(key(storeId, pathname));
    return this.index.delete(key(storeId, pathname));
  }
  list(storeId: string) {
    return [...this.index.values()].filter((m) => m.storeId === storeId).sort((a, b) => (a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0));
  }
}

/** Local filesystem storage: <dir>/<storeId>/<sha256(pathname)>.bin plus a .json sidecar. */
export class FsBlobStorage extends MemoryBlobStorage {
  override readonly kind = "fs";
  constructor(private dir: string) {
    super();
  }
  private file(storeId: string, pathname: string) {
    const h = createHash("sha256").update(pathname).digest("hex");
    return join(this.dir, storeId, h);
  }
  override async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    for (const store of await readdir(this.dir)) {
      const sdir = join(this.dir, store);
      let files: string[];
      try {
        files = await readdir(sdir);
      } catch {
        continue;
      }
      for (const f of files.filter((x) => x.endsWith(".json"))) {
        const meta = JSON.parse(await readFile(join(sdir, f), "utf8")) as BlobMeta;
        this.index.set(key(meta.storeId, meta.pathname), meta);
      }
    }
  }
  override async put(meta: BlobMeta, data: Uint8Array): Promise<void> {
    const f = this.file(meta.storeId, meta.pathname);
    await mkdir(join(this.dir, meta.storeId), { recursive: true });
    await writeFile(`${f}.bin`, data);
    await writeFile(`${f}.json`, JSON.stringify(meta));
    this.index.set(key(meta.storeId, meta.pathname), meta);
  }
  override async get(storeId: string, pathname: string) {
    const meta = this.head(storeId, pathname);
    if (!meta) return null;
    const f = `${this.file(storeId, pathname)}.bin`;
    if (!existsSync(f)) return null;
    return { meta, data: new Uint8Array(await readFile(f)) };
  }
  override async delete(storeId: string, pathname: string) {
    const existed = this.index.delete(key(storeId, pathname));
    const f = this.file(storeId, pathname);
    await rm(`${f}.bin`, { force: true });
    await rm(`${f}.json`, { force: true });
    return existed;
  }
}
