import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { id, loadDb, transact } from "./store.js";

function safeObjectKey(key) {
  if (!key?.trim()) throw new Error("Object key is required");
  const normalized = path.posix.normalize("/" + key).replace(/^\/+/, "");
  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) {
    throw new Error("Object key escapes storage namespace");
  }
  return normalized;
}

export class ObjectStorageAdapter {
  async put() { throw new Error("ObjectStorageAdapter.put() is not implemented"); }
  async get() { throw new Error("ObjectStorageAdapter.get() is not implemented"); }
  async delete() { throw new Error("ObjectStorageAdapter.delete() is not implemented"); }
  async list() { throw new Error("ObjectStorageAdapter.list() is not implemented"); }
}

export class LocalPersistentObjectStore extends ObjectStorageAdapter {
  constructor(root = process.env.RAZEKIT_OBJECT_ROOT || "data/objects") {
    super();
    this.root = path.resolve(root);
  }

  resolve(key) {
    const normalized = safeObjectKey(key);
    const candidate = path.resolve(this.root, normalized);
    const relative = path.relative(this.root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Object key escapes storage root");
    }
    return candidate;
  }

  async put(key, value, metadata = {}) {
    const objectKey = safeObjectKey(key);
    const file = this.resolve(objectKey);
    await mkdir(path.dirname(file), { recursive: true });
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    await writeFile(file, data, { flag: "wx" }).catch(async error => {
      if (error.code !== "EEXIST") throw error;
      await writeFile(file, data);
    });

    const sha256 = createHash("sha256").update(data).digest("hex");
    const now = new Date().toISOString();
    await transact(db => {
      const existing = db.artifactObjects.find(item => item.objectKey === objectKey);
      const record = {
        id: existing?.id || id("obj"),
        objectKey,
        size: data.length,
        sha256,
        etag: sha256,
        metadata,
        status: "available",
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };
      if (existing) Object.assign(existing, record);
      else db.artifactObjects.push(record);
      return record;
    });

    return {
      objectKey,
      size: data.length,
      sha256,
      etag: sha256
    };
  }

  async get(key) {
    const data = await readFile(this.resolve(key));
    const db = await loadDb();
    const metadata = db.artifactObjects.find(item => item.objectKey === safeObjectKey(key));
    return {
      data,
      metadata: metadata || null
    };
  }

  async delete(key) {
    const file = this.resolve(key);
    const record = await transact(db => {
      const item = db.artifactObjects.find(entry => entry.objectKey === safeObjectKey(key));
      if (!item) throw new Error("Object not found");
      item.status = "deleted";
      item.updatedAt = new Date().toISOString();
      return item;
    });
    return { objectKey: record.objectKey, deleted: true };
  }

  async list(prefix = "") {
    const normalizedPrefix = safeObjectKey(prefix || "root");
    const db = await loadDb();
    return db.artifactObjects.filter(item =>
      item.status === "available" &&
      (prefix ? item.objectKey.startsWith(safeObjectKey(prefix)) : item.objectKey.startsWith(normalizedPrefix === "root" ? "" : normalizedPrefix))
    );
  }
}

export async function persistArtifact({
  store,
  tenantId = "local-tenant",
  taskId,
  artifactType = "artifact",
  objectKey,
  value,
  metadata = {}
}) {
  if (!store || typeof store.put !== "function") throw new Error("Object storage adapter is required");
  if (!taskId?.trim()) throw new Error("taskId is required");
  const result = await store.put(objectKey, value, { tenantId, taskId, artifactType, ...metadata });

  await transact(db => {
    const item = db.artifactObjects.find(entry => entry.objectKey === result.objectKey);
    if (item) {
      item.tenantId = tenantId;
      item.taskId = taskId;
      item.artifactType = artifactType;
      item.updatedAt = new Date().toISOString();
    }
  });

  return result;
}
