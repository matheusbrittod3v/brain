import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDatabaseClient } from "../../packages/database/dist/src/client.js";
import { PgOperationalRepository } from "../../packages/database/dist/src/operational-repos.js";

const rootUrl = process.env.BRAIN_INTEGRATION_DB_URL ?? process.env.DATABASE_SYSTEM_URL;

test("live access control survives repository restart and remains tenant/project scoped", { skip: !rootUrl }, async () => {
  const admin = postgres(rootUrl);
  const parsedRoot = new URL(rootUrl);
  const appUrl = process.env.BRAIN_APP_DB_URL ??
    `postgresql://brain_app:brain_app_dev_password@${parsedRoot.hostname}:${parsedRoot.port || 5432}${parsedRoot.pathname}`;
  const tenantId = `access-live-${randomUUID()}`;
  const otherTenantId = `access-live-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  const otherProjectId = `project-${randomUUID()}`;
  const grantId = `GRANT-${randomUUID()}`;
  const actorId = `member-${randomUUID()}`;
  const policyId = `custom-${randomUUID()}`;
  const appDb = createDatabaseClient(appUrl);
  const operational = new PgOperationalRepository(appDb.db);
  const ctx = {
    tenantId,
    actorId: "admin-test-actor",
    actorType: "human",
    roles: ["admin"],
    allowedProjects: [projectId],
    allowedPolicies: ["internal-project"]
  };

  try {
    await admin`INSERT INTO organizations (id, name) VALUES (${tenantId}, 'Synthetic access control tenant'), (${otherTenantId}, 'Synthetic other tenant')`;
    await admin`INSERT INTO projects (id, tenant_id, name) VALUES (${projectId}, ${tenantId}, 'Synthetic access project'), (${otherProjectId}, ${otherTenantId}, 'Synthetic other project')`;

    try {
      await operational.saveAccessMember(ctx, projectId, {
        actorId, roles: ["developer", "reviewer"], allowedPolicies: ["internal-project"], syncedWithKeycloak: false
      });
    } catch (error) {
      console.error("access member persistence cause:", error.cause?.message ?? error.message);
      throw error;
    }
    await operational.createTemporaryAccessGrant(ctx, {
      grantId, projectId, actorId, roles: ["developer"], policyIds: ["internal-project"],
      grantedBy: ctx.actorId, expiresAt: new Date(Date.now() + 60_000)
    });
    await operational.upsertCustomAccessPolicy(ctx, projectId, {
      policyId, label: "Synthetic policy", description: "Temporary integration fixture", allowedRoles: ["admin"]
    });

    const restartedRepository = new PgOperationalRepository(createDatabaseClient(appUrl).db);
    assert.equal((await restartedRepository.listAccessMembers(ctx, projectId)).length, 1);
    assert.equal((await restartedRepository.listTemporaryAccessGrants(ctx, projectId)).length, 1);
    assert.equal((await restartedRepository.listCustomAccessPolicies(ctx, projectId)).length, 1);

    const otherProjectContext = { ...ctx, allowedProjects: [otherProjectId] };
    assert.equal((await restartedRepository.listAccessMembers(otherProjectContext, otherProjectId)).length, 0);
    assert.equal(await restartedRepository.revokeTemporaryAccessGrant(otherProjectContext, otherProjectId, grantId), false);
    assert.equal((await restartedRepository.listTemporaryAccessGrants(ctx, projectId)).length, 1);

    const expiredGrantId = `GRANT-${randomUUID()}`;
    await operational.createTemporaryAccessGrant(ctx, {
      grantId: expiredGrantId, projectId, actorId, roles: ["developer"], policyIds: ["internal-project"],
      grantedBy: ctx.actorId, expiresAt: new Date(Date.now() - 1_000)
    });
    assert.equal((await restartedRepository.listTemporaryAccessGrants(ctx, projectId)).length, 1, "expired grants are stored but not listed as active");
    assert.equal(await restartedRepository.revokeTemporaryAccessGrant(ctx, projectId, grantId), true);
    assert.equal((await restartedRepository.listTemporaryAccessGrants(ctx, projectId)).length, 0);
  } finally {
    try {
      await admin`DELETE FROM public.project_access_members WHERE tenant_id IN (${tenantId}, ${otherTenantId})`;
      await admin`DELETE FROM public.temporary_access_grants WHERE tenant_id IN (${tenantId}, ${otherTenantId})`;
      await admin`DELETE FROM public.custom_access_policies WHERE tenant_id IN (${tenantId}, ${otherTenantId})`;
    } catch {
      // The migration may be absent during the initial red test.
    }
    await admin`DELETE FROM projects WHERE id IN (${projectId}, ${otherProjectId})`;
    await admin`DELETE FROM organizations WHERE id IN (${tenantId}, ${otherTenantId})`;
    await appDb.client.end({ timeout: 2 });
    await admin.end({ timeout: 2 });
  }
});
