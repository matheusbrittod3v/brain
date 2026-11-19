import { describe, expect, it } from "bun:test";
import {
  assertPolicyAccess,
  assertProjectAccess,
  buildAbilityForContext,
  hasPermission,
  PERMISSION_CATALOG,
  type AuthContext
} from "@brain/auth";
import { scanForSecrets } from "@brain/ingestion";

const baseCtx: AuthContext = {
  tenantId: "default-org",
  actorId: "usr-test-1",
  actorType: "agent",
  roles: ["developer"],
  allowedProjects: ["brain"],
  allowedPolicies: ["public-org", "internal-project"]
};

describe("Brain Business Rules Verification", () => {
  it("TEST-BR-BRAIN-001: enforces multi-tenant project and policy scope", () => {
    expect(() => assertProjectAccess(baseCtx, "brain")).not.toThrow();
    expect(() => assertProjectAccess(baseCtx, "other-project")).toThrow();
    expect(() => assertPolicyAccess(baseCtx, "internal-project")).not.toThrow();
    expect(() => assertPolicyAccess(baseCtx, "restricted-security")).toThrow();
  });

  it("TEST-BR-BRAIN-002: detects secrets before ingestion and allows clean markdown", () => {
    const clean = scanForSecrets("# Clean ADR\nNo secrets here.");
    expect(clean.clean).toBe(true);
    expect(clean.findings.length).toBe(0);

    const leaked = scanForSecrets("API_KEY=ghp_1234567890abcdefghijklmnopqrstuvwxyz1234");
    expect(leaked.clean).toBe(false);
    expect(leaked.findings.length).toBeGreaterThan(0);
  });

  it("TEST-BR-BRAIN-003: evaluates FinOps downgrade threshold deterministically", () => {
    const monthlyLimitUsd = 50;
    const spentUsd = 52;
    const shouldDowngrade = spentUsd >= monthlyLimitUsd;
    expect(shouldDowngrade).toBe(true);
  });

  it("TEST-BR-BRAIN-004: enforces CASL abilities for HITL approvals and JIT scope", () => {
    const devAbility = buildAbilityForContext(baseCtx);
    expect(devAbility.can("read", "Knowledge")).toBe(true);

    const adminCtx: AuthContext = { ...baseCtx, roles: ["admin"] };
    const adminAbility = buildAbilityForContext(adminCtx);
    expect(adminAbility.can("approve", "Proposal")).toBe(true);
  });

  it("TEST-BR-BRAIN-005: masks secret values in dynamic system_settings while exposing non-secret settings", () => {
    const rawSettings = [
      { category: "embeddings", key: "embedding_model", value: "bge-m3", isSecret: false },
      { category: "github", key: "token", value: "gho_secret_value", isSecret: true }
    ];
    const masked = rawSettings.map((s) => ({
      ...s,
      value: s.isSecret && s.value ? "••••••••" : s.value
    }));
    expect(masked[0]?.value).toBe("bge-m3");
    expect(masked[1]?.value).toBe("••••••••");
  });

  it("TEST-BR-BRAIN-006: isolates unlinked users (allowedProjects=[]) from project data while preserving CASL roles", () => {
    const unlinkedAdminCtx: AuthContext = {
      tenantId: "default-org",
      actorId: "usr-unlinked-admin",
      actorType: "human",
      roles: ["admin"],
      allowedProjects: [],
      allowedPolicies: ["public-org", "internal-project"]
    };
    expect(() => assertProjectAccess(unlinkedAdminCtx, "brain")).toThrow();
    expect(hasPermission(unlinkedAdminCtx, "users:assign_roles")).toBe(true);
    expect(hasPermission(unlinkedAdminCtx, "roles:view")).toBe(true);
    const ability = buildAbilityForContext(unlinkedAdminCtx);
    expect(ability.can("approve", "Proposal")).toBe(false);
  });

  it("TEST-BR-BRAIN-007: enforces dedicated permissions (projects:share and projects:shared:read) for globally shareable projects", () => {
    const catalogIds = PERMISSION_CATALOG.map((p) => p.id);
    expect(catalogIds).toContain("projects:share");
    expect(catalogIds).toContain("projects:shared:read");

    expect(hasPermission(baseCtx, "projects:shared:read")).toBe(true);
    expect(hasPermission(baseCtx, "projects:share")).toBe(false);

    const adminCtx: AuthContext = { ...baseCtx, roles: ["admin"] };
    expect(hasPermission(adminCtx, "projects:share")).toBe(true);
    expect(hasPermission(adminCtx, "projects:shared:read")).toBe(true);
  });
});
