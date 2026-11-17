import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";

const EDGE_ENC_MAGIC = Buffer.from("NOEMA_EDGE_ENC_V1:", "utf8");
const require = createRequire(import.meta.url);

type EdgeSqlite = Pick<DatabaseSync, "prepare" | "exec" | "close" | "loadExtension">;

export function encryptEdgeBuffer(plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([EDGE_ENC_MAGIC, salt, iv, tag, encrypted]);
}

export function decryptEdgeBuffer(payload: Buffer, passphrase: string): Buffer {
  if (payload.subarray(0, EDGE_ENC_MAGIC.length).compare(EDGE_ENC_MAGIC) !== 0) {
    throw new Error("Formato de banco Edge criptografado inválido.");
  }
  let offset = EDGE_ENC_MAGIC.length;
  const salt = payload.subarray(offset, offset + 16);
  offset += 16;
  const iv = payload.subarray(offset, offset + 12);
  offset += 12;
  const tag = payload.subarray(offset, offset + 16);
  offset += 16;
  const ciphertext = payload.subarray(offset);
  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function isEncryptedEdgeFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const buf = readFileSync(filePath);
  return buf.length >= EDGE_ENC_MAGIC.length && buf.subarray(0, EDGE_ENC_MAGIC.length).compare(EDGE_ENC_MAGIC) === 0;
}

export function encryptEdgeSecret(plaintext: string, passphrase: string): string {
  const key = createHash("sha256").update(passphrase).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptEdgeSecret(payload: string, passphrase: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Payload criptografado inválido.");
  const key = createHash("sha256").update(passphrase).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

export interface EdgeItemRecord {
  id: string;
  projectId: string;
  title: string;
  content: string;
  accessPolicyId: string;
  contentHash: string;
  version?: number;
}

export interface OfflineLease {
  actorId: string;
  tenantId: string;
  issuedAt: string;
  expiresAt: string;
}

export interface EdgeRunnerTask {
  taskId: string;
  projectId: string;
  instruction: string;
  cron?: string;
  status: "queued" | "running" | "completed" | "failed" | "escalated";
  createdAt: string;
  resultSummary?: string;
  modelUsage?: Record<string, unknown>;
}

const MAX_OFFLINE_LEASE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_OFFLINE_LEASE_MS = 24 * 60 * 60 * 1000;

export function storeKeychainSecret(service: string, account: string, secret: string): boolean {
  try {
    if (process.platform === "darwin") {
      execFileSync("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret], {
        stdio: "ignore"
      });
      return true;
    }
    if (process.platform === "linux") {
      execFileSync("secret-tool", ["store", "--label", service, "service", service, "account", account], {
        input: secret,
        stdio: ["pipe", "ignore", "ignore"]
      });
      return true;
    }
    if (process.platform === "win32") {
      const psScript = [
        "Add-Type -AssemblyName System.Security;",
        "$bytes = [System.Text.Encoding]::UTF8.GetBytes($env:NOEMA_KEYCHAIN_SECRET);",
        "$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser');",
        "$dir = Join-Path $env:LOCALAPPDATA 'Noema\\keychain';",
        "New-Item -ItemType Directory -Force -Path $dir | Out-Null;",
        "[System.IO.File]::WriteAllText((Join-Path $dir ($env:NOEMA_KEYCHAIN_ID + '.dpapi')), [Convert]::ToBase64String($enc));"
      ].join(" ");
      execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
        env: { ...process.env, NOEMA_KEYCHAIN_SECRET: secret, NOEMA_KEYCHAIN_ID: `${service}_${account}`.replace(/[^a-zA-Z0-9._-]/g, "_") },
        stdio: "ignore"
      });
      return true;
    }
  } catch {
    // Fallback em ambiente headless/CI
  }
  return false;
}

export function loadKeychainSecret(service: string, account: string): string | undefined {
  try {
    if (process.platform === "darwin") {
      return execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    }
    if (process.platform === "linux") {
      return execFileSync("secret-tool", ["lookup", "service", service, "account", account], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    }
    if (process.platform === "win32") {
      const psScript = [
        "Add-Type -AssemblyName System.Security;",
        "$file = Join-Path (Join-Path $env:LOCALAPPDATA 'Noema\\keychain') ($env:NOEMA_KEYCHAIN_ID + '.dpapi');",
        "if (-not (Test-Path $file)) { exit 1 }",
        "$enc = [Convert]::FromBase64String([System.IO.File]::ReadAllText($file));",
        "$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser');",
        "[System.Text.Encoding]::UTF8.GetString($dec)"
      ].join(" ");
      return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
        env: { ...process.env, NOEMA_KEYCHAIN_ID: `${service}_${account}`.replace(/[^a-zA-Z0-9._-]/g, "_") },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Local Edge Brain SQLite (`packages/database-edge`):
 * FTS5 + fallback automático sem sqlite-vec + fila durável + cursor sync_seq/policy_epoch + SQLCipher pragma / AES-256-GCM.
 */
export class EdgeDatabase {
  private readonly dbPath: string;
  private workPath: string;
  private db: EdgeSqlite;
  private pendingSnapshotDatabase?: EdgeDatabase;
  private pendingSnapshotPath?: string;
  private readonly encryptionKey?: string;
  private readonly sqliteVecPath?: string;
  private readonly warnings: string[] = [];
  public sqliteVecActive = false;
  public sqlCipherActive = false;
  public atRestEncrypted = false;
  public encryptionMode: "sqlcipher" | "aes-256-gcm-sealed" | "none" = "none";

  constructor(
    dbPath = ".noema/edge.db",
    options: { encryptionKey?: string; sqliteVecPath?: string; requireEncryption?: boolean; requireSqlCipher?: boolean } = {}
  ) {
    if ((options.requireEncryption || options.requireSqlCipher) && !options.encryptionKey) {
      throw new Error("encryptionKey é obrigatória quando requireEncryption ou requireSqlCipher está ativo.");
    }
    this.dbPath = dbPath;
    this.workPath = dbPath;
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.encryptionKey = options.encryptionKey;
    this.sqliteVecPath = options.sqliteVecPath;
    this.db = this.openDatabase(dbPath, options.sqliteVecPath, options.requireSqlCipher);
    if (options.requireSqlCipher && !this.sqlCipherActive) {
      this.close();
      throw new Error("SQLCipher nativo obrigatório, mas indisponível neste runtime.");
    }
    this.migrate();
  }

  private openDatabase(path: string, sqliteVecPath?: string, requireSqlCipher = false): EdgeSqlite {
    if (requireSqlCipher) {
      try {
        const CipherDatabase = require("better-sqlite3-multiple-ciphers") as new (path: string, options?: object) => EdgeSqlite & { pragma(source: string): unknown };
        const db = new CipherDatabase(path, { readonly: false, fileMustExist: false });
        db.pragma("cipher='sqlcipher'");
        db.pragma("legacy=4");
        db.pragma(`key='${this.encryptionKey!.replace(/'/g, "''")}'`);
        db.prepare("SELECT count(*) FROM sqlite_master").get();
        this.sqlCipherActive = true;
        this.atRestEncrypted = true;
        this.encryptionMode = "sqlcipher";
        if (sqliteVecPath) {
          try { db.loadExtension(sqliteVecPath); this.sqliteVecActive = true; }
          catch { this.warnings.push("Extensão sqlite-vec indisponível; operando em fallback lexical FTS5 puro."); }
        }
        return db;
      } catch (error) {
        throw new Error(`SQLCipher nativo obrigatório, mas indisponível ou a chave foi recusada: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let targetPath = path;
    if (this.encryptionKey && path !== ":memory:") {
      if (isEncryptedEdgeFile(path)) {
        const workPath = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.work`;
        const plainBytes = decryptEdgeBuffer(readFileSync(path), this.encryptionKey);
        writeFileSync(workPath, plainBytes, { mode: 0o600 });
        this.workPath = workPath;
        this.atRestEncrypted = true;
        this.encryptionMode = "aes-256-gcm-sealed";
        targetPath = workPath;
      } else {
        this.workPath = path;
      }
    }

    const db = new DatabaseSync(targetPath, { allowExtension: Boolean(sqliteVecPath) });
    if (this.encryptionKey) {
      try {
        const escaped = this.encryptionKey.replace(/'/g, "''");
        db.exec(`PRAGMA key = '${escaped}';`);
        const cipherRow = db.prepare(`PRAGMA cipher_version;`).get() as { cipher_version?: string } | undefined;
        if (cipherRow?.cipher_version) {
          this.sqlCipherActive = true;
          this.atRestEncrypted = true;
          this.encryptionMode = "sqlcipher";
        } else {
          this.sqlCipherActive = false;
          if (path !== ":memory:") {
            this.atRestEncrypted = true;
            this.encryptionMode = "aes-256-gcm-sealed";
            if (this.workPath === path) {
              this.workPath = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.work`;
              if (existsSync(path)) {
                db.close();
                renameSync(path, this.workPath);
                return this.reopenWorkDb(this.workPath, sqliteVecPath);
              }
              db.close();
              return this.reopenWorkDb(this.workPath, sqliteVecPath);
            }
          } else {
            this.warnings.push("SQLCipher nativo indisponível; banco em memória não persistido.");
          }
        }
      } catch {
        this.sqlCipherActive = false;
        if (path !== ":memory:") {
          this.atRestEncrypted = true;
          this.encryptionMode = "aes-256-gcm-sealed";
        }
      }
    }
    if (sqliteVecPath) {
      try {
        db.loadExtension(sqliteVecPath);
        this.sqliteVecActive = true;
      } catch {
        this.sqliteVecActive = false;
        this.warnings.push("Extensão sqlite-vec indisponível; operando em fallback lexical FTS5 puro.");
      }
    } else {
      this.warnings.push("sqlite-vec não configurado; operando em fallback lexical FTS5.");
    }
    return db;
  }

  private reopenWorkDb(workPath: string, sqliteVecPath?: string): DatabaseSync {
    const db = new DatabaseSync(workPath, { allowExtension: Boolean(sqliteVecPath) });
    if (sqliteVecPath) {
      try {
        db.loadExtension(sqliteVecPath);
        this.sqliteVecActive = true;
      } catch {
        this.sqliteVecActive = false;
        this.warnings.push("Extensão sqlite-vec indisponível; operando em fallback lexical FTS5 puro.");
      }
    }
    return db;
  }

  getSecurityStatus(): {
    sqlCipherActive: boolean;
    atRestEncrypted: boolean;
    encryptionMode: "sqlcipher" | "aes-256-gcm-sealed" | "none";
    warnings: string[];
  } {
    return {
      sqlCipherActive: this.sqlCipherActive,
      atRestEncrypted: this.atRestEncrypted,
      encryptionMode: this.encryptionMode,
      warnings: [...this.warnings]
    };
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  private migrate(): void {
    const row = this.db.prepare(`PRAGMA user_version`).get() as { user_version?: number } | undefined;
    const version = row?.user_version ?? 0;

    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS edge_items (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          access_policy_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS edge_fts USING fts5(
          id UNINDEXED,
          title,
          content
        );
        CREATE TABLE IF NOT EXISTS edge_staging (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          base_version INTEGER,
          promoted_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sync_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS edge_vectors (
          id TEXT PRIMARY KEY,
          vector_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS edge_runner_tasks (
          task_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          instruction TEXT NOT NULL,
          cron TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS edge_relations (
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          PRIMARY KEY (from_id, to_id, relation_type)
        );
        PRAGMA user_version = 3;
      `);
    } else if (version < 2) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS edge_runner_tasks (
          task_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          instruction TEXT NOT NULL,
          cron TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS edge_relations (
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          PRIMARY KEY (from_id, to_id, relation_type)
        );
        PRAGMA user_version = 3;
      `);
    } else if (version < 3) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS edge_relations (
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 1.0,
          PRIMARY KEY (from_id, to_id, relation_type)
        );
        PRAGMA user_version = 3;
      `);
    }

    const migratedVersion = this.db.prepare(`PRAGMA user_version`).get() as { user_version?: number } | undefined;
    if ((migratedVersion?.user_version ?? 0) < 4) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE edge_runner_tasks ADD COLUMN result_summary TEXT;
        ALTER TABLE edge_runner_tasks ADD COLUMN model_usage_json TEXT;
        PRAGMA user_version = 4;
        COMMIT;
      `);
    }
  }

  getSyncCursor(): { syncSeq: number; policyEpoch: number } {
    const seqRow = this.db.prepare(`SELECT value FROM sync_state WHERE key = 'sync_seq'`).get() as
      | { value: string }
      | undefined;
    const epochRow = this.db.prepare(`SELECT value FROM sync_state WHERE key = 'policy_epoch'`).get() as
      | { value: string }
      | undefined;
    return {
      syncSeq: seqRow ? Number.parseInt(seqRow.value, 10) || 0 : 0,
      policyEpoch: epochRow ? Number.parseInt(epochRow.value, 10) || 1 : 1
    };
  }

  listKnownPolicies(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT access_policy_id FROM edge_items ORDER BY access_policy_id`)
      .all() as Array<{ access_policy_id: string }>;
    return rows.map((row) => row.access_policy_id);
  }

  setSyncCursor(syncSeq: number, policyEpoch = 1): void {
    this.db.prepare(`INSERT OR REPLACE INTO sync_state (key, value) VALUES ('sync_seq', ?)`).run(String(syncSeq));
    this.db.prepare(`INSERT OR REPLACE INTO sync_state (key, value) VALUES ('policy_epoch', ?)`).run(String(policyEpoch));
  }

  /**
   * Rebuild atômico em SQLite temporário + swap quando há troca de policy_epoch (hybrid-edge-sync.md §2).
   */
  atomicRebuildSnapshot(items: EdgeItemRecord[], syncSeq: number, policyEpoch: number): void {
    this.beginAtomicSnapshotRebuild();
    try {
      this.appendAtomicSnapshotPage(items);
      this.commitAtomicSnapshotRebuild(syncSeq, policyEpoch);
    } catch (err) {
      this.abortAtomicSnapshotRebuild();
      throw err;
    }
  }

  beginAtomicSnapshotRebuild(): void {
    this.abortAtomicSnapshotRebuild();
    const snapshotPath = `${this.dbPath}.rebuild.${Date.now()}.${randomUUID()}.tmp`;
    this.pendingSnapshotDatabase = new EdgeDatabase(snapshotPath, {
      encryptionKey: this.encryptionKey,
      sqliteVecPath: this.sqliteVecPath,
      requireSqlCipher: this.sqlCipherActive
    });
    this.pendingSnapshotPath = snapshotPath;
  }

  appendAtomicSnapshotPage(items: readonly EdgeItemRecord[]): void {
    if (!this.pendingSnapshotDatabase) throw new Error("Snapshot Edge temporário não iniciado.");
    for (const item of items) this.pendingSnapshotDatabase.upsertItem(item);
  }

  commitAtomicSnapshotRebuild(syncSeq: number, policyEpoch: number): void {
    const snapshot = this.pendingSnapshotDatabase;
    const snapshotPath = this.pendingSnapshotPath;
    if (!snapshot || !snapshotPath) throw new Error("Snapshot Edge temporário não iniciado.");
    const backupPath = `${this.dbPath}.previous.${randomUUID()}`;
    const previousWorkPath = this.workPath;
    let currentClosed = false;
    let snapshotInstalled = false;
    try {
      snapshot.setSyncCursor(syncSeq, policyEpoch);
      snapshot.close();
      this.db.close();
      currentClosed = true;
      if (previousWorkPath !== this.dbPath) rmSync(previousWorkPath, { force: true });
      this.workPath = this.dbPath;
      if (existsSync(this.dbPath)) renameSync(this.dbPath, backupPath);
      renameSync(snapshotPath, this.dbPath);
      snapshotInstalled = true;
      this.db = this.openDatabase(this.dbPath, this.sqliteVecPath, this.sqlCipherActive);
      this.migrate();
      rmSync(backupPath, { force: true });
      this.pendingSnapshotDatabase = undefined;
      this.pendingSnapshotPath = undefined;
    } catch (err) {
      if (snapshotInstalled) rmSync(this.dbPath, { force: true });
      if (existsSync(backupPath)) renameSync(backupPath, this.dbPath);
      if (currentClosed && existsSync(this.dbPath)) {
        this.workPath = this.dbPath;
        this.db = this.openDatabase(this.dbPath, this.sqliteVecPath, this.sqlCipherActive);
        this.migrate();
      }
      this.abortAtomicSnapshotRebuild();
      throw err;
    }
  }

  abortAtomicSnapshotRebuild(): void {
    const snapshot = this.pendingSnapshotDatabase;
    const snapshotPath = this.pendingSnapshotPath;
    this.pendingSnapshotDatabase = undefined;
    this.pendingSnapshotPath = undefined;
    if (snapshot) {
      const snapshotWorkPath = snapshot.workPath;
      try { snapshot.close(); } catch { /* cleanup still removes temporary files */ }
      if (snapshotWorkPath !== snapshotPath) rmSync(snapshotWorkPath, { force: true });
    }
    if (snapshotPath) {
      rmSync(snapshotPath, { force: true });
      rmSync(`${snapshotPath}-wal`, { force: true });
      rmSync(`${snapshotPath}-shm`, { force: true });
    }
  }

  issueOfflineLease(actorId: string, tenantId: string, ttlMs = DEFAULT_OFFLINE_LEASE_MS): OfflineLease {
    const clampedTtl = Math.min(Math.max(ttlMs, 1000), MAX_OFFLINE_LEASE_MS);
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + clampedTtl);
    const lease: OfflineLease = {
      actorId,
      tenantId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    const encoded = this.encryptionKey
      ? encryptEdgeSecret(JSON.stringify(lease), this.encryptionKey)
      : JSON.stringify(lease);
    this.db.prepare(`INSERT OR REPLACE INTO sync_state (key, value) VALUES ('offline_lease', ?)`).run(encoded);
    return lease;
  }

  hasOfflineLease(): boolean {
    const row = this.db.prepare(`SELECT 1 FROM sync_state WHERE key = 'offline_lease'`).get();
    return Boolean(row);
  }

  assertOfflineLeaseValid(now = new Date()): OfflineLease {
    const row = this.db.prepare(`SELECT value FROM sync_state WHERE key = 'offline_lease'`).get() as
      | { value: string }
      | undefined;
    if (!row) {
      throw new Error("Offline lease ausente. Conecte-se ao Hub para autenticar.");
    }
    const raw = this.encryptionKey ? decryptEdgeSecret(row.value, this.encryptionKey) : row.value;
    const lease = JSON.parse(raw) as OfflineLease;
    if (now.getTime() > new Date(lease.expiresAt).getTime()) {
      throw new Error("Offline lease expirado. Reconecte-se ao Hub/Keycloak para renovar.");
    }
    return lease;
  }

  upsertEdge(fromId: string, toId: string, relationType: string, confidence = 1.0): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO edge_relations (from_id, to_id, relation_type, confidence) VALUES (?, ?, ?, ?)`
      )
      .run(fromId, toId, relationType, confidence);
  }

  getRelatedItems(
    startId: string,
    maxDepth = 2
  ): Array<{ fromId: string; toId: string; relationType: string; confidence: number; depth: number }> {
    const depthLimit = Math.max(1, Math.min(maxDepth, 6));
    return this.db
      .prepare(
        `WITH RECURSIVE walk(from_id, to_id, relation_type, confidence, depth, visited) AS (
           SELECT from_id, to_id, relation_type, confidence, 1, ',' || from_id || ',' || to_id || ','
           FROM edge_relations
           WHERE from_id = ?
           UNION ALL
           SELECT r.from_id, r.to_id, r.relation_type, r.confidence, w.depth + 1, w.visited || r.to_id || ','
           FROM edge_relations r
           JOIN walk w ON r.from_id = w.to_id
           WHERE w.depth < ? AND instr(w.visited, ',' || r.to_id || ',') = 0
         )
         SELECT from_id AS fromId, to_id AS toId, relation_type AS relationType, confidence, depth
         FROM walk`
      )
      .all(startId, depthLimit) as Array<{
      fromId: string;
      toId: string;
      relationType: string;
      confidence: number;
      depth: number;
    }>;
  }

  upsertVector(id: string, vector: number[]): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO edge_vectors (id, vector_json) VALUES (?, ?)`)
      .run(id, JSON.stringify(vector));
  }

  searchVectors(queryVector: number[], limit = 10): Array<{ id: string; score: number }> {
    const rows = this.db.prepare(`SELECT id, vector_json FROM edge_vectors`).all() as Array<{
      id: string;
      vector_json: string;
    }>;
    const cosine = (a: number[], b: number[]): number => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
        const av = a[i] ?? 0;
        const bv = b[i] ?? 0;
        dot += av * bv;
        na += av * av;
        nb += bv * bv;
      }
      return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
    };
    return rows
      .map((r) => ({ id: r.id, score: cosine(queryVector, JSON.parse(r.vector_json) as number[]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  upsertItem(item: EdgeItemRecord): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO edge_items (id, project_id, title, content, access_policy_id, content_hash, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           access_policy_id = excluded.access_policy_id,
           content_hash = excluded.content_hash,
           version = excluded.version,
           updated_at = excluded.updated_at`
      )
      .run(
        item.id,
        item.projectId,
        item.title,
        item.content,
        item.accessPolicyId,
        item.contentHash,
        item.version ?? 1,
        now
      );

    this.db.prepare(`DELETE FROM edge_fts WHERE id = ?`).run(item.id);
    this.db.prepare(`INSERT INTO edge_fts (id, title, content) VALUES (?, ?, ?)`).run(item.id, item.title, item.content);
  }

  applyTombstones(itemIds: readonly string[]): number {
    let removed = 0;
    for (const id of itemIds) {
      this.db.prepare(`DELETE FROM edge_fts WHERE id = ?`).run(id);
      this.db.prepare(`DELETE FROM edge_vectors WHERE id = ?`).run(id);
      const res = this.db.prepare(`DELETE FROM edge_items WHERE id = ?`).run(id);
      removed += Number(res.changes ?? 0);
    }
    return removed;
  }

  searchFts(query: string, limit = 10): Array<{ id: string; title: string; content: string }> {
    return this.db
      .prepare(`SELECT id, title, content FROM edge_fts WHERE edge_fts MATCH ? LIMIT ?`)
      .all(query, limit) as Array<{ id: string; title: string; content: string }>;
  }

  revokePolicies(revokedPolicies: string[]): number {
    let removed = 0;
    for (const policy of revokedPolicies) {
      const rows = this.db
        .prepare(`SELECT id FROM edge_items WHERE access_policy_id = ?`)
        .all(policy) as Array<{ id: string }>;
      for (const r of rows) {
        this.db.prepare(`DELETE FROM edge_fts WHERE id = ?`).run(r.id);
        this.db.prepare(`DELETE FROM edge_vectors WHERE id = ?`).run(r.id);
        removed += 1;
      }
      this.db.prepare(`DELETE FROM edge_items WHERE access_policy_id = ?`).run(policy);
    }
    return removed;
  }

  stageDraft(id: string, title: string, content: string, baseVersion?: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO edge_staging (id, title, content, base_version, promoted_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)`
      )
      .run(id, title, content, baseVersion ?? null, new Date().toISOString());
  }

  markStagedPromoted(id: string, now = new Date()): void {
    this.db
      .prepare(`UPDATE edge_staging SET promoted_at = ? WHERE id = ?`)
      .run(now.toISOString(), id);
  }

  cleanupPromotedStaging(olderThanDays = 30, now = new Date()): number {
    const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const res = this.db
      .prepare(`DELETE FROM edge_staging WHERE promoted_at IS NOT NULL AND promoted_at < ?`)
      .run(cutoff);
    return Number(res.changes ?? 0);
  }

  listStaged(): Array<{ id: string; title: string; content: string; baseVersion?: number }> {
    const rows = this.db
      .prepare(`SELECT id, title, content, base_version FROM edge_staging WHERE promoted_at IS NULL`)
      .all() as Array<{ id: string; title: string; content: string; base_version: number | null }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      ...(r.base_version !== null ? { baseVersion: r.base_version } : {})
    }));
  }

  enqueueRunnerTask(projectId: string, instruction: string, cron?: string): EdgeRunnerTask {
    const task: EdgeRunnerTask = {
      taskId: `EDGE-RUN-${randomUUID().slice(0, 8)}`,
      projectId,
      instruction,
      cron,
      status: "queued",
      createdAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT INTO edge_runner_tasks (task_id, project_id, instruction, cron, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(task.taskId, task.projectId, task.instruction, task.cron ?? null, task.status, task.createdAt);
    return task;
  }

  listPendingRunnerTasks(): EdgeRunnerTask[] {
    const rows = this.db
      .prepare(`SELECT task_id, project_id, instruction, cron, status, created_at FROM edge_runner_tasks WHERE status = 'queued'`)
      .all() as Array<{
      task_id: string;
      project_id: string;
      instruction: string;
      cron: string | null;
      status: EdgeRunnerTask["status"];
      created_at: string;
    }>;
    return rows.map((r) => ({
      taskId: r.task_id,
      projectId: r.project_id,
      instruction: r.instruction,
      ...(r.cron ? { cron: r.cron } : {}),
      status: r.status,
      createdAt: r.created_at
    }));
  }

  listRunnerTasks(projectId?: string): EdgeRunnerTask[] {
    const rows = (projectId
      ? this.db.prepare(`SELECT task_id, project_id, instruction, cron, status, created_at, result_summary, model_usage_json
                         FROM edge_runner_tasks WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`).all(projectId)
      : this.db.prepare(`SELECT task_id, project_id, instruction, cron, status, created_at, result_summary, model_usage_json
                         FROM edge_runner_tasks ORDER BY created_at DESC, rowid DESC`).all()) as Array<{
      task_id: string;
      project_id: string;
      instruction: string;
      cron: string | null;
      status: EdgeRunnerTask["status"];
      created_at: string;
      result_summary: string | null;
      model_usage_json: string | null;
    }>;
    return rows.map((row) => ({
      taskId: row.task_id,
      projectId: row.project_id,
      instruction: row.instruction,
      ...(row.cron ? { cron: row.cron } : {}),
      status: row.status,
      createdAt: row.created_at,
      ...(row.result_summary ? { resultSummary: row.result_summary } : {}),
      ...(row.model_usage_json ? { modelUsage: JSON.parse(row.model_usage_json) as Record<string, unknown> } : {})
    }));
  }

  claimNextRunnerTask(projectId?: string): EdgeRunnerTask | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = (
        projectId
          ? this.db
              .prepare(
                `SELECT task_id, project_id, instruction, cron, status, created_at
                 FROM edge_runner_tasks
                 WHERE status = 'queued' AND project_id = ?
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT 1`
              )
              .get(projectId)
          : this.db
              .prepare(
                `SELECT task_id, project_id, instruction, cron, status, created_at
                 FROM edge_runner_tasks
                 WHERE status = 'queued'
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT 1`
              )
              .get()
      ) as
        | {
            task_id: string;
            project_id: string;
            instruction: string;
            cron: string | null;
            status: EdgeRunnerTask["status"];
            created_at: string;
          }
        | undefined;

      if (!row) {
        this.db.exec("COMMIT");
        return undefined;
      }

      const res = this.db
        .prepare(`UPDATE edge_runner_tasks SET status = 'running' WHERE task_id = ? AND status = 'queued'`)
        .run(row.task_id);
      this.db.exec("COMMIT");

      if (Number(res.changes ?? 0) === 0) {
        return undefined;
      }

      return {
        taskId: row.task_id,
        projectId: row.project_id,
        instruction: row.instruction,
        ...(row.cron ? { cron: row.cron } : {}),
        status: "running",
        createdAt: row.created_at
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  completeRunnerTask(
    taskId: string,
    status: "completed" | "failed" | "escalated" = "completed",
    resultSummary?: string,
    modelUsage?: Record<string, unknown>
  ): void {
    this.db.prepare(`UPDATE edge_runner_tasks SET status = ?, result_summary = ?, model_usage_json = ? WHERE task_id = ?`)
      .run(status, resultSummary ?? null, modelUsage ? JSON.stringify(modelUsage) : null, taskId);
  }

  close(): void {
    this.abortAtomicSnapshotRebuild();
    this.db.close();
    if (this.sqlCipherActive) return;
    if (this.atRestEncrypted && !this.sqlCipherActive && this.encryptionKey && this.dbPath !== ":memory:") {
      if (existsSync(this.workPath)) {
        const plainBytes = readFileSync(this.workPath);
        const sealed = encryptEdgeBuffer(plainBytes, this.encryptionKey);
        const stagePath = `${this.dbPath}.${process.pid}.seal.tmp`;
        writeFileSync(stagePath, sealed, { mode: 0o600 });
        renameSync(stagePath, this.dbPath);
        rmSync(this.workPath, { force: true });
        rmSync(`${this.workPath}-wal`, { force: true });
        rmSync(`${this.workPath}-shm`, { force: true });
      }
    }
  }
}

