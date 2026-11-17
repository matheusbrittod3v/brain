import assert from "node:assert/strict";
import test from "node:test";
import { createAppPostgresClient } from "@noema/database";
import {
  InMemoryKnowledgeRepository,
  PostgresKnowledgeRepository,
  SqlKnowledgeRepository,
  computeContentHash,
  parseKnowledgeFile,
  privacyEraseSubject,
  type KnowledgeItemRow,
  type KnowledgeItemVersionRow,
  type KnowledgeRepository,
  type KnowledgeSqlParameter,
  type KnowledgeSqlTransactionRunner,
  type RlsSessionContext
} from "../src/index.js";

/**
 * Stateful fake PostgreSQL engine that enforces the exact table structures,
 * transaction-local GUCs (`app.current_tenant_id`, `app.allowed_projects`, `app.allowed_policies`),
 * RLS predicates (`USING` / `WITH CHECK`), and `knowledge_embeddings` cleanup without a live database.
 */
class StatefulFakeKnowledgeDb {
  public readonly items = new Map<string, KnowledgeItemRow>();
  public readonly versions: KnowledgeItemVersionRow[] = [];
  public readonly syncChanges: Array<{ tenantId: string; projectId: string; itemId: string; contentHash: string; accessPolicyId: string }> = [];
  public readonly embeddings = new Map<string, number>();
  public readonly recordedQueries: Array<{ sql: string; params: readonly KnowledgeSqlParameter[] }> = [];
  /** Keys hidden from the next matching SELECT only (simulates a row becoming visible mid-transaction). */
  public readonly hideNextSelectKeys = new Set<string>();
  public beginCalls = 0;

  seedEmbeddings(tenantId: string, projectId: string, itemId: string, chunkCount: number): void {
    this.embeddings.set(`${tenantId}:${projectId}:${itemId}`, chunkCount);
  }

  getEmbeddingCount(tenantId: string, projectId: string, itemId: string): number {
    return this.embeddings.get(`${tenantId}:${projectId}:${itemId}`) ?? 0;
  }

  createAppClient() {
    return createAppPostgresClient<KnowledgeSqlTransactionRunner>({
      databaseUrl: "postgresql://brain_app:dev-secret@localhost:5432/project_brain_os",
      createSql: () => ({
        begin: async <T>(cb: (tx: KnowledgeSqlTransactionRunner) => T | Promise<T>): Promise<T> => {
          this.beginCalls += 1;
          let gucTenant = "";
          let gucProjects = new Set<string>();
          let gucPolicies = new Set<string>();

          const assertRlsRowVisible = (tenantId: string, projectId: string, policyId: string) => {
            return (
              gucTenant.length > 0 &&
              tenantId === gucTenant &&
              gucProjects.has(projectId) &&
              gucPolicies.has(policyId)
            );
          };

          const tx: KnowledgeSqlTransactionRunner = async <TRow = Record<string, unknown>>(
            template: TemplateStringsArray,
            ...params: readonly KnowledgeSqlParameter[]
          ): Promise<readonly TRow[]> => {
            const sql = template.join("$P$").replace(/\s+/g, " ").trim();
            this.recordedQueries.push({ sql, params });

            // 1. GUC configuration
            if (sql.includes("set_config('app.current_tenant_id'")) {
              gucTenant = String(params[0] ?? "");
              gucProjects = new Set(String(params[1] ?? "").split(",").filter(Boolean));
              gucPolicies = new Set(String(params[2] ?? "").split(",").filter(Boolean));
              return [] as unknown as readonly TRow[];
            }

            // Fail-closed if GUCs were not set first in this transaction
            if (!gucTenant || gucProjects.size === 0 || gucPolicies.size === 0) {
              throw new Error("RLS fail-closed: transaction executed query before setting GUCs");
            }

            if (sql.startsWith("INSERT INTO sync_project_locks")) {
              const [tenantId, projectId] = params as [string, string];
              if (!gucProjects.has(projectId) || tenantId !== gucTenant) {
                throw new Error("RLS WITH CHECK violation on INSERT INTO sync_project_locks");
              }
              return [] as unknown as readonly TRow[];
            }

            // 2. SELECT FROM knowledge_items
            if (sql.startsWith("SELECT") && sql.includes("FROM knowledge_items")) {
              const [tenantId, projectId, id] = params as [string, string, string];
              const requireNotDeleted = sql.includes("deleted_at IS NULL");
              const key = `${tenantId}:${projectId}:${id}`;
              if (this.hideNextSelectKeys.delete(key)) {
                return [] as unknown as readonly TRow[];
              }
              const row = this.items.get(key);
              if (!row) return [] as unknown as readonly TRow[];
              if (!assertRlsRowVisible(row.tenant_id, row.project_id, row.access_policy_id)) {
                return [] as unknown as readonly TRow[];
              }
              if (requireNotDeleted && row.deleted_at !== null) {
                return [] as unknown as readonly TRow[];
              }
              return [structuredClone(row) as unknown as TRow];
            }

            // 3. INSERT INTO knowledge_items
            if (sql.startsWith("INSERT INTO knowledge_items")) {
              const [
                id,
                tenant_id,
                project_id,
                domain_id,
                type,
                title,
                content,
                summary,
                status,
                source_id,
                source_origin,
                source_kind,
                source_version,
                source_uri,
                version,
                content_hash,
                owner_id,
                confidence,
                trust_level,
                is_inferred,
                valid_from,
                valid_until,
                tags,
                access_policy_id,
                metadataJson,
                created_at,
                updated_at
              ] = params;

              if (!assertRlsRowVisible(String(tenant_id), String(project_id), String(access_policy_id))) {
                throw new Error("RLS WITH CHECK violation on INSERT INTO knowledge_items");
              }

              const insertKey = `${String(tenant_id)}:${String(project_id)}:${String(id)}`;
              const hasConflict = this.items.has(insertKey);
              if (sql.includes("ON CONFLICT")) {
                // ON CONFLICT DO NOTHING: a conflicting row (visible or RLS-hidden)
                // yields no RETURNING row and no error.
                if (hasConflict) return [] as unknown as readonly TRow[];
              } else if (hasConflict) {
                const conflictError = new Error(
                  'duplicate key value violates unique constraint "knowledge_items_tenant_id_project_id_id_pk"'
                ) as Error & { code?: string };
                conflictError.code = "23505";
                throw conflictError;
              }

              const row: KnowledgeItemRow = {
                id: String(id),
                tenant_id: String(tenant_id),
                project_id: String(project_id),
                domain_id: Number(domain_id),
                type: String(type),
                title: String(title),
                content: String(content),
                summary: summary !== null ? String(summary) : null,
                status: String(status),
                source_id: String(source_id),
                source_origin: String(source_origin),
                source_kind: String(source_kind),
                source_version: String(source_version),
                source_uri: String(source_uri),
                version: Number(version),
                content_hash: String(content_hash),
                owner_id: owner_id !== null ? String(owner_id) : null,
                confidence: Number(confidence),
                trust_level: String(trust_level),
                is_inferred: Boolean(is_inferred),
                valid_from: valid_from !== null ? String(valid_from) : null,
                valid_until: valid_until !== null ? String(valid_until) : null,
                tags: Array.isArray(tags) ? [...tags] : [],
                access_policy_id: String(access_policy_id),
                metadata: JSON.parse(String(metadataJson)),
                deleted_at: null,
                created_at: String(created_at),
                updated_at: String(updated_at)
              };

              this.items.set(`${row.tenant_id}:${row.project_id}:${row.id}`, row);
              return [structuredClone(row) as unknown as TRow];
            }

            // 4. UPDATE knowledge_items (softDeleteItem)
            if (sql.startsWith("UPDATE knowledge_items") && sql.includes("deleted_at = $P$::timestamptz")) {
              const [deletedAt, updatedAt, tenantId, projectId, id] = params as [
                string,
                string,
                string,
                string,
                string
              ];
              const key = `${tenantId}:${projectId}:${id}`;
              const existing = this.items.get(key);
              if (
                !existing ||
                existing.deleted_at !== null ||
                !assertRlsRowVisible(existing.tenant_id, existing.project_id, existing.access_policy_id)
              ) {
                return [] as unknown as readonly TRow[];
              }
              existing.deleted_at = deletedAt;
              existing.updated_at = updatedAt;
              return [{ id: existing.id } as unknown as TRow];
            }

            // 5. UPDATE knowledge_items (upsertItem version bump)
            if (sql.startsWith("UPDATE knowledge_items")) {
              const [
                domain_id,
                type,
                title,
                content,
                summary,
                status,
                source_id,
                source_origin,
                source_kind,
                source_version,
                source_uri,
                version,
                content_hash,
                owner_id,
                confidence,
                trust_level,
                is_inferred,
                valid_from,
                valid_until,
                tags,
                access_policy_id,
                metadataJson,
                updated_at,
                tenant_id,
                project_id,
                id
              ] = params;

              const key = `${String(tenant_id)}:${String(project_id)}:${String(id)}`;
              const existing = this.items.get(key);
              if (
                !existing ||
                !assertRlsRowVisible(existing.tenant_id, existing.project_id, existing.access_policy_id)
              ) {
                return [] as unknown as readonly TRow[];
              }
              if (!assertRlsRowVisible(String(tenant_id), String(project_id), String(access_policy_id))) {
                throw new Error("RLS WITH CHECK violation on UPDATE knowledge_items");
              }

              const updated: KnowledgeItemRow = {
                ...existing,
                domain_id: Number(domain_id),
                type: String(type),
                title: String(title),
                content: String(content),
                summary: summary !== null ? String(summary) : null,
                status: String(status),
                source_id: String(source_id),
                source_origin: String(source_origin),
                source_kind: String(source_kind),
                source_version: String(source_version),
                source_uri: String(source_uri),
                version: Number(version),
                content_hash: String(content_hash),
                owner_id: owner_id !== null ? String(owner_id) : null,
                confidence: Number(confidence),
                trust_level: String(trust_level),
                is_inferred: Boolean(is_inferred),
                valid_from: valid_from !== null ? String(valid_from) : null,
                valid_until: valid_until !== null ? String(valid_until) : null,
                tags: Array.isArray(tags) ? [...tags] : [],
                access_policy_id: String(access_policy_id),
                metadata: JSON.parse(String(metadataJson)),
                deleted_at: null,
                updated_at: String(updated_at)
              };
              this.items.set(key, updated);
              return [structuredClone(updated) as unknown as TRow];
            }

            // 6. INSERT INTO knowledge_item_versions
            if (sql.startsWith("INSERT INTO knowledge_item_versions")) {
              const [
                tenant_id,
                project_id,
                item_id,
                version,
                domain_id,
                type,
                title,
                summary,
                status,
                source_origin,
                source_kind,
                source_version,
                content_hash,
                owner_id,
                confidence,
                trust_level,
                is_inferred,
                tags,
                access_policy_id,
                content,
                metadataJson,
                created_at
              ] = params;

              if (!assertRlsRowVisible(String(tenant_id), String(project_id), String(access_policy_id))) {
                throw new Error("RLS WITH CHECK violation on INSERT INTO knowledge_item_versions");
              }

              const vRow: KnowledgeItemVersionRow = {
                tenant_id: String(tenant_id),
                project_id: String(project_id),
                item_id: String(item_id),
                version: Number(version),
                domain_id: Number(domain_id),
                type: String(type),
                title: String(title),
                summary: summary !== null ? String(summary) : null,
                status: String(status),
                source_origin: String(source_origin),
                source_kind: String(source_kind),
                source_version: String(source_version),
                content_hash: String(content_hash),
                owner_id: owner_id !== null ? String(owner_id) : null,
                confidence: Number(confidence),
                trust_level: String(trust_level),
                is_inferred: Boolean(is_inferred),
                tags: Array.isArray(tags) ? [...tags] : [],
                access_policy_id: String(access_policy_id),
                content: String(content),
                metadata: JSON.parse(String(metadataJson)),
                created_at: String(created_at)
              };
              this.versions.push(vRow);
              return [] as unknown as readonly TRow[];
            }

            if (sql.startsWith("INSERT INTO sync_changes")) {
              const [tenantId, projectId, itemId, contentHash, accessPolicyId] = params.map(String);
              if (!assertRlsRowVisible(tenantId!, projectId!, accessPolicyId!)) {
                throw new Error("RLS WITH CHECK violation on INSERT INTO sync_changes");
              }
              this.syncChanges.push({ tenantId: tenantId!, projectId: projectId!, itemId: itemId!, contentHash: contentHash!, accessPolicyId: accessPolicyId! });
              return [{ sync_seq: this.syncChanges.length } as unknown as TRow];
            }

            // 7. SELECT FROM knowledge_item_versions
            if (sql.startsWith("SELECT") && sql.includes("FROM knowledge_item_versions")) {
              const [tenantId, projectId, itemId] = params as [string, string, string];
              const rows = this.versions
                .filter(
                  (v) =>
                    v.tenant_id === tenantId &&
                    v.project_id === projectId &&
                    v.item_id === itemId &&
                    assertRlsRowVisible(v.tenant_id, v.project_id, v.access_policy_id)
                )
                .sort((a, b) => a.version - b.version);
              return rows.map((r) => structuredClone(r) as unknown as TRow);
            }

            // 8. DELETE FROM knowledge_embeddings
            if (sql.startsWith("DELETE FROM knowledge_embeddings")) {
              const [tenantId, projectId, itemId] = params as [string, string, string];
              this.embeddings.delete(`${tenantId}:${projectId}:${itemId}`);
              return [] as unknown as readonly TRow[];
            }

            throw new Error(`Unexpected SQL in StatefulFakeKnowledgeDb: ${sql}`);
          };

          return await cb(tx);
        }
      })
    });
  }
}

async function runSharedKnowledgeRepositoryContract(
  label: string,
  createHarness: () => {
    repo: KnowledgeRepository;
    seedEmbeddings: (tenantId: string, projectId: string, itemId: string, count: number) => void;
    getEmbeddingCount: (tenantId: string, projectId: string, itemId: string) => number;
    getSyncChangeCount?: () => number;
  }
) {
  await test(`shared contract (${label}): parseKnowledgeFile -> idempotent upsert -> version bump -> policy isolation -> softDelete + embedding cleanup -> revival`, async () => {
    const { repo, seedEmbeddings, getEmbeddingCount, getSyncChangeCount } = createHarness();

    const rlsCtx: RlsSessionContext = {
      tenantId: "acme",
      allowedProjects: ["__org__", "sub-platform"],
      allowedPolicies: ["public-org", "internal-project"]
    };

    const rawV1 = `---
id: BR-SUB-014
type: business_rule
title: Cancelamento de assinatura
status: approved
owner: billing-squad
access_policy: internal-project
summary: Regra inicial de cancelamento
tags:
  - billing
  - churn
---
O cliente pode cancelar a assinatura a qualquer momento sem multa.`;

    const parsedV1 = parseKnowledgeFile({
      tenantId: "acme",
      projectId: "sub-platform",
      filePath: ".brain/01-business/BR-SUB-014.md",
      rawContent: rawV1,
      commitSha: "commit-111"
    });
    parsedV1.relatedIds = ["ADR-001"];

    // 1. Initial insert creates version 1 and snapshot v1
    const firstUpsert = await repo.upsertItem(rlsCtx, parsedV1);
    assert.equal(firstUpsert.versionCreated, true);
    assert.equal(firstUpsert.item.id, "BR-SUB-014");
    assert.equal(firstUpsert.item.version, 1);
    assert.equal(firstUpsert.item.domainId, 2);
    assert.deepEqual(firstUpsert.item.tags, ["billing", "churn"]);
    assert.deepEqual(firstUpsert.item.relatedIds, ["ADR-001"]);
    if (getSyncChangeCount) assert.equal(getSyncChangeCount(), 1, "new item is journaled");

    // 2. Re-upserting identical contentHash is idempotent (no new version snapshot)
    const duplicateUpsert = await repo.upsertItem(rlsCtx, {
      ...parsedV1,
      sourceVersion: "commit-111-reindexed"
    });
    assert.equal(duplicateUpsert.versionCreated, false);
    assert.equal(duplicateUpsert.item.version, 1);
    if (getSyncChangeCount) assert.equal(getSyncChangeCount(), 1, "idempotent upsert does not add a sync event");

    const versionsAfterDuplicate = await repo.listVersions(rlsCtx, "sub-platform", "BR-SUB-014");
    assert.equal(versionsAfterDuplicate.length, 1);
    assert.equal(versionsAfterDuplicate[0]!.version, 1);
    assert.equal(versionsAfterDuplicate[0]!.contentHash, parsedV1.contentHash);

    // 3. Upserting modified content increments version to 2 and appends immutable v2 snapshot
    const rawV2 = rawV1.replace("sem multa.", "com retenção proporcional até o fim do ciclo.");
    const parsedV2 = parseKnowledgeFile({
      tenantId: "acme",
      projectId: "sub-platform",
      filePath: ".brain/01-business/BR-SUB-014.md",
      rawContent: rawV2,
      commitSha: "commit-222"
    });

    const secondUpsert = await repo.upsertItem(rlsCtx, parsedV2);
    assert.equal(secondUpsert.versionCreated, true);
    assert.equal(secondUpsert.item.version, 2);
    assert.equal(secondUpsert.item.sourceVersion, "commit-222");
    assert.equal(secondUpsert.item.contentHash, computeContentHash(rawV2));
    if (getSyncChangeCount) assert.equal(getSyncChangeCount(), 2, "new version is journaled");

    const versionsAfterUpdate = await repo.listVersions(rlsCtx, "sub-platform", "BR-SUB-014");
    assert.equal(versionsAfterUpdate.length, 2);
    assert.deepEqual(
      versionsAfterUpdate.map((v) => ({ version: v.version, sourceVersion: v.sourceVersion })),
      [
        { version: 1, sourceVersion: "commit-111" },
        { version: 2, sourceVersion: "commit-222" }
      ]
    );

    // 4. Policy isolation: a session without 'internal-project' cannot read item or its versions
    const publicOnlyCtx: RlsSessionContext = {
      tenantId: "acme",
      allowedProjects: ["sub-platform"],
      allowedPolicies: ["public-org"]
    };
    assert.equal(await repo.getItem(publicOnlyCtx, "sub-platform", "BR-SUB-014"), undefined);
    assert.deepEqual(await repo.listVersions(publicOnlyCtx, "sub-platform", "BR-SUB-014"), []);

    // 5. Soft delete sets tombstone, hides item from getItem, and atomically deletes embeddings
    seedEmbeddings("acme", "sub-platform", "BR-SUB-014", 4);
    assert.equal(getEmbeddingCount("acme", "sub-platform", "BR-SUB-014"), 4);

    const deleted = await repo.softDeleteItem(rlsCtx, "sub-platform", "BR-SUB-014", "2026-11-16T20:00:00.000Z");
    assert.equal(deleted, true);
    assert.equal(await repo.getItem(rlsCtx, "sub-platform", "BR-SUB-014"), undefined);
    assert.equal(getEmbeddingCount("acme", "sub-platform", "BR-SUB-014"), 0);

    // Second softDelete on already-tombstoned item returns false
    assert.equal(await repo.softDeleteItem(rlsCtx, "sub-platform", "BR-SUB-014"), false);

    // Append-only versions remain intact even after tombstone
    assert.equal((await repo.listVersions(rlsCtx, "sub-platform", "BR-SUB-014")).length, 2);

    // 6. Re-ingesting a tombstoned item revives it with version = 3 and clears deletedAt
    const revived = await repo.upsertItem(rlsCtx, parsedV2);
    assert.equal(revived.versionCreated, true);
    assert.equal(revived.item.version, 3);
    assert.equal(revived.item.deletedAt, undefined);
    if (getSyncChangeCount) assert.equal(getSyncChangeCount(), 3, "revival is journaled");
    assert.equal((await repo.listVersions(rlsCtx, "sub-platform", "BR-SUB-014")).length, 3);
  });
}

await runSharedKnowledgeRepositoryContract("InMemoryKnowledgeRepository", () => {
  const repo = new InMemoryKnowledgeRepository();
  return {
    repo,
    seedEmbeddings: (t, p, id, count) => repo.seedEmbeddingCountForItem(t, p, id, count),
    getEmbeddingCount: (t, p, id) => repo.getEmbeddingCountForItem(t, p, id)
  };
});

await runSharedKnowledgeRepositoryContract("PostgresKnowledgeRepository (SqlKnowledgeRepository)", () => {
  const fakeDb = new StatefulFakeKnowledgeDb();
  const repo = new SqlKnowledgeRepository(fakeDb.createAppClient());
  return {
    repo,
    seedEmbeddings: (t, p, id, count) => fakeDb.seedEmbeddings(t, p, id, count),
    getEmbeddingCount: (t, p, id) => fakeDb.getEmbeddingCount(t, p, id),
    getSyncChangeCount: () => fakeDb.syncChanges.length
  };
});

test("PostgresKnowledgeRepository rejects unauthorized tenant, project, or policy BEFORE opening an RLS transaction", async () => {
  const fakeDb = new StatefulFakeKnowledgeDb();
  const repo = new PostgresKnowledgeRepository(fakeDb.createAppClient());

  const baseItem = parseKnowledgeFile({
    tenantId: "acme",
    projectId: "proj-a",
    filePath: ".brain/00-overview/vision.md",
    rawContent: "# Vision"
  });

  const baseCtx: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["proj-a"],
    allowedPolicies: ["internal-project"]
  };

  // Mismatched tenant
  await assert.rejects(
    () => repo.upsertItem(baseCtx, { ...baseItem, tenantId: "other-tenant" }),
    /does not match RLS context tenantId/
  );
  // Unauthorized project (e.g. __org__ when not in allowedProjects)
  await assert.rejects(
    () => repo.upsertItem(baseCtx, { ...baseItem, projectId: "__org__" }),
    /not authorized in RLS context allowedProjects/
  );
  // Unauthorized policy
  await assert.rejects(
    () => repo.upsertItem(baseCtx, { ...baseItem, accessPolicyId: "restricted-security" }),
    /not authorized in RLS context allowedPolicies/
  );
  // Unauthorized project on getItem / listVersions / softDeleteItem
  await assert.rejects(() => repo.getItem(baseCtx, "proj-b", "ID-1"), /allowedProjects/);
  await assert.rejects(() => repo.listVersions(baseCtx, "__org__", "ID-1"), /allowedProjects/);
  await assert.rejects(() => repo.softDeleteItem(baseCtx, "proj-b", "ID-1"), /allowedProjects/);

  assert.equal(fakeDb.beginCalls, 0, "No database transaction may be opened when validation fails");
});

test("PostgresKnowledgeRepository binds SQL parameters separately and never interpolates untrusted strings into SQL", async () => {
  const fakeDb = new StatefulFakeKnowledgeDb();
  const repo = new PostgresKnowledgeRepository(fakeDb.createAppClient());

  const ctx: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["proj-a"],
    allowedPolicies: ["internal-project"]
  };

  const trickyTitle = "Rule '; DROP TABLE knowledge_items; --";
  const item = parseKnowledgeFile({
    tenantId: "acme",
    projectId: "proj-a",
    filePath: ".brain/01-business/BR-SQLI.md",
    rawContent: `---\nid: BR-SQLI\ntitle: "${trickyTitle}"\n---\nBody with $1 and '; DELETE FROM audit_logs;`
  });

  await repo.upsertItem(ctx, item);

  for (const q of fakeDb.recordedQueries) {
    assert.ok(!q.sql.includes("DROP TABLE"), "SQL template must never contain interpolated user title");
    assert.ok(!q.sql.includes("DELETE FROM audit_logs"), "SQL template must never contain interpolated body");
  }
});

test("PostgresKnowledgeRepository fails closed with a semantic error when the existing row is hidden by RLS (no raw 23505)", async () => {
  const fakeDb = new StatefulFakeKnowledgeDb();
  const repo = new PostgresKnowledgeRepository(fakeDb.createAppClient());

  const ctx: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["sub-platform"],
    allowedPolicies: ["internal-project"]
  };

  const hidden = parseKnowledgeFile({
    tenantId: "acme",
    projectId: "sub-platform",
    filePath: ".brain/01-business/BR-HIDDEN.md",
    rawContent: "---\nid: BR-HIDDEN\n---\nHidden body"
  });

  // Seed a row governed by a policy outside the session's allowedPolicies,
  // bypassing the fake's WITH CHECK (as a DBA-created row would exist).
  fakeDb.items.set("acme:sub-platform:BR-HIDDEN", {
    id: "BR-HIDDEN",
    tenant_id: "acme",
    project_id: "sub-platform",
    domain_id: 2,
    type: "business_rule",
    title: "Hidden",
    content: "Hidden body",
    summary: null,
    status: "approved",
    source_id: "src",
    source_origin: "internal",
    source_kind: "git",
    source_version: "commit-1",
    source_uri: ".brain/01-business/BR-HIDDEN.md",
    version: 1,
    content_hash: "other-hash",
    owner_id: null,
    confidence: 1,
    trust_level: "verified",
    is_inferred: false,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: null,
    tags: [],
    access_policy_id: "restricted-security",
    metadata: {},
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  });

  await assert.rejects(
    () => repo.upsertItem(ctx, hidden),
    /already exists.*not visible or authorized.*fail-closed/s
  );

  // The row must remain untouched: no version bump, no snapshot appended.
  assert.equal(fakeDb.items.get("acme:sub-platform:BR-HIDDEN")!.version, 1);
  assert.equal(fakeDb.versions.length, 0);
  for (const q of fakeDb.recordedQueries) {
    assert.ok(!q.sql.includes("23505"), "no raw unique-violation leakage in queries");
  }
});

test("PostgresKnowledgeRepository resolves ON CONFLICT idempotently when the conflicting row becomes visible", async () => {
  const fakeDb = new StatefulFakeKnowledgeDb();
  const repo = new PostgresKnowledgeRepository(fakeDb.createAppClient());

  const ctx: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["sub-platform"],
    allowedPolicies: ["internal-project"]
  };

  const item = parseKnowledgeFile({
    tenantId: "acme",
    projectId: "sub-platform",
    filePath: ".brain/01-business/BR-RACE.md",
    rawContent: "---\nid: BR-RACE\n---\nConcurrent body"
  });

  const first = await repo.upsertItem(ctx, item);
  assert.equal(first.versionCreated, true);
  const versionsBefore = fakeDb.versions.length;

  // Simulate a concurrent insert: first SELECT misses the row, the INSERT hits the
  // ON CONFLICT DO NOTHING path, and the re-read finds the now-visible row with the
  // same content_hash — the upsert must be idempotent, not a duplicate version.
  fakeDb.hideNextSelectKeys.add("acme:sub-platform:BR-RACE");
  const raced = await repo.upsertItem(ctx, { ...item, sourceVersion: "commit-race-reindexed" });
  assert.equal(raced.versionCreated, false);
  assert.equal(raced.item.version, 1);
  assert.equal(fakeDb.versions.length, versionsBefore);
});

test("PostgresKnowledgeRepository preserves the stored valid_from on update when the caller omits it", async () => {
  const fakeDb = new StatefulFakeKnowledgeDb();
  const repo = new PostgresKnowledgeRepository(fakeDb.createAppClient());

  const ctx: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["sub-platform"],
    allowedPolicies: ["internal-project"]
  };

  const originalValidFrom = "2026-01-15T10:00:00.000Z";
  const v1 = parseKnowledgeFile({
    tenantId: "acme",
    projectId: "sub-platform",
    filePath: ".brain/01-business/BR-VALID.md",
    rawContent: "---\nid: BR-VALID\n---\nOriginal body"
  });

  await repo.upsertItem(ctx, { ...v1, validFrom: originalValidFrom });
  assert.equal(fakeDb.items.get("acme:sub-platform:BR-VALID")!.valid_from, originalValidFrom);

  const v2 = parseKnowledgeFile({
    tenantId: "acme",
    projectId: "sub-platform",
    filePath: ".brain/01-business/BR-VALID.md",
    rawContent: "---\nid: BR-VALID\n---\nChanged body"
  });

  const updated = await repo.upsertItem(ctx, v2);
  assert.equal(updated.versionCreated, true);
  assert.equal(updated.item.version, 2);
  assert.equal(updated.item.validFrom, originalValidFrom);
  assert.equal(fakeDb.items.get("acme:sub-platform:BR-VALID")!.valid_from, originalValidFrom);
});

test("PostgresKnowledgeRepository refuses to fabricate success when a mutation RETURNING comes back empty", async () => {
  const ctx: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["sub-platform"],
    allowedPolicies: ["internal-project"]
  };

  const row: KnowledgeItemRow = {
    id: "BR-EMPTY",
    tenant_id: "acme",
    project_id: "sub-platform",
    domain_id: 2,
    type: "business_rule",
    title: "Empty returning",
    content: "Old body",
    summary: null,
    status: "approved",
    source_id: "src",
    source_origin: "internal",
    source_kind: "git",
    source_version: "commit-1",
    source_uri: ".brain/01-business/BR-EMPTY.md",
    version: 1,
    content_hash: "old-hash",
    owner_id: null,
    confidence: 1,
    trust_level: "verified",
    is_inferred: false,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: null,
    tags: [],
    access_policy_id: "internal-project",
    metadata: {},
    deleted_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z"
  };

  const client = createAppPostgresClient<KnowledgeSqlTransactionRunner>({
    databaseUrl: "postgresql://brain_app:dev-secret@localhost:5432/project_brain_os",
    createSql: () => ({
      begin: async <T>(cb: (tx: KnowledgeSqlTransactionRunner) => T | Promise<T>): Promise<T> => {
        const tx: KnowledgeSqlTransactionRunner = async <TRow = Record<string, unknown>>(
          template: TemplateStringsArray,
          ..._params: readonly KnowledgeSqlParameter[]
        ): Promise<readonly TRow[]> => {
          const sql = template.join("$P$").replace(/\s+/g, " ").trim();
          if (sql.includes("set_config('app.current_tenant_id'")) return [] as unknown as readonly TRow[];
          if (sql.startsWith("SELECT") && sql.includes("FROM knowledge_items")) {
            return [structuredClone(row) as unknown as TRow];
          }
          // Anomalous empty RETURNING on UPDATE (e.g. RLS divergence between read and write).
          if (sql.startsWith("UPDATE knowledge_items")) return [] as unknown as readonly TRow[];
          throw new Error(`Unexpected SQL: ${sql}`);
        };
        return await cb(tx);
      }
    })
  });

  const repo = new PostgresKnowledgeRepository(client);
  const changed = parseKnowledgeFile({
    tenantId: "acme",
    projectId: "sub-platform",
    filePath: ".brain/01-business/BR-EMPTY.md",
    rawContent: "---\nid: BR-EMPTY\n---\nNew body"
  });

  await assert.rejects(() => repo.upsertItem(ctx, changed), /returned no row.*refusing to fabricate success/s);
});

test("privacyEraseSubject deletes owned/tagged items and their versions, embeddings, relations, and sync tombstones", async () => {
  const items = [
    { id: "K-OWNED", tenant_id: "acme", project_id: "sub", owner_id: "user-123", tags: ["billing"] },
    { id: "K-TAGGED", tenant_id: "acme", project_id: "core", owner_id: "other", tags: ["user-123", "pii"] },
    { id: "K-OTHER-USER", tenant_id: "acme", project_id: "sub", owner_id: "user-999", tags: ["billing"] },
    { id: "K-OTHER-TENANT", tenant_id: "beta", project_id: "sub", owner_id: "user-123", tags: [] }
  ];
  const embeddings = new Set(["K-OWNED", "K-TAGGED", "K-OTHER-USER", "K-OTHER-TENANT"]);
  const versions = new Set(["K-OWNED", "K-TAGGED", "K-OTHER-USER", "K-OTHER-TENANT"]);
  const relations = new Set(["K-OWNED", "K-TAGGED", "K-OTHER-USER", "K-OTHER-TENANT"]);

  const systemClient = {
    role: "brain_system" as const,
    async begin<T>(cb: (tx: KnowledgeSqlTransactionRunner) => Promise<T> | T): Promise<T> {
      const tx: KnowledgeSqlTransactionRunner = async <TRow = Record<string, unknown>>(
        template: TemplateStringsArray,
        ...params: readonly KnowledgeSqlParameter[]
      ): Promise<readonly TRow[]> => {
        const sql = template.join("$P$").replace(/\s+/g, " ").trim();
        if (sql.startsWith("INSERT INTO sync_project_locks")) return [] as unknown as readonly TRow[];
        const tenantId = params[0] as string;
        const subjectId = params[1] as string;
        if (sql.startsWith("SELECT") && sql.includes("FROM knowledge_items")) {
          assert.match(sql, /FOR UPDATE/);
          return items.filter((row) => row.tenant_id === tenantId && (row.owner_id === subjectId || row.tags.includes(subjectId))) as unknown as readonly TRow[];
        }
        const targetItems = items.filter((row) => row.tenant_id === "acme" && (row.owner_id === "user-123" || row.tags.includes("user-123")));
        const projectId = params[1] as string;
        const itemIds = params[2] as string[];
        const projectItems = targetItems.filter((row) => row.project_id === projectId && itemIds.includes(row.id));
        if (sql.includes("DELETE FROM knowledge_embeddings")) {
          for (const row of projectItems) embeddings.delete(row.id);
          return projectItems.map((row) => ({ knowledge_item_id: row.id })) as unknown as readonly TRow[];
        }
        if (sql.includes("DELETE FROM knowledge_item_versions")) {
          for (const row of projectItems) versions.delete(row.id);
          return projectItems.map((row) => ({ item_id: row.id })) as unknown as readonly TRow[];
        }
        if (sql.includes("DELETE FROM knowledge_relations")) {
          for (const row of projectItems) relations.delete(row.id);
          return projectItems.map((row) => ({ id: row.id })) as unknown as readonly TRow[];
        }
        if (sql.includes("INSERT INTO sync_changes")) {
          return projectItems.map((_row, index) => ({ sync_seq: index + 1 })) as unknown as readonly TRow[];
        }
        if (sql.includes("DELETE FROM memory_entries")) return [];
        if (sql.includes("DELETE FROM handoffs")) return [];
        if (sql.includes("DELETE FROM runner_tasks")) return [];
        if (sql.includes("DELETE FROM notification_outbox")) return [{ id: "notice-1" }] as unknown as readonly TRow[];
        if (sql.includes("DELETE FROM notification_preferences")) return [{ id: "prefs-1" }] as unknown as readonly TRow[];
        assert.match(sql, /DELETE FROM knowledge_items/);
        const deleted: Array<{ id: string }> = [];
        for (let i = items.length - 1; i >= 0; i--) {
          const row = items[i]!;
          if (row.tenant_id === tenantId && row.project_id === projectId && itemIds.includes(row.id)) {
            deleted.push({ id: row.id });
            items.splice(i, 1);
          }
        }
        return deleted as unknown as readonly TRow[];
      };
      return await cb(tx);
    }
  };

  const result = await privacyEraseSubject(systemClient, { tenantId: "acme", subjectId: "user-123" });
  assert.equal(result.deletedItems, 2);
  assert.equal(result.deletedVersions, 2);
  assert.equal(result.deletedEmbeddings, 2);
  assert.equal(result.deletedRelations, 2);
  assert.equal(result.createdSyncTombstones, 2);
  assert.equal(result.deletedNotificationOutbox, 1);
  assert.equal(result.deletedNotificationPreferences, 1);
  assert.deepEqual(result.deletedItemIds.sort(), ["K-OWNED", "K-TAGGED"]);
  assert.deepEqual(items.map((r) => r.id), ["K-OTHER-USER", "K-OTHER-TENANT"]);
  assert.equal(embeddings.has("K-OWNED"), false);
  assert.equal(embeddings.has("K-TAGGED"), false);
  assert.equal(embeddings.has("K-OTHER-USER"), true);
  assert.equal(versions.has("K-OTHER-USER"), true);
  assert.equal(relations.has("K-OTHER-USER"), true);

  await assert.rejects(
    () => privacyEraseSubject({ role: "brain_app", begin: systemClient.begin }, { tenantId: "acme", subjectId: "user-123" }),
    /brain_system/
  );
  await assert.rejects(
    () => privacyEraseSubject(systemClient, { tenantId: "*", subjectId: "user-123" }),
    /wildcard/
  );
});
