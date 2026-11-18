import { AbilityBuilder, createMongoAbility, subject, type MongoAbility, type MongoQuery } from "@casl/ability";
import type { AuthContext } from "./index.js";

export { subject };

export type CaslAction = "read" | "write" | "create" | "update" | "approve" | "delete" | "manage";

export interface ScopedResource {
  projectId?: string;
  accessPolicyId?: string;
  domainId?: number;
  tenantId?: string;
}

export type CaslSubject = "Project" | "Knowledge" | "Proposal" | "Runner" | "FinOps" | "Audit" | "Access" | "all" | ScopedResource;

export type AppAbility = MongoAbility<[CaslAction, CaslSubject], MongoQuery<ScopedResource>>;

const CRITICAL_DOMAINS = [1, 2, 3, 7, 11];

/**
 * Builds an isomorphic CASL Ability from an AuthContext.
 * Can be evaluated identically on the API backend and serialized to the Vue 3 frontend.
 */
export function buildAbilityForContext(ctx: AuthContext): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  if (!ctx.tenantId || ctx.allowedProjects.length === 0) {
    return build();
  }

  const projectScope: MongoQuery<ScopedResource> = { projectId: { $in: ctx.allowedProjects } };
  const policyScope: MongoQuery<ScopedResource> =
    ctx.allowedPolicies.length > 0 ? { accessPolicyId: { $in: ctx.allowedPolicies } } : {};
  const scopeFilter: MongoQuery<ScopedResource> = { ...projectScope, ...policyScope };

  if (ctx.roles.includes("admin")) {
    can("manage", "all", projectScope);
  }

  if (ctx.roles.some((r) => ["tech-lead", "appsec"].includes(r))) {
    can(["read", "write", "create", "update"], ["Project", "Knowledge", "Proposal", "Runner"], scopeFilter);
    can("approve", ["Knowledge", "Proposal"], scopeFilter);
    can("read", ["FinOps", "Audit"], projectScope);
  }

  if (ctx.roles.some((r) => ["developer", "ci-bot", "agent"].includes(r))) {
    can(["read", "write", "create", "update"], ["Knowledge", "Proposal", "Runner"], scopeFilter);
    can("read", "Project", projectScope);
  }

  if (ctx.roles.includes("product-owner")) {
    can(["read", "approve"], ["Knowledge", "Proposal"], scopeFilter);
    cannot("approve", ["Knowledge", "Proposal"], { domainId: { $in: CRITICAL_DOMAINS } });
  }

  if (ctx.roles.includes("viewer")) {
    can("read", ["Project", "Knowledge", "Proposal"], scopeFilter);
  }

  // Tenant isolation guardrail when tenantId is explicitly present on the resource
  cannot(["read", "write", "create", "update", "approve", "delete", "manage"], "all", {
    tenantId: { $exists: true, $ne: ctx.tenantId }
  } as MongoQuery<ScopedResource>);

  // Human-in-the-Loop guardrail: autonomous agents without inherited approval rights cannot approve critical domains
  const actsAsLinkedHuman = ctx.actorType === "human" || Boolean(ctx.inheritUserPermissions);
  if (!actsAsLinkedHuman) {
    cannot("approve", ["Knowledge", "Proposal"], { domainId: { $in: CRITICAL_DOMAINS } });
  }

  // Fine-grained domain restriction
  if (ctx.allowedDomains && ctx.allowedDomains.length > 0) {
    cannot(["read", "write", "create", "update", "approve"], ["Knowledge", "Proposal"], {
      domainId: { $nin: ctx.allowedDomains }
    } as MongoQuery<ScopedResource>);
  }

  // Fine-grained action restriction
  if (ctx.allowedActions && ctx.allowedActions.length > 0) {
    const allActions = ["read", "write", "create", "update", "approve"] as const;
    const disallowed = allActions.filter((a) => !ctx.allowedActions!.includes(a));
    if (disallowed.length > 0) {
      cannot(disallowed, ["Project", "Knowledge", "Proposal", "Runner"]);
    }
  }

  return build();
}

export function exportAbilityRules(ctx: AuthContext) {
  return buildAbilityForContext(ctx).rules;
}
