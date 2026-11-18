import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../src/server.js";

test("API search supports cursor pagination, atDate, and context forwards intent/includeDomains + overview alerts", async () => {
  const app = buildApp("test-secret-key", ["sub"], new InMemoryAuditLogger());
  const headers = { authorization: "Bearer test-secret-key" };

  try {
    for (const id of ["BR-1", "BR-2", "BR-3"]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/projects/sub/ingest",
        headers,
        payload: {
          filePath: `.brain/01-business/${id}.yaml`,
          content: `id: ${id}\ntype: business_rule\ntitle: Regra ${id}\nstatus: approved\naccess_policy: internal-project\nvalidFrom: "2025-01-01T00:00:00.000Z"\ndescription: Cancelamento regra ${id}.\n`
        }
      });
      assert.equal(res.statusCode, 200);
    }

    // Cursor pagination on /search
    const page1 = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/search",
      headers,
      payload: { query: "Cancelamento", limit: 2 }
    });
    assert.equal(page1.statusCode, 200);
    const body1 = page1.json();
    assert.equal(body1.items.length, 2);
    assert.ok(body1.nextCursor);

    const page2 = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/search",
      headers,
      payload: { query: "Cancelamento", limit: 2, cursor: body1.nextCursor }
    });
    assert.equal(page2.statusCode, 200);
    assert.equal(page2.json().items.length, 1);

    const testAnchor = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/ingest",
      headers,
      payload: {
        filePath: "test/cancellation.test.ts",
        content: "// @brain-rule BR-1\nexport const cancellationTest = true;"
      }
    });
    assert.equal(testAnchor.statusCode, 200);

    // atDate in the distant past filters out newly created items
    const pastSearch = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/search",
      headers,
      payload: { query: "Cancelamento", atDate: "2000-01-01T00:00:00.000Z" }
    });
    assert.equal(pastSearch.statusCode, 200);
    assert.equal(pastSearch.json().items.length, 0);

    // /context forwards intent & includeDomains
    const ctxRes = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/context",
      headers,
      payload: {
        task: "Revisar regra",
        intent: "business_qa",
        includeDomains: [2]
      }
    });
    assert.equal(ctxRes.statusCode, 200);
    assert.equal(ctxRes.json().intent, "business_qa");

    // /overview includes health alerts for untested rules
    const overviewRes = await app.inject({
      method: "GET",
      url: "/v1/projects/sub/overview",
      headers
    });
    assert.equal(overviewRes.statusCode, 200);
    const overview = overviewRes.json();
    assert.ok(Array.isArray(overview.alerts));
    assert.ok(overview.alerts.some((a: string) => a.includes("sem cobertura de testes")));
    assert.deepEqual([...overview.health.untestedRuleIds].sort(), ["BR-1", "BR-2", "BR-3"]);
    assert.equal(overview.health.healthScore, 70);

    const viewsRes = await app.inject({
      method: "GET",
      url: "/v1/projects/sub/enterprise/views",
      headers
    });
    assert.equal(viewsRes.statusCode, 200);
    const coverage = viewsRes.json().qaCoverage.rows;
    assert.equal(coverage.find((row: { ruleId: string }) => row.ruleId === "BR-1")?.covered, false);
    assert.equal(coverage.find((row: { ruleId: string }) => row.ruleId === "BR-2")?.covered, false);
  } finally {
    await app.close();
  }
});

test("API sync/push detects version conflicts (conflictWithVersion) and sync/pull increments policyEpoch on revocations", async () => {
  const app = buildApp("test-secret-key", ["sub"], new InMemoryAuditLogger());
  const headers = { authorization: "Bearer test-secret-key" };

  try {
    // Ingest v1
    await app.inject({
      method: "POST",
      url: "/v1/projects/sub/ingest",
      headers,
      payload: {
        filePath: ".brain/01-business/BR-CONFLICT.yaml",
        content: "id: BR-CONFLICT\ntype: business_rule\ntitle: Original\nstatus: approved\naccess_policy: internal-project\ndescription: v1\n"
      }
    });
    // Bump to v2
    await app.inject({
      method: "POST",
      url: "/v1/projects/sub/ingest",
      headers,
      payload: {
        filePath: ".brain/01-business/BR-CONFLICT.yaml",
        content: "id: BR-CONFLICT\ntype: business_rule\ntitle: Updated\nversion: 2\nstatus: approved\naccess_policy: internal-project\ndescription: v2\n"
      }
    });

    // Push offline draft based on v1 -> conflictWithVersion: 2
    const pushRes = await app.inject({
      method: "POST",
      url: "/v1/sync/push",
      headers,
      payload: {
        projectId: "sub",
        drafts: [
          {
            id: "BR-CONFLICT",
            title: "Offline edit",
            content: "Edited while offline",
            accessPolicyId: "internal-project",
            baseVersion: 1
          }
        ]
      }
    });
    assert.equal(pushRes.statusCode, 200);
    const pushBody = pushRes.json();
    assert.equal(pushBody.conflicts.length, 1);
    assert.equal(pushBody.conflicts[0].conflictWithVersion, 2);
    assert.equal(pushBody.conflicts[0].status, "draft");

    // Pull with revoked policy increments policyEpoch
    const pull1 = await app.inject({
      method: "POST",
      url: "/v1/sync/pull",
      headers,
      payload: { projectId: "sub", sinceSeq: 0, knownPolicies: ["restricted-policy"] }
    });
    assert.equal(pull1.statusCode, 200);
    assert.equal(pull1.json().policyEpoch, 2);

    const pull2 = await app.inject({
      method: "POST",
      url: "/v1/sync/pull",
      headers,
      payload: { projectId: "sub", sinceSeq: 0, knownPolicies: ["restricted-policy"] }
    });
    assert.equal(pull2.json().policyEpoch, 2, "replaying the same revocation should not advance the policy epoch again");
  } finally {
    await app.close();
  }
});

test("API PG mode reads runner tasks from Postgres and calls privacyEraseSubject via brain_system client", async () => {
  const prevPgStores = process.env.NOEMA_PG_STORES;
  process.env.NOEMA_PG_STORES = "1";

  const deletedQueries: unknown[] = [];
  const fakeAppClient = {
    role: "brain_app" as const,
    async withRlsTransaction<T>(_ctx: unknown, callback: (tx: unknown) => Promise<T> | T): Promise<T> {
      const tx = async (strings: TemplateStringsArray) => {
        const sql = strings.join("?");
        if (sql.includes("FROM runner_tasks")) {
          return [
            {
              task_id: "RUN-PG-1",
              tenant_id: "default-org",
              project_id: "sub",
              instruction: "Check PG",
              priority: "high",
              draft_only: true,
              max_steps: 10,
              timeout_seconds: 120,
              status: "completed",
              result_summary: "Done in PG",
              created_at: "2026-11-16T20:00:00.000Z"
            }
          ];
        }
        return [];
      };
      return callback(tx);
    },
    async close() {}
  };

  const fakeSystemClient = {
    role: "brain_system" as const,
    async begin<T>(callback: (tx: unknown) => Promise<T> | T): Promise<T> {
      const tx = async (strings: TemplateStringsArray, ...params: unknown[]) => {
        const sql = strings.join("?");
        deletedQueries.push({ sql, params });
        if (sql.includes("SELECT id, project_id, content_hash, access_policy_id FROM knowledge_items")) {
          return [{ id: "K-ERASED-1", project_id: "sub" }, { id: "K-ERASED-2", project_id: "sub" }];
        }
        if (sql.includes("DELETE FROM knowledge_embeddings")) return [{ knowledge_item_id: "K-ERASED-1" }, { knowledge_item_id: "K-ERASED-2" }];
        if (sql.includes("DELETE FROM knowledge_item_versions")) return [{ item_id: "K-ERASED-1" }, { item_id: "K-ERASED-2" }];
        if (sql.includes("DELETE FROM knowledge_relations")) return [{ id: "R-ERASED-1" }];
        if (sql.includes("INSERT INTO sync_changes")) return [{ sync_seq: 41 }, { sync_seq: 42 }];
        if (sql.includes("DELETE FROM knowledge_items")) return [{ id: "K-ERASED-1" }, { id: "K-ERASED-2" }];
        return [];
      };
      return callback(tx);
    }
  };

  const app = buildApp(
    "test-secret-key",
    ["sub"],
    undefined,
    () => fakeAppClient as never,
    () => fakeSystemClient as never
  );
  const headers = { authorization: "Bearer test-secret-key" };

  try {
    const taskRes = await app.inject({
      method: "GET",
      url: "/v1/projects/sub/runner/tasks/RUN-PG-1",
      headers
    });
    assert.equal(taskRes.statusCode, 200);
    assert.equal(taskRes.json().taskId, "RUN-PG-1");
    assert.equal(taskRes.json().status, "completed");

    const eraseRes = await app.inject({
      method: "POST",
      url: "/v1/privacy/erase",
      headers,
      payload: { projectId: "sub", subjectId: "user-lgpd-1" }
    });
    assert.equal(eraseRes.statusCode, 200);
    assert.equal(eraseRes.json().deletedFromPg, 2);
    assert.equal(eraseRes.json().deletedVersions, 2);
    assert.equal(eraseRes.json().deletedEmbeddings, 2);
    assert.equal(eraseRes.json().deletedRelations, 1);
    assert.equal(eraseRes.json().createdSyncTombstones, 2);
    assert.equal(eraseRes.json().deletedMemories, 0);
    assert.equal(eraseRes.json().deletedHandoffs, 0);
    assert.equal(eraseRes.json().deletedRunnerTasks, 0);
    assert.equal(eraseRes.json().cryptoShredded, true);
    assert.equal(eraseRes.json().complete, true);
    assert.equal(eraseRes.json().limitations.length, 2);
    assert.equal(deletedQueries.length, 11);
    assert.match((deletedQueries[0] as { sql: string }).sql, /ANY\(tags\)/);
    assert.ok(deletedQueries.some((query) => (query as { sql: string }).sql.includes("INSERT INTO sync_project_locks")));
  } finally {
    await app.close();
    if (prevPgStores === undefined) delete process.env.NOEMA_PG_STORES;
    else process.env.NOEMA_PG_STORES = prevPgStores;
  }
});

test("privacy erase fails closed when durable PostgreSQL storage is unavailable", async () => {
  const prevPgStores = process.env.NOEMA_PG_STORES;
  const prevDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.NOEMA_PG_STORES;
  delete process.env.DATABASE_URL;
  const app = buildApp("test-secret-key", ["sub"], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/privacy/erase",
      headers: { authorization: "Bearer test-secret-key" },
      payload: { projectId: "sub", subjectId: "user-lgpd-2" }
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, "BRAIN_ERR_STORAGE_UNAVAILABLE");
  } finally {
    await app.close();
    if (prevPgStores === undefined) delete process.env.NOEMA_PG_STORES;
    else process.env.NOEMA_PG_STORES = prevPgStores;
    if (prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDatabaseUrl;
  }
});

test("API implements canonical approval decision, integration events, and runner task responses", async () => {
  const auditLogger = new InMemoryAuditLogger();
  const app = buildApp("test-secret-key", ["sub"], auditLogger);
  const headers = { authorization: "Bearer test-secret-key" };
  const secret = "test-humanops-channel-secret";
  const prevChannelSecret = process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
  const prevActorMap = process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON;
  process.env.NOEMA_CHANNEL_WEBHOOK_SECRET = secret;
  process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON = JSON.stringify({
    jira: {
      "jira-account-42": {
        actorId: "person:jira-account-42",
        tenantId: "default-org",
        projectIds: ["sub"],
        policyIds: ["internal-project"],
        roles: ["tech-lead"]
      },
      "ci-runner": {
        actorId: "service:ci-runner",
        tenantId: "default-org",
        projectIds: ["sub"],
        policyIds: ["internal-project"],
        roles: ["ci-bot"]
      },
      "developer-reviewer": {
        actorId: "person:developer-reviewer",
        tenantId: "default-org",
        projectIds: ["sub"],
        policyIds: ["internal-project"],
        roles: ["developer"]
      },
      "out-of-scope-reviewer": {
        actorId: "person:out-of-scope-reviewer",
        tenantId: "default-org",
        projectIds: ["another-project"],
        policyIds: ["internal-project"],
        roles: ["tech-lead"]
      }
    }
  });
  const sendApprovalEvent = (payload: Record<string, unknown>, externalUserId = "jira-account-42") => {
    const signedPayload = { ...payload, externalUserId };
    const signature = createHmac("sha256", secret).update(JSON.stringify(signedPayload)).digest("hex");
    return app.inject({
      method: "POST",
      url: "/v1/integrations/jira/events",
      headers: { ...headers, "x-noema-signature-256": `sha256=${signature}` },
      payload: signedPayload
    });
  };

  try {
    const evidenceRuleId = "BR-EVID-a12b3c";
    const evidenceRule = await app.inject({
      method: "POST", url: "/v1/projects/sub/ingest", headers,
      payload: { filePath: `.brain/01-business/${evidenceRuleId}.yaml`, content: `id: ${evidenceRuleId}\ntype: business_rule\ntitle: Regra ligada à evidência\nstatus: approved\naccess_policy: internal-project\ndescription: Regra para validar evidências do revisor.\n` }
    });
    assert.equal(evidenceRule.statusCode, 200);
    const evidenceTestPath = `tests/${evidenceRuleId.toLowerCase()}.test.ts`;
    const evidenceTest = await app.inject({
      method: "POST", url: "/v1/projects/sub/ingest", headers,
      payload: { filePath: evidenceTestPath, content: `// @brain-rule ${evidenceRuleId}\nit("covers linked rule", () => {});\n` }
    });
    assert.equal(evidenceTest.statusCode, 200);
    const evidenceProposal = await app.inject({
      method: "POST", url: "/v1/projects/sub/change/propose", headers,
      payload: { title: "Proposta com evidência", content: "Revisar a regra coberta.", relatedIds: [evidenceRuleId] }
    });
    assert.equal(evidenceProposal.statusCode, 200);
    const evidenceProposalId = evidenceProposal.json().proposalId;
    const proposalImpacts = await app.inject({
      method: "POST", url: "/v1/projects/sub/change/impact", headers,
      payload: { targetIds: [evidenceProposalId] }
    });
    assert.ok(proposalImpacts.json().confirmedImpacts.some((impact: { itemId?: string }) => impact.itemId === evidenceRuleId));
    assert.ok(["low", "medium", "high", "critical"].includes(proposalImpacts.json().riskLevel));
    assert.ok(Array.isArray(proposalImpacts.json().criticalRulesImpacted));
    const enterpriseViews = await app.inject({ method: "GET", url: "/v1/projects/sub/enterprise/views", headers });
    const evidenceRow = enterpriseViews.json().qaCoverage.rows.find((row: { ruleId: string }) => row.ruleId === evidenceRuleId);
    assert.equal(evidenceRow.covered, false, "a VERIFIED_BY link without a passing CI result is not coverage");
    const unauthorizedDomainAssignee = await app.inject({ method: "POST", url: `/v1/projects/sub/proposals/${evidenceProposalId}/assign`, headers,
      payload: { provider: "jira", externalUserId: "developer-reviewer" } });
    assert.equal(unauthorizedDomainAssignee.statusCode, 403);
    const outOfScopeAssignee = await app.inject({ method: "POST", url: `/v1/projects/sub/proposals/${evidenceProposalId}/assign`, headers,
      payload: { provider: "jira", externalUserId: "out-of-scope-reviewer" } });
    assert.equal(outOfScopeAssignee.statusCode, 403);

    const ciEvent = {
      eventType: "test.results", projectId: "sub", runId: "run-evidence-001", commitSha: "a".repeat(40),
      results: [{ testItemId: evidenceTestPath, status: "passed", durationMs: 125 }]
    };
    const ciReport = await sendApprovalEvent(ciEvent, "ci-runner");
    assert.equal(ciReport.statusCode, 200);
    assert.equal(ciReport.json().handled, "test.results");
    assert.equal(ciReport.json().passed, 1);
    const humanCiReport = await sendApprovalEvent({ ...ciEvent, runId: "human-must-not-submit-ci-results" }, "jira-account-42");
    assert.equal(humanCiReport.statusCode, 403);
    const viewsWithResults = await app.inject({ method: "GET", url: "/v1/projects/sub/enterprise/views", headers });
    const coveredEvidenceRow = viewsWithResults.json().qaCoverage.rows.find((row: { ruleId: string }) => row.ruleId === evidenceRuleId);
    assert.equal(coveredEvidenceRow.covered, true);
    assert.ok(coveredEvidenceRow.tests.includes(evidenceTestPath));
    const execution = viewsWithResults.json().testExecutionResults.find((result: { testItemId: string }) => result.testItemId === evidenceTestPath);
    assert.equal(execution.status, "passed");
    assert.equal(execution.commitSha, "a".repeat(40));
    const repeatedCiReport = await sendApprovalEvent(ciEvent, "ci-runner");
    assert.equal(repeatedCiReport.statusCode, 200);
    assert.equal(repeatedCiReport.json().duplicateCount, 1);
    const latestFailedCi = await sendApprovalEvent({
      ...ciEvent, runId: "run-evidence-latest-failed", executedAt: "2099-01-01T00:00:00.000Z",
      results: [{ testItemId: evidenceTestPath, status: "failed", durationMs: 130 }]
    }, "ci-runner");
    assert.equal(latestFailedCi.statusCode, 200);
    const viewsAfterFailure = await app.inject({ method: "GET", url: "/v1/projects/sub/enterprise/views", headers });
    assert.equal(viewsAfterFailure.json().testExecutionResults.find((result: { testItemId: string }) => result.testItemId === evidenceTestPath).status, "failed");
    assert.equal(viewsAfterFailure.json().qaCoverage.rows.find((row: { ruleId: string }) => row.ruleId === evidenceRuleId).covered, false,
      JSON.stringify({ row: viewsAfterFailure.json().qaCoverage.rows.find((row: { ruleId: string }) => row.ruleId === evidenceRuleId), results: viewsAfterFailure.json().testExecutionResults }));
    const conflictingCiReport = await sendApprovalEvent({
      ...ciEvent, results: [{ testItemId: evidenceTestPath, status: "failed", durationMs: 130 }]
    }, "ci-runner");
    assert.equal(conflictingCiReport.statusCode, 409);

    await app.inject({
      method: "POST",
      url: "/v1/projects/sub/ingest",
      headers,
      payload: {
        filePath: ".brain/01-business/BR-DECIDE.yaml",
        content: "id: BR-DECIDE\ntype: business_rule\ntitle: Regra pendente\nstatus: draft\naccess_policy: internal-project\ndescription: Aguardando decisao\n"
      }
    });

    const staleVersion = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/approvals/BR-DECIDE/decision",
      headers,
      payload: { decision: "approve", proposalVersion: 2 }
    });
    assert.equal(staleVersion.statusCode, 409);

    const decisionRes = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/approvals/BR-DECIDE/decision",
      headers,
      payload: { approved: true, proposalVersion: 1, channel: "slack", comment: "Aprovado pelo Tech Lead", externalEventId: "evt-1" }
    });
    assert.equal(decisionRes.statusCode, 200);
    assert.equal(decisionRes.json().decision, "approved");
    assert.equal(decisionRes.json().status, "approved");

    const proposalRes = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/change/propose",
      headers,
      payload: { title: "Regra com alterações solicitadas", content: "Aguardando complemento" }
    });
    const proposalId = proposalRes.json().proposalId as string;
    const changesRes = await app.inject({
      method: "POST",
      url: `/v1/projects/sub/approvals/${proposalId}/decision`,
      headers,
      payload: { decision: "request_changes", proposalVersion: 1, comment: "Adicionar critérios de aceite" }
    });
    assert.equal(changesRes.statusCode, 200);
    assert.equal(changesRes.json().decision, "changes_requested");
    assert.equal(changesRes.json().status, "changes_requested");
    const inboxRes = await app.inject({ method: "GET", url: "/v1/projects/sub/proposals", headers });
    assert.equal(inboxRes.json().proposals.some((proposal: { id: string }) => proposal.id === proposalId), false);
    const duplicateDecision = await app.inject({
      method: "POST",
      url: `/v1/projects/sub/approvals/${proposalId}/decision`,
      headers,
      payload: { decision: "approve", proposalVersion: 1, comment: "Tentativa após request_changes" }
    });
    assert.equal(duplicateDecision.statusCode, 409);
    const revisedProposal = await app.inject({
      method: "POST",
      url: `/v1/projects/sub/proposals/${proposalId}/revise`,
      headers,
      payload: { baseVersion: 1, content: "Conteúdo revisado com critérios de aceite" }
    });
    assert.equal(revisedProposal.statusCode, 200);
    assert.equal(revisedProposal.json().proposalId, proposalId);
    assert.equal(revisedProposal.json().version, 2);
    const staleRevision = await app.inject({
      method: "POST", url: `/v1/projects/sub/proposals/${proposalId}/revise`, headers,
      payload: { baseVersion: 1, content: "Revisão concorrente obsoleta" }
    });
    assert.equal(staleRevision.statusCode, 409);
    const reopenedInbox = await app.inject({ method: "GET", url: "/v1/projects/sub/proposals", headers });
    assert.equal(reopenedInbox.json().proposals.some((proposal: { id: string }) => proposal.id === proposalId), true);
    const reapproved = await app.inject({
      method: "POST", url: `/v1/projects/sub/approvals/${proposalId}/decision`, headers,
      payload: { decision: "approve", proposalVersion: 2 }
    });
    assert.equal(reapproved.statusCode, 200);
    assert.equal(reapproved.json().status, "approved");
    const proposalHistory = await app.inject({ method: "GET", url: `/v1/projects/sub/proposals/${proposalId}/history`, headers });
    assert.equal(proposalHistory.statusCode, 200);
    assert.deepEqual(proposalHistory.json().events.map((event: { targetType: string }) => event.targetType), ["proposal", "approval_decision", "proposal_revision", "approval_decision"]);
    const unchangedProposal = await app.inject({
      method: "GET",
      url: `/v1/projects/sub/knowledge/${proposalId}`,
      headers
    });
    assert.equal(unchangedProposal.json().item.status, "approved");
    const assignmentProposal = await app.inject({ method: "POST", url: "/v1/projects/sub/change/propose", headers,
      payload: { title: "Proposta atribuída", content: "Validar atribuição do revisor." } });
    const assignmentProposalId = assignmentProposal.json().proposalId;
    const invalidAssignment = await app.inject({ method: "POST", url: `/v1/projects/sub/proposals/${assignmentProposalId}/assign`, headers,
      payload: { provider: "jira", externalUserId: "unknown-reviewer" } });
    assert.equal(invalidAssignment.statusCode, 403);
    const assignment = await app.inject({ method: "POST", url: `/v1/projects/sub/proposals/${assignmentProposalId}/assign`, headers,
      payload: { provider: "jira", externalUserId: "jira-account-42" } });
    assert.equal(assignment.statusCode, 200);
    assert.equal(assignment.json().assignedTo, "person:jira-account-42");
    const assignmentHistory = await app.inject({ method: "GET", url: `/v1/projects/sub/proposals/${assignmentProposalId}/history`, headers });
    assert.ok(assignmentHistory.json().events.some((event: { targetType: string }) => event.targetType === "proposal_assignment"));
    const assignedInbox = await app.inject({ method: "GET", url: "/v1/projects/sub/proposals", headers });
    assert.equal(assignedInbox.json().proposals.find((proposal: { id: string }) => proposal.id === assignmentProposalId).assignedTo, "person:jira-account-42");
    const assignedDecisionDenied = await app.inject({ method: "POST", url: `/v1/projects/sub/approvals/${assignmentProposalId}/decision`, headers,
      payload: { decision: "approve", proposalVersion: 1 } });
    assert.equal(assignedDecisionDenied.statusCode, 403);
    const assignedReviewerDecision = await sendApprovalEvent({
      eventType: "approval.decision", projectId: "sub", proposalId: assignmentProposalId,
      proposalVersion: 1, decision: "approve", externalEventId: "assigned-reviewer-approval-1"
    }, "jira-account-42");
    assert.equal(assignedReviewerDecision.statusCode, 200);
    assert.equal(assignedReviewerDecision.json().status, "approved");
    const directEventProposal = await app.inject({ method: "POST", url: "/v1/projects/sub/change/propose", headers,
      payload: { title: "Replay de decisão direta", content: "Validar externalEventId na API direta." } });
    const directProposalId = directEventProposal.json().proposalId;
    const directDecisionPayload = { decision: "approve", proposalVersion: 1, channel: "web-command-center", externalEventId: "direct-decision-replay-1" };
    const directDecision = await app.inject({ method: "POST", url: `/v1/projects/sub/approvals/${directProposalId}/decision`, headers, payload: directDecisionPayload });
    assert.equal(directDecision.statusCode, 200);
    const directReplay = await app.inject({ method: "POST", url: `/v1/projects/sub/approvals/${directProposalId}/decision`, headers, payload: directDecisionPayload });
    assert.equal(directReplay.statusCode, 200);
    assert.equal(directReplay.json().duplicate, true);
    const directConflict = await app.inject({ method: "POST", url: `/v1/projects/sub/approvals/${directProposalId}/decision`, headers,
      payload: { ...directDecisionPayload, decision: "reject" } });
    assert.equal(directConflict.statusCode, 409);
    assert.equal(auditLogger.events.filter((event) => event.targetType === "approval_decision" && event.targetId === directProposalId).length, 1);

    const integrationEventRes = await sendApprovalEvent({
        eventType: "approval.decision",
        projectId: "sub",
        proposalId: "BR-DECIDE",
        proposalVersion: 1,
        approved: false,
        comment: "Rejeitado via Jira",
        externalEventId: "jira-99"
    });
    assert.equal(integrationEventRes.statusCode, 200);
    assert.equal(integrationEventRes.json().handled, "approval.decision");
    assert.equal(integrationEventRes.json().status, "deprecated");

    const newerItem = await app.inject({
      method: "POST", url: "/v1/projects/sub/ingest", headers,
      payload: { filePath: ".brain/01-business/BR-DECIDE.yaml", content: "id: BR-DECIDE\ntype: business_rule\ntitle: Revisão posterior\nversion: 2\nstatus: draft\naccess_policy: internal-project\ndescription: Conteúdo atualizado após callback\n" }
    });
    assert.equal(newerItem.statusCode, 200);

    const repeatedIntegrationEvent = await sendApprovalEvent({
        eventType: "approval.decision",
        projectId: "sub",
        proposalId: "BR-DECIDE",
        proposalVersion: 1,
        approved: false,
        comment: "Rejeitado via Jira",
        externalEventId: "jira-99"
    });
    assert.equal(repeatedIntegrationEvent.statusCode, 200);
    assert.equal(repeatedIntegrationEvent.json().duplicate, true);

    const reusedEventId = await sendApprovalEvent({
        eventType: "approval.decision",
        projectId: "sub",
        proposalId: "BR-DECIDE",
        proposalVersion: 1,
        decision: "approve",
        comment: "payload diferente",
        externalEventId: "jira-99"
    });
    assert.equal(reusedEventId.statusCode, 409);

    const remoteProposalRes = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/change/propose",
      headers,
      payload: { title: "Revisão externa", content: "Aguardando revisão", relatedIds: ["BR-DECIDE"] }
    });
    const remoteProposalId = remoteProposalRes.json().proposalId as string;
    const proposalImpact = await app.inject({
      method: "POST", url: "/v1/projects/sub/change/impact", headers,
      payload: { targetIds: [remoteProposalId] }
    });
    assert.ok(proposalImpact.json().confirmedImpacts.some((impact: { itemId?: string }) => impact.itemId === "BR-DECIDE"));
    const unknownExternalIdentity = await sendApprovalEvent({
      eventType: "approval.decision",
      decision: "request_changes",
      projectId: "sub",
      proposalId: remoteProposalId,
      proposalVersion: 1,
      comment: "Identidade não mapeada",
      externalEventId: "jira-unknown-1"
    }, "unknown-jira-account");
    assert.equal(unknownExternalIdentity.statusCode, 403);

    const missingExternalEventId = await sendApprovalEvent({
        eventType: "approval.decision",
        decision: "request_changes",
        projectId: "sub",
        proposalId: remoteProposalId,
        proposalVersion: 1,
        comment: "Evento sem identificador"
    });
    assert.equal(missingExternalEventId.statusCode, 400);
    const requestChangesEvent = await sendApprovalEvent({
        eventType: "approval.decision",
        decision: "request_changes",
        projectId: "sub",
        proposalId: remoteProposalId,
        proposalVersion: 1,
        comment: "Incluir exceções",
        externalEventId: "jira-100"
    });
    assert.equal(requestChangesEvent.statusCode, 200);
    assert.equal(requestChangesEvent.json().handled, "approval.decision");
    assert.equal(requestChangesEvent.json().status, "changes_requested");
    assert.equal(auditLogger.events.find((event) => event.targetType === "integration_approval_event")?.actorId, "person:jira-account-42");

    const taskCreateRes = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/runner/tasks",
      headers,
      payload: { instruction: "Analisar cobertura", draftOnly: true }
    });
    assert.equal(taskCreateRes.statusCode, 200);
    const taskId = taskCreateRes.json().taskId;

    const questionRes = await app.inject({
      method: "POST",
      url: `/v1/projects/sub/runner/tasks/${taskId}/questions`,
      headers,
      payload: { question: "Qual contrato externo devemos preservar?" }
    });
    assert.equal(questionRes.statusCode, 200);
    const questionId = questionRes.json().questionId;
    assert.equal(questionRes.json().status, "pending");
    const competingQuestion = await app.inject({
      method: "POST",
      url: `/v1/projects/sub/runner/tasks/${taskId}/questions`,
      headers,
      payload: { question: "Pergunta concorrente" }
    });
    assert.equal(competingQuestion.statusCode, 409);
    const tasksWhileWaiting = await app.inject({
      method: "GET",
      url: "/v1/projects/sub/runner/tasks",
      headers
    });
    assert.equal(
      tasksWhileWaiting.json().tasks.find((task: { taskId: string }) => task.taskId === taskId)?.pendingQuestion?.questionId,
      questionId
    );

    const taskRespRes = await app.inject({
      method: "POST",
      url: `/v1/projects/sub/runner/tasks/${taskId}/responses`,
      headers,
      payload: { questionId, response: "Preservar o contrato v2", idempotencyKey: "answer-1" }
    });
    assert.equal(taskRespRes.statusCode, 200);
    assert.equal(taskRespRes.json().status, "queued");
    assert.equal(taskRespRes.json().responseRecorded, true);

    const repeatedTaskResp = await app.inject({
      method: "POST",
      url: `/v1/projects/sub/runner/tasks/${taskId}/responses`,
      headers,
      payload: { questionId, response: "Preservar o contrato v2", idempotencyKey: "answer-1" }
    });
    assert.equal(repeatedTaskResp.statusCode, 200);
    assert.equal(repeatedTaskResp.json().duplicate, true);
    const reusedResponseKey = await app.inject({
      method: "POST",
      url: `/v1/projects/sub/runner/tasks/${taskId}/responses`,
      headers,
      payload: { questionId, response: "Outro conteúdo", idempotencyKey: "answer-1" }
    });
    assert.equal(reusedResponseKey.statusCode, 409);
    const answeredQuestions = await app.inject({
      method: "GET",
      url: `/v1/projects/sub/runner/tasks/${taskId}/questions`,
      headers
    });
    assert.equal(answeredQuestions.json().questions[0].status, "answered");

    const externalTask = await app.inject({
      method: "POST", url: "/v1/projects/sub/runner/tasks", headers,
      payload: { instruction: "Validar resposta pelo canal" }
    });
    const externalTaskId = externalTask.json().taskId;
    const externalQuestion = await app.inject({
      method: "POST", url: `/v1/projects/sub/runner/tasks/${externalTaskId}/questions`, headers,
      payload: { question: "Qual versão deve ser preservada?" }
    });
    const externalQuestionId = externalQuestion.json().questionId;
    const callbackPayload = {
      eventType: "runner.question.response", projectId: "sub", taskId: externalTaskId,
      questionId: externalQuestionId, response: "Preservar v3", idempotencyKey: "slack-response-1",
      externalEventId: "slack-event-1", externalUserId: "jira-account-42"
    };
    const callback = await sendApprovalEvent(callbackPayload);
    assert.equal(callback.statusCode, 200);
    assert.equal(callback.json().handled, "runner.question.response");
    assert.equal(callback.json().status, "queued");
    const replay = await sendApprovalEvent(callbackPayload);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().duplicate, true);
    const externalQuestionHistory = await app.inject({
      method: "GET", url: `/v1/projects/sub/runner/tasks/${externalTaskId}/questions`, headers
    });
    assert.equal(externalQuestionHistory.json().questions[0].response, "Preservar v3");
  } finally {
    await app.close();
    if (prevChannelSecret === undefined) delete process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
    else process.env.NOEMA_CHANNEL_WEBHOOK_SECRET = prevChannelSecret;
    if (prevActorMap === undefined) delete process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON;
    else process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON = prevActorMap;
  }
});

test("approval callbacks reject unsigned external identities", async () => {
  const prevSecret = process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
  const prevMap = process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON;
  delete process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
  delete process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON;
  const app = buildApp("test-secret-key", ["sub"], new InMemoryAuditLogger());
  const headers = { authorization: "Bearer test-secret-key", "content-type": "application/json" };
  try {
    await app.inject({
      method: "POST",
      url: "/v1/projects/sub/ingest",
      headers,
      payload: {
        filePath: ".brain/01-business/BR-UNSIGNED-CALLBACK.yaml",
        content: "id: BR-UNSIGNED-CALLBACK\ntype: business_rule\ntitle: Callback sem assinatura\nstatus: draft\naccess_policy: internal-project\ndescription: Requer identidade verificável.\n"
      }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/jira/events",
      headers,
      payload: {
        eventType: "approval.decision",
        projectId: "sub",
        proposalId: "BR-UNSIGNED-CALLBACK",
        proposalVersion: 1,
        decision: "approve",
        externalEventId: "unsigned-event-1"
      }
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
    if (prevSecret === undefined) delete process.env.NOEMA_CHANNEL_WEBHOOK_SECRET;
    else process.env.NOEMA_CHANNEL_WEBHOOK_SECRET = prevSecret;
    if (prevMap === undefined) delete process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON;
    else process.env.NOEMA_EXTERNAL_ACTOR_MAP_JSON = prevMap;
  }
});

test("cross-project scaffold recommendations, service registration, access policy catalog, latency telemetry, task planner, and living docs work end-to-end", async () => {
  const audit = new InMemoryAuditLogger();
  const app = buildApp("test-key", ["sub", "billing-core"], audit);
  const headers = { authorization: "Bearer test-key" };
  try {
    const ingestAdr = await app.inject({
      method: "POST",
      url: "/v1/projects/billing-core/ingest",
      headers,
      payload: {
        filePath: ".brain/03-architecture/decisions/ADR-BILL-01.md",
        content: "---\nid: ADR-BILL-01\ntype: architecture_decision\ntitle: Padrão Node-TS para Billing\nstatus: approved\naccess_policy: internal-project\ntags: [billing, node-ts]\n---\n\nUsar Fastify e idempotência por chave no domínio billing.\n"
      }
    });
    assert.equal(ingestAdr.statusCode, 200);

    const ingestRule = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/ingest",
      headers,
      payload: {
        filePath: ".brain/01-business/business-rules/BR-SUB-10.yaml",
        content: "id: BR-SUB-10\ntype: business_rule\ntitle: Regra de cancelamento\nstatus: approved\naccess_policy: internal-project\ndescription: Validar retenção antes de cancelar.\n"
      }
    });
    assert.equal(ingestRule.statusCode, 200);

    const ingestDoc = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/ingest",
      headers,
      payload: {
        filePath: "src/billing/invoice.md",
        content: "---\nid: DOC-INV-1\ntype: document\ntitle: Serviço de Faturas\nstatus: approved\naccess_policy: internal-project\ntags: [billing]\n---\n\nFluxo de faturas.\n"
      }
    });
    assert.equal(ingestDoc.statusCode, 200);

    // 1. Cross-project scaffold recommendations
    const recsRes = await app.inject({
      method: "GET",
      url: "/v1/projects/sub/scaffold/recommendations?domain=billing&stack=node-ts&crossProject=true",
      headers
    });
    assert.equal(recsRes.statusCode, 200);
    const recsBody = recsRes.json();
    assert.equal(recsBody.crossProject, true);
    assert.ok(recsBody.recommendations.some((r: { id: string; sourceProjectId: string }) => r.id === "ADR-BILL-01" && r.sourceProjectId === "billing-core"));

    // 2. Central service registration
    const regRes = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/scaffold/register",
      headers,
      payload: {
        serviceName: "checkout-api",
        domain: "billing",
        objective: "API de checkout",
        stack: "node-ts",
        appliedAdrIds: ["ADR-BILL-01"]
      }
    });
    assert.equal(regRes.statusCode, 200);
    assert.equal(regRes.json().registered, true);
    assert.equal(regRes.json().itemId, "SVC-CHECKOUT-API");

    // 3. Access profile with policyCatalog
    const accessRes = await app.inject({ method: "GET", url: "/v1/projects/sub/access/profile", headers });
    assert.equal(accessRes.statusCode, 200);
    const accessBody = accessRes.json();
    assert.ok(Array.isArray(accessBody.policyCatalog));
    const internalPol = accessBody.policyCatalog.find((p: { policyId: string }) => p.policyId === "internal-project");
    assert.equal(internalPol.authorized, true);
    assert.ok(internalPol.itemCount >= 2);

    // 4. Operations overview with latency telemetry
    const opsRes = await app.inject({ method: "GET", url: "/v1/projects/sub/operations/overview", headers });
    assert.equal(opsRes.statusCode, 200);
    const opsBody = opsRes.json();
    assert.ok(opsBody.telemetry?.apiLatencyMs);
    assert.ok(opsBody.telemetry.apiLatencyMs.sampleCount >= 1);

    // 5. Autonomous Task Planner
    const planRes = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/tasks/plan",
      headers,
      payload: { epicDescription: "Implementar fluxo de cancelamento" }
    });
    assert.equal(planRes.statusCode, 200);
    const planBody = planRes.json();
    assert.ok(Array.isArray(planBody.tasks) && planBody.tasks.length >= 2);
    assert.equal(planBody.tasks[0].kind, "epic");

    // 6. Living Documentation suggest + submitDrafts
    const livingRes = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/living-docs/suggest",
      headers,
      payload: { changedFiles: ["src/billing/invoice.ts"], diffSummary: "Novo campo de imposto", submitDrafts: true }
    });
    assert.equal(livingRes.statusCode, 200);
    const livingBody = livingRes.json();
    assert.ok(livingBody.drafts.length >= 1);
    assert.equal(livingBody.submittedCount, livingBody.drafts.length);
  } finally {
    await app.close();
  }
});

test("developer cross-project profile and IDE/CLI lifecycle hooks work end-to-end", async () => {
  const audit = new InMemoryAuditLogger();
  const app = buildApp("test-key", ["sub", "billing-core"], audit);
  const headers = { authorization: "Bearer test-key" };
  try {
    // 1. Save cross-project developer profile
    const putRes = await app.inject({
      method: "PUT",
      url: "/v1/profile/developer",
      headers,
      payload: {
        preferredPackageManager: "pnpm",
        preferredTestLayout: "co-located",
        preferredArchitectureStyle: "layered",
        preferredHarness: "antigravity",
        codingConventions: ["early-return", "strict-typescript"],
        optInCrossProject: true
      }
    });
    assert.equal(putRes.statusCode, 200);
    assert.equal(putRes.json().profile.preferredPackageManager, "pnpm");

    // 2. Context Pack includes developerProfile across projects
    const ctxRes = await app.inject({
      method: "POST",
      url: "/v1/projects/billing-core/context",
      headers,
      payload: { task: "Implementar novo endpoint" }
    });
    assert.equal(ctxRes.statusCode, 200);
    assert.equal(ctxRes.json().developerProfile?.preferredPackageManager, "pnpm");

    // 3. Lifecycle hook session_end creates automatic handoff
    const endRes = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/hooks/lifecycle",
      headers,
      payload: {
        harness: "claude-code",
        event: "session_end",
        sessionId: "sess-hook-1",
        summary: "Implementado endpoint de estorno; faltam testes E2E.",
        modifiedFiles: ["src/refund.ts"],
        branch: "feat/refund"
      }
    });
    assert.equal(endRes.statusCode, 200);
    assert.ok(endRes.json().handoffCreated?.handoffId);

    // 4. Lifecycle hook session_start in another harness returns developerProfile + latestHandoff
    const startRes = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/hooks/lifecycle",
      headers,
      payload: {
        harness: "codex",
        event: "session_start",
        sessionId: "sess-hook-2",
        taskId: endRes.json().handoffCreated.taskId
      }
    });
    assert.equal(startRes.statusCode, 200);
    assert.equal(startRes.json().developerProfile?.preferredHarness, "antigravity");
    assert.equal(startRes.json().latestHandoff?.fromAgent, "claude-code");

    // 5. Delete profile
    const delRes = await app.inject({ method: "DELETE", url: "/v1/profile/developer", headers });
    assert.equal(delRes.statusCode, 200);
    assert.equal(delRes.json().deleted, true);
  } finally {
    await app.close();
  }
});

test("Access admin (members/grants/policies) and FinOps quotas work end-to-end", async () => {
  const app = buildApp("test-secret-key", ["sub", "other"], new InMemoryAuditLogger());
  const headers = { authorization: "Bearer test-secret-key" };
  try {
    // Access profile reports managementAvailable: true
    const profileRes = await app.inject({ method: "GET", url: "/v1/projects/sub/access/profile", headers });
    assert.equal(profileRes.statusCode, 200);
    assert.equal(profileRes.json().managementAvailable, true);

    // Member role assignment
    const roleRes = await app.inject({
      method: "PUT",
      url: "/v1/projects/sub/access/members/alice/roles",
      headers,
      payload: { roles: ["tech-lead", "reviewer"], allowedPolicies: ["internal-project", "public-org"] }
    });
    assert.equal(roleRes.statusCode, 200);
    assert.deepEqual(roleRes.json().roles, ["tech-lead", "reviewer"]);

    const membersRes = await app.inject({ method: "GET", url: "/v1/projects/sub/access/members", headers });
    assert.equal(membersRes.statusCode, 200);
    assert.equal(membersRes.json().members.length, 1);

    // Temporary grant create + list + revoke
    const grantRes = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/access/grants",
      headers,
      payload: { actorId: "contractor-1", roles: ["developer"], policyIds: ["internal-project"], ttlMinutes: 30 }
    });
    assert.equal(grantRes.statusCode, 200);
    const grantId = grantRes.json().grantId as string;

    const grantsList = await app.inject({ method: "GET", url: "/v1/projects/sub/access/grants", headers });
    assert.equal(grantsList.statusCode, 200);
    assert.equal(grantsList.json().grants.length, 1);

    // A grant ID from a different project must not be listed or revoked here.
    {
      const otherGrantRes = await app.inject({
        method: "POST",
        url: "/v1/projects/other/access/grants",
        headers,
        payload: { actorId: "contractor-2", roles: ["developer"], policyIds: ["internal-project"], ttlMinutes: 30 }
      });
      assert.equal(otherGrantRes.statusCode, 200);
      const otherGrantId = otherGrantRes.json().grantId as string;

      const crossProjectRevoke = await app.inject({
        method: "DELETE",
        url: `/v1/projects/sub/access/grants/${otherGrantId}`,
        headers
      });
      assert.equal(crossProjectRevoke.statusCode, 404);

      const otherProjectList = await app.inject({
        method: "GET",
        url: "/v1/projects/other/access/grants",
        headers
      });
      assert.equal(otherProjectList.json().grants.length, 1);
    }

    const revokeGrant = await app.inject({ method: "DELETE", url: `/v1/projects/sub/access/grants/${grantId}`, headers });
    assert.equal(revokeGrant.statusCode, 200);
    assert.equal(revokeGrant.json().revoked, true);

    // Policy catalog edit
    const policyRes = await app.inject({
      method: "PUT",
      url: "/v1/projects/sub/access/policies/restricted-security",
      headers,
      payload: { label: "Security Critical", description: "Somente AppSec e Admin", allowedRoles: ["appsec", "admin"] }
    });
    assert.equal(policyRes.statusCode, 200);
    assert.equal(policyRes.json().label, "Security Critical");

    // FinOps department quota + infra/energy estimate
    const quotaRes = await app.inject({
      method: "PUT",
      url: "/v1/projects/sub/finops/quotas",
      headers,
      payload: { department: "platform-eng", monthlyTokenLimit: 500000, monthlyUsdLimit: 120 }
    });
    assert.equal(quotaRes.statusCode, 200);
    assert.equal(quotaRes.json().department, "platform-eng");

    const finopsRes = await app.inject({ method: "GET", url: "/v1/projects/sub/finops", headers });
    assert.equal(finopsRes.statusCode, 200);
    assert.equal(finopsRes.json().infrastructureEstimate.basis, "telemetry_derived");
    assert.equal(finopsRes.json().departmentQuotas.length, 1);
    assert.equal(finopsRes.json().departmentQuotas[0].withinQuota, true);
  } finally {
    await app.close();
  }
});
