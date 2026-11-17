import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EdgeDatabase, isEncryptedEdgeFile } from "../src/index.js";

test("EdgeDatabase handles cursor, tombstones, staging cleanup and runner tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-edge-test-"));
  const dbPath = join(dir, "edge.db");
  const db = new EdgeDatabase(dbPath, { encryptionKey: "secret-key" });
  try {
    db.upsertItem({
      id: "BR-1",
      projectId: "sub",
      title: "Cancelamento",
      content: "Regra de cancelamento",
      accessPolicyId: "internal-project",
      contentHash: "h1"
    });
    assert.equal(db.searchFts("cancelamento").length, 1);

    db.setSyncCursor(42, 2);
    assert.deepEqual(db.getSyncCursor(), { syncSeq: 42, policyEpoch: 2 });

    assert.equal(db.applyTombstones(["BR-1"]), 1);
    assert.equal(db.searchFts("cancelamento").length, 0);

    db.stageDraft("D-1", "Rascunho", "Conteúdo");
    assert.equal(db.listStaged().length, 1);
    db.markStagedPromoted("D-1", new Date(Date.now() - 40 * 86_400_000));
    assert.equal(db.cleanupPromotedStaging(30), 1);

    const task1 = db.enqueueRunnerTask("sub", "Gerar resumo");
    const task2 = db.enqueueRunnerTask("other", "Outro projeto");
    assert.equal(db.listPendingRunnerTasks().length, 2);

    const claimedSub = db.claimNextRunnerTask("sub");
    assert.equal(claimedSub?.taskId, task1.taskId);
    assert.equal(claimedSub?.status, "running");
    assert.equal(db.claimNextRunnerTask("sub"), undefined);
    assert.equal(db.listPendingRunnerTasks().length, 1);

    db.completeRunnerTask(task1.taskId, "completed");
    const claimedOther = db.claimNextRunnerTask();
    assert.equal(claimedOther?.taskId, task2.taskId);
    assert.equal(claimedOther?.status, "running");
    db.completeRunnerTask(task2.taskId, "failed");
    assert.equal(db.listPendingRunnerTasks().length, 0);

    assert.equal(db.hasOfflineLease(), false);
    db.issueOfflineLease("actor-1", "tenant-1", 60_000);
    assert.equal(db.hasOfflineLease(), true);
    const lease = db.assertOfflineLeaseValid();
    assert.equal(lease.actorId, "actor-1");

    db.upsertEdge("BR-1", "ADR-1", "DECIDED_BY", 1.0);
    db.upsertEdge("ADR-1", "SVC-1", "IMPLEMENTS", 0.9);
    const related = db.getRelatedItems("BR-1", 2);
    assert.equal(related.length, 2);
    assert.equal(related[0]?.toId, "ADR-1");
    assert.equal(related[1]?.toId, "SVC-1");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Edge Runner persists draft results and model usage across schema-v3 migration and reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-edge-runner-results-"));
  const dbPath = join(dir, "edge.db");
  try {
    const initial = new EdgeDatabase(dbPath);
    const task = initial.enqueueRunnerTask("sub", "Summarize the synthetic project");
    initial.close();

    // Simulate an existing Edge v3 database so the additive migration is exercised.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("ALTER TABLE edge_runner_tasks DROP COLUMN result_summary; ALTER TABLE edge_runner_tasks DROP COLUMN model_usage_json; PRAGMA user_version = 3");
    legacy.close();

    const db = new EdgeDatabase(dbPath);
    db.completeRunnerTask(task.taskId, "completed", "[bot-draft] Risk summary", {
      provider: "ollama", model: "qwen2.5-coder:3b", inputTokens: 12, outputTokens: 7,
      totalTokens: 19, durationMs: 840, providerCostUsd: 0, costBasis: "self_hosted_no_api_fee"
    });
    const rows = (db as unknown as { listRunnerTasks(projectId?: string): Array<Record<string, unknown>> }).listRunnerTasks("sub");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.taskId, task.taskId);
    assert.equal(rows[0]?.status, "completed");
    assert.equal(rows[0]?.resultSummary, "[bot-draft] Risk summary");
    assert.deepEqual(rows[0]?.modelUsage, {
      provider: "ollama", model: "qwen2.5-coder:3b", inputTokens: 12, outputTokens: 7,
      totalTokens: 19, durationMs: 840, providerCostUsd: 0, costBasis: "self_hosted_no_api_fee"
    });
    db.close();

    const reopened = new EdgeDatabase(dbPath);
    assert.equal(reopened.listRunnerTasks("sub")[0]?.resultSummary, "[bot-draft] Risk summary");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EdgeDatabase seals SQLite at rest with AES-256-GCM, rejects wrong key, and preserves data across reopen/rebuild", () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-edge-enc-"));
  const dbPath = join(dir, "edge.db");
  try {
    const db = new EdgeDatabase(dbPath, { encryptionKey: "super-secret-passphrase", requireEncryption: true });
    assert.equal(db.getSecurityStatus().atRestEncrypted, true);
    db.upsertItem({
      id: "SEC-1",
      projectId: "noema",
      title: "Segredo Corporativo",
      content: "Dados confidenciais de faturamento PIX",
      accessPolicyId: "internal-project",
      contentHash: "h-sec-1"
    });
    db.setSyncCursor(10, 3);
    db.close();

    // Sealed file on disk must not contain plaintext and must have NOEMA_EDGE_ENC_V1 header
    assert.equal(isEncryptedEdgeFile(dbPath), true);
    const rawOnDisk = readFileSync(dbPath, "utf8");
    assert.equal(rawOnDisk.includes("faturamento PIX"), false);
    assert.equal(rawOnDisk.includes("Segredo Corporativo"), false);

    // Wrong key must fail closed
    assert.throws(() => new EdgeDatabase(dbPath, { encryptionKey: "wrong-passphrase" }));

    // Reopen with correct key restores items and supports atomicRebuildSnapshot
    const reopened = new EdgeDatabase(dbPath, { encryptionKey: "super-secret-passphrase" });
    assert.equal(reopened.searchFts("faturamento").length, 1);
    assert.deepEqual(reopened.getSyncCursor(), { syncSeq: 10, policyEpoch: 3 });

    reopened.atomicRebuildSnapshot(
      [
        {
          id: "SEC-2",
          projectId: "noema",
          title: "Nova Regra",
          content: "Regra atualizada pós-revogação",
          accessPolicyId: "internal-project",
          contentHash: "h-sec-2"
        }
      ],
      11,
      4
    );
    assert.equal(reopened.searchFts("faturamento").length, 0);
    assert.equal(reopened.searchFts("atualizada").length, 1);
    reopened.close();

    assert.equal(isEncryptedEdgeFile(dbPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EdgeDatabase uses native SQLCipher mode when explicitly required", () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-edge-sqlcipher-"));
  const dbPath = join(dir, "edge.db");
  try {
    const db = new EdgeDatabase(dbPath, { encryptionKey: "cipher-passphrase", requireSqlCipher: true });
    assert.deepEqual(db.getSecurityStatus().encryptionMode, "sqlcipher");
    db.upsertItem({ id: "C-1", projectId: "p", title: "SQLCipher marker", content: "sensitive payload marker", accessPolicyId: "internal", contentHash: "h" });
    db.close();

    const bytes = readFileSync(dbPath);
    assert.equal(bytes.includes(Buffer.from("SQLite format 3")), false);
    assert.equal(bytes.includes(Buffer.from("sensitive payload marker")), false);

    const backupPath = join(dir, "edge-backup.db");
    copyFileSync(dbPath, backupPath);
    const restored = new EdgeDatabase(backupPath, { encryptionKey: "cipher-passphrase", requireSqlCipher: true });
    assert.equal(restored.searchFts("sensitive").length, 1);
    restored.close();

    assert.throws(() => new EdgeDatabase(dbPath, { encryptionKey: "wrong" , requireSqlCipher: true }));
    const reopened = new EdgeDatabase(dbPath, { encryptionKey: "cipher-passphrase", requireSqlCipher: true });
    assert.equal(reopened.searchFts("sensitive").length, 1);
    reopened.atomicRebuildSnapshot([{ id: "C-2", projectId: "p", title: "Rebuild", content: "after rebuild", accessPolicyId: "internal", contentHash: "h2" }], 2, 2);
    assert.equal(reopened.getSecurityStatus().encryptionMode, "sqlcipher");
    assert.equal(reopened.searchFts("rebuild").length, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

