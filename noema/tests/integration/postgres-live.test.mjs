import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDatabaseClient } from "../../packages/database/dist/src/client.js";
import { assertBrainAppRlsSafe } from "../../packages/database/dist/src/bootstrap-roles.js";
import { createAppPostgresClient } from "../../packages/database/dist/src/client.js";
import { createPostgresAuditLogger } from "../../packages/audit-engine/dist/src/index.js";
import { PgOperationalRepository } from "../../packages/database/dist/src/operational-repos.js";
import { PgKnowledgeRepository } from "../../packages/database/dist/src/repositories.js";
import { parseKnowledgeFile } from "../../packages/knowledge/dist/src/index.js";
import { buildApp } from "../../apps/api/dist/src/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbUrl = process.env.NOEMA_INTEGRATION_DB_URL;

test("live PostgreSQL + pgvector + RLS integration", { skip: !dbUrl }, async () => {
  const sql = postgres(dbUrl);
  try {
    // 0. Garante roles brain_app (sem BYPASSRLS) e brain_system (com BYPASSRLS)
    await sql.unsafe(`
      DO $$ BEGIN
        CREATE ROLE brain_app LOGIN PASSWORD 'brain_app_dev_password';
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      DO $$ BEGIN
        CREATE ROLE brain_system LOGIN PASSWORD 'brain_system_dev_password' BYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      ALTER ROLE brain_app WITH LOGIN PASSWORD 'brain_app_dev_password';
      ALTER ROLE brain_system WITH LOGIN PASSWORD 'brain_system_dev_password' BYPASSRLS;
      GRANT USAGE ON SCHEMA public TO brain_app;
    `);
    await assertBrainAppRlsSafe(sql);
    await sql.unsafe("ALTER ROLE brain_app BYPASSRLS");
    try {
      await assert.rejects(assertBrainAppRlsSafe(sql), /Unsafe pre-existing brain_app role state/i);
    } finally {
      await sql.unsafe("ALTER ROLE brain_app NOBYPASSRLS");
    }
    await assertBrainAppRlsSafe(sql);

    // 1. Cria tabelas base se não existirem e aplica rls-and-indexes.sql
    await sql.unsafe(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      CREATE EXTENSION IF NOT EXISTS "vector";
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        description TEXT,
        knowledge_root TEXT NOT NULL DEFAULT '.brain/',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS knowledge_items (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL REFERENCES organizations(id),
        project_id TEXT NOT NULL,
        domain_id SMALLINT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_origin TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_version TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        content_hash TEXT NOT NULL,
        owner_id TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        trust_level TEXT NOT NULL DEFAULT 'verified',
        is_inferred BOOLEAN NOT NULL DEFAULT FALSE,
        valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_until TIMESTAMPTZ,
        tags TEXT[] NOT NULL DEFAULT '{}',
        access_policy_id TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, project_id, id)
      );
      CREATE TABLE IF NOT EXISTS knowledge_item_versions (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, item_id TEXT NOT NULL, version INTEGER NOT NULL,
        domain_id SMALLINT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, summary TEXT, status TEXT NOT NULL,
        source_origin TEXT NOT NULL, source_kind TEXT NOT NULL, source_version TEXT NOT NULL, content_hash TEXT NOT NULL,
        owner_id TEXT, confidence REAL NOT NULL, trust_level TEXT NOT NULL, is_inferred BOOLEAN NOT NULL,
        tags TEXT[] NOT NULL DEFAULT '{}', access_policy_id TEXT NOT NULL, content TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, project_id, item_id, version)
      );
      CREATE TABLE IF NOT EXISTS knowledge_embeddings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
        knowledge_item_id TEXT NOT NULL, source_version TEXT NOT NULL, chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL, access_policy_id TEXT NOT NULL, embedding_model TEXT NOT NULL DEFAULT 'bge-m3',
        embedding VECTOR(1024) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS knowledge_relations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, from_project_id TEXT NOT NULL,
        to_project_id TEXT NOT NULL, from_item_id TEXT NOT NULL, to_item_id TEXT NOT NULL,
        from_policy_id TEXT NOT NULL, to_policy_id TEXT NOT NULL, relation_type TEXT NOT NULL,
        is_inferred BOOLEAN NOT NULL DEFAULT FALSE, confidence REAL NOT NULL DEFAULT 1.0,
        valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(), valid_until TIMESTAMPTZ,
        evidence_uri TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, project_id TEXT,
        access_policy_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_type TEXT NOT NULL,
        action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
        task_id TEXT NOT NULL, from_agent TEXT NOT NULL, repo_url TEXT NOT NULL,
        branch TEXT NOT NULL, base_commit_sha TEXT NOT NULL, working_tree_dirty BOOLEAN NOT NULL DEFAULT FALSE,
        ephemeral_branch TEXT, modified_files TEXT[] NOT NULL DEFAULT '{}',
        tests_executed TEXT[] NOT NULL DEFAULT '{}', decisions TEXT[] NOT NULL DEFAULT '{}',
        next_steps TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS task_leases (
        tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, branch TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, project_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS runner_tasks (
        task_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
        instruction TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
        draft_only BOOLEAN NOT NULL DEFAULT TRUE, max_steps INTEGER NOT NULL DEFAULT 10,
        timeout_seconds INTEGER NOT NULL DEFAULT 120, status TEXT NOT NULL DEFAULT 'queued',
        result_summary TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sync_changes (
        sync_seq SERIAL PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
        item_id TEXT NOT NULL, content_hash TEXT NOT NULL, access_policy_id TEXT NOT NULL,
        deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS memory_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, project_id TEXT NOT NULL,
        layer TEXT NOT NULL, session_id TEXT, content TEXT NOT NULL,
        access_policy_id TEXT NOT NULL, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS cross_service_contracts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id TEXT NOT NULL, from_project_id TEXT NOT NULL,
        from_service TEXT NOT NULL, relation TEXT NOT NULL, to_project_id TEXT NOT NULL,
        contract_id TEXT NOT NULL, schema_version TEXT NOT NULL, access_policy_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const rlsSql = readFileSync(join(__dirname, "../../packages/database/src/rls-and-indexes.sql"), "utf8");
    await sql.unsafe(rlsSql);

    // 2. Insere organização e item de teste
    await sql`INSERT INTO organizations (id, name) VALUES ('acme-live', 'Acme Live') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO organizations (id, name) VALUES ('default-org', 'Noema Sync Integration') ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO knowledge_items (
        id, tenant_id, project_id, domain_id, type, title, content, status,
        source_id, source_origin, source_kind, source_version, source_uri,
        version, content_hash, access_policy_id
      ) VALUES (
        'BR-LIVE-1', 'acme-live', 'sub', 2, 'business_rule', 'Regra Live', 'Conteudo live', 'approved',
        'git', 'internal', 'git', 'v1', '.brain/BR-LIVE-1.yaml', 1, 'hash-live', 'restricted-security'
      ) ON CONFLICT DO NOTHING
    `;

    const [{ ok }] = await sql`SELECT 1 AS ok`;
    assert.equal(ok, 1);

    // 3. Conecta como role brain_app e valida isolamento RLS real
    const parsedUrl = new URL(dbUrl);
    const appUrl = `postgresql://brain_app:brain_app_dev_password@${parsedUrl.hostname}:${parsedUrl.port || 5432}${parsedUrl.pathname}`;
    const appSql = postgres(appUrl);
    try {
      const noScopeCounts = await appSql`
        SELECT
          (SELECT count(*)::int FROM organizations) AS organizations,
          (SELECT count(*)::int FROM projects) AS projects,
          (SELECT count(*)::int FROM knowledge_items) AS knowledge_items,
          (SELECT count(*)::int FROM knowledge_item_versions) AS knowledge_item_versions,
          (SELECT count(*)::int FROM knowledge_embeddings) AS knowledge_embeddings,
          (SELECT count(*)::int FROM knowledge_relations) AS knowledge_relations,
          (SELECT count(*)::int FROM audit_logs) AS audit_logs
      `;
      assert.deepEqual(Object.values(noScopeCounts[0]), [0, 0, 0, 0, 0, 0, 0], "all normative knowledge tables fail closed without transaction-local RLS scope");

      const auditClient = createAppPostgresClient({ databaseUrl: appUrl });
      const auditTargetId = `audit-live-${randomUUID()}`;
      const auditCtx = {
        tenantId: "acme-live", actorId: "audit-live-test", actorType: "system",
        allowedProjects: ["sub"], allowedPolicies: ["internal-project"]
      };
      try {
        await createPostgresAuditLogger(auditClient, auditCtx).record({
          tenantId: auditCtx.tenantId, projectId: "sub", actorId: auditCtx.actorId,
          actorType: auditCtx.actorType, accessPolicyId: "internal-project", action: "create",
          targetType: "integration_test", targetId: auditTargetId, metadata: { synthetic: true }
        });
        const auditRows = await auditClient.withRlsTransaction(auditCtx, (tx) => tx`
          SELECT tenant_id, project_id, actor_id, access_policy_id, target_id, metadata
          FROM audit_logs WHERE target_id = ${auditTargetId}
        `);
        assert.equal(auditRows.length, 1, "PostgresAuditLogger writes a visible row under the trusted RLS scope");
        assert.equal(auditRows[0].actor_id, auditCtx.actorId);
        const storedAuditMetadata = typeof auditRows[0].metadata === "string"
          ? JSON.parse(auditRows[0].metadata)
          : auditRows[0].metadata;
        assert.equal(storedAuditMetadata.synthetic, true);
        await assert.rejects(
          auditClient.withRlsTransaction(auditCtx, (tx) => tx`UPDATE audit_logs SET action = 'update' WHERE target_id = ${auditTargetId}`),
          /permission denied/i,
          "brain_app cannot update append-only audit rows"
        );
        await assert.rejects(
          auditClient.withRlsTransaction(auditCtx, (tx) => tx`DELETE FROM audit_logs WHERE target_id = ${auditTargetId}`),
          /permission denied/i,
          "brain_app cannot delete append-only audit rows"
        );
      } finally {
        await auditClient.close();
        await sql`DELETE FROM public.audit_logs WHERE target_id = ${auditTargetId}`;
      }

      const hiddenRows = await appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', 'acme-live', true), set_config('app.allowed_projects', 'sub', true), set_config('app.allowed_policies', 'internal-project', true)`;
        return await tx`SELECT id FROM knowledge_items WHERE id = 'BR-LIVE-1'`;
      });
      assert.equal(hiddenRows.length, 0, "RLS deve ocultar item restricted-security");

      const visibleRows = await appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant_id', 'acme-live', true), set_config('app.allowed_projects', 'sub', true), set_config('app.allowed_policies', 'internal-project,restricted-security', true)`;
        return await tx`SELECT id FROM knowledge_items WHERE id = 'BR-LIVE-1'`;
      });
      assert.equal(visibleRows.length, 1, "RLS deve retornar item quando política autorizada");

      const syntheticTenantId = `policy-epoch-${randomUUID()}`;
      const appClient = createDatabaseClient(appUrl);
      try {
        const repo = new PgOperationalRepository(appClient.db);
        const ctx = {
          tenantId: syntheticTenantId,
          actorId: "edge-test-actor",
          actorType: "human",
          roles: ["developer"],
          allowedProjects: ["sub"],
          allowedPolicies: ["internal-project"]
        };
        assert.equal(await repo.updatePolicyEpoch(ctx, "sub", ["restricted-security"]), 2);
        assert.equal(await repo.updatePolicyEpoch(ctx, "sub", ["restricted-security"]), 2, "retry does not bump again");
        assert.equal(await new PgOperationalRepository(appClient.db).updatePolicyEpoch(ctx, "sub", ["restricted-security"]), 2, "state survives repository recreation");
        assert.equal(await repo.updatePolicyEpoch(ctx, "sub", []), 2);
        assert.equal(await repo.updatePolicyEpoch(ctx, "sub", ["restricted-security"]), 3, "a later revocation bumps the epoch once");
        const grantedCtx = { ...ctx, allowedPolicies: ["internal-project", "public-org"] };
        assert.equal(await repo.updatePolicyEpoch(grantedCtx, "sub", []), 4, "a newly granted policy bumps the epoch and requires a snapshot");
        assert.equal(await repo.updatePolicyEpoch(grantedCtx, "sub", []), 4, "repeated scope fingerprint is idempotent");
        assert.equal(await repo.updatePolicyEpoch(ctx, "sub", []), 5, "removing a granted policy also bumps the epoch");
        const syncItemId = `sync-test-${randomUUID()}`;
        const syncSeq = await repo.appendSyncChange(ctx, {
          projectId: "sub",
          itemId: syncItemId,
          contentHash: "synthetic-sync-hash",
          accessPolicyId: "internal-project"
        });
        const syncChanges = await repo.pullSyncChanges(ctx, "sub", syncSeq - 1);
        assert.equal(syncChanges.length, 1);
        assert.equal(syncChanges[0]?.syncSeq, syncSeq);
        assert.equal(syncChanges[0]?.itemId, syncItemId);

        const repositoryItemId = `repo-sync-${randomUUID()}`;
        await sql`INSERT INTO organizations (id, name) VALUES (${syntheticTenantId}, 'Synthetic repository sync') ON CONFLICT DO NOTHING`;
        const repositoryItem = parseKnowledgeFile({
          tenantId: syntheticTenantId,
          projectId: "sub",
          filePath: `.brain/01-business/${repositoryItemId}.md`,
          rawContent: `---\nid: ${repositoryItemId}\ntitle: Repository sync fixture\nstatus: approved\naccess_policy: internal-project\n---\n\nSynthetic data`
        });
        const knowledgeRepo = new PgKnowledgeRepository(appClient.db);
        assert.deepEqual(await knowledgeRepo.upsertItem(ctx, repositoryItem), { version: 1, changed: true });
        const repoSyncChanges = await repo.pullSyncChanges(ctx, "sub", 0);
        assert.ok(repoSyncChanges.some((change) => change.itemId === repositoryItemId && change.contentHash === repositoryItem.contentHash));

        const projectId = `sync-live-${randomUUID()}`;
        const itemId = `SYNC-LIVE-${randomUUID()}`;
        const pagePrefix = `PAGE-${randomUUID()}`;
        const previousEnv = {
          DATABASE_URL: process.env.DATABASE_URL,
          NOEMA_PG_STORES: process.env.NOEMA_PG_STORES,
          DATABASE_SYSTEM_URL: process.env.DATABASE_SYSTEM_URL
        };
        process.env.DATABASE_URL = appUrl;
        process.env.NOEMA_PG_STORES = "1";
        delete process.env.DATABASE_SYSTEM_URL;
        const api = buildApp("live-sync-test-key", [projectId]);
        const headers = { authorization: "Bearer live-sync-test-key" };
        const request = async (method, url, payload) => {
          const response = await api.inject({ method, url, headers, payload });
          assert.equal(response.statusCode, 200, response.body);
          return response.json();
        };
        const ingest = (content) => request("POST", `/v1/projects/${projectId}/ingest`, {
          filePath: `.brain/01-business/${itemId}.md`,
          content: `---\nid: ${itemId}\ntitle: Live sync item\nstatus: approved\naccess_policy: internal-project\n---\n\n${content}`
        });
        try {
          const snapshotSeeder = new PgKnowledgeRepository(appClient.db);
          const snapshotContext = {
            tenantId: "default-org", actorId: "snapshot-seeder", actorType: "system", roles: ["system"],
            allowedProjects: [projectId], allowedPolicies: ["internal-project"]
          };
          for (let index = 0; index < 205; index += 1) {
            const pageItemId = `${pagePrefix}-${String(index).padStart(3, "0")}`;
            const pageItem = parseKnowledgeFile({
              tenantId: "default-org", projectId, filePath: `.brain/01-business/${pageItemId}.md`,
              rawContent: `---\nid: ${pageItemId}\ntitle: Snapshot fixture ${index}\nstatus: approved\naccess_policy: internal-project\n---\n\nSynthetic page fixture ${index}`
            });
            await snapshotSeeder.upsertItem(snapshotContext, pageItem);
          }
          await ingest("before delta");
          await ingest("before delta");
          const [{ count: initialJournalCount }] = await sql`
            SELECT count(*)::int AS count FROM sync_changes
            WHERE tenant_id='default-org' AND project_id=${projectId} AND item_id=${itemId}
          `;
          assert.equal(initialJournalCount, 1, "identical upsert creates no duplicate sync event");
          const firstPage = await request("POST", "/v1/sync/pull", { projectId, sinceSeq: 0, policyEpoch: 1, knownPolicies: ["internal-project"] });
          assert.equal(firstPage.syncMode, "snapshot");
          assert.equal(firstPage.items.length, 100);
          const delta = await ingest("after delta");
          assert.ok(delta);
          const [{ count: updatedJournalCount }] = await sql`
            SELECT count(*)::int AS count FROM sync_changes
            WHERE tenant_id='default-org' AND project_id=${projectId} AND item_id=${itemId}
          `;
          assert.equal(updatedJournalCount, 2, "content update creates exactly one new sync event");
        } finally {
          await api.close();
          process.env.DATABASE_URL = previousEnv.DATABASE_URL;
          process.env.NOEMA_PG_STORES = previousEnv.NOEMA_PG_STORES;
          if (previousEnv.DATABASE_SYSTEM_URL === undefined) delete process.env.DATABASE_SYSTEM_URL;
          else process.env.DATABASE_SYSTEM_URL = previousEnv.DATABASE_SYSTEM_URL;
          await sql.unsafe("DELETE FROM public.knowledge_item_versions WHERE tenant_id='default-org' AND project_id=$1 AND item_id=$2", [projectId, itemId]);
          await sql.unsafe("DELETE FROM public.knowledge_item_versions WHERE tenant_id='default-org' AND project_id=$1 AND item_id LIKE $2", [projectId, `${pagePrefix}%`]);
          await sql.unsafe("DELETE FROM public.knowledge_items WHERE tenant_id='default-org' AND project_id=$1 AND id=$2", [projectId, itemId]);
          await sql.unsafe("DELETE FROM public.knowledge_items WHERE tenant_id='default-org' AND project_id=$1 AND id LIKE $2", [projectId, `${pagePrefix}%`]);
          await sql.unsafe("DELETE FROM public.sync_changes WHERE tenant_id='default-org' AND project_id=$1", [projectId]);
          await sql.unsafe("DELETE FROM public.policy_epoch_states WHERE tenant_id='default-org' AND project_id=$1", [projectId]);
          await sql.unsafe("DELETE FROM public.audit_logs WHERE tenant_id='default-org' AND project_id=$1", [projectId]);
        }
      } finally {
        await appClient.client.end();
        await sql.unsafe("DELETE FROM public.policy_epoch_states WHERE tenant_id = $1", [syntheticTenantId]);
        await sql.unsafe("DELETE FROM public.sync_changes WHERE tenant_id = $1 AND item_id LIKE 'sync-test-%'", [syntheticTenantId]);
        await sql.unsafe("DELETE FROM public.sync_changes WHERE tenant_id = $1 AND item_id LIKE 'repo-sync-%'", [syntheticTenantId]);
        await sql.unsafe("DELETE FROM public.knowledge_item_versions WHERE tenant_id = $1 AND item_id LIKE 'repo-sync-%'", [syntheticTenantId]);
        await sql.unsafe("DELETE FROM public.knowledge_items WHERE tenant_id = $1 AND id LIKE 'repo-sync-%'", [syntheticTenantId]);
        await sql`DELETE FROM organizations WHERE id = ${syntheticTenantId}`;
      }
    } finally {
      await appSql.end();
    }
  } finally {
    await sql.end();
  }
});
