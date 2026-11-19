import { describe, expect, it } from "bun:test";
import { enforceOpaPolicy, evaluateOpaPolicy, type AuthContext } from "../src/index.js";

const humanAdminCtx: AuthContext = {
  tenantId: "default-org",
  actorId: "usr-human-admin",
  actorType: "human",
  roles: ["admin"],
  allowedProjects: ["brain"],
  allowedPolicies: ["public-org", "internal-project"]
};

const agentAdminCtx: AuthContext = {
  ...humanAdminCtx,
  actorId: "agent-runner-1",
  actorType: "agent"
};

const developerCtx: AuthContext = {
  ...humanAdminCtx,
  actorId: "usr-dev-1",
  roles: ["developer"]
};

describe("OPA Policy-as-Code Evaluation", () => {
  it("evaluates allow/deny via mocked OPA HTTP endpoint", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;

    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body));
      const allowed = capturedBody.input.resource.action === "write";
      return new Response(JSON.stringify({ result: allowed }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    const okDecision = await evaluateOpaPolicy(
      developerCtx,
      { projectId: "brain", accessPolicyId: "internal-project", action: "write", domainId: 3 },
      { opaUrl: "http://opa.internal:8181", fetchImpl: mockFetch }
    );
    expect(okDecision).toEqual({ allowed: true, engine: "opa", reason: undefined });
    expect(capturedUrl).toBe("http://opa.internal:8181/v1/data/brain/authz/allow");
    expect(capturedBody.input.subject.tenantId).toBe("default-org");
    expect(capturedBody.input.resource.projectId).toBe("brain");

    const denyDecision = await evaluateOpaPolicy(
      humanAdminCtx,
      { projectId: "brain", accessPolicyId: "internal-project", action: "read", domainId: 3 },
      { opaUrl: "http://opa.internal:8181", fetchImpl: mockFetch }
    );
    expect(denyDecision.allowed).toBe(false);
    expect(denyDecision.engine).toBe("opa");
  });

  it("fails closed with 503 when OPA is unreachable unless failOpen is true", async () => {
    const failingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    await expect(
      enforceOpaPolicy(
        humanAdminCtx,
        { projectId: "brain", accessPolicyId: "internal-project", action: "read" },
        { opaUrl: "http://127.0.0.1:59999", failOpen: false, fetchImpl: failingFetch }
      )
    ).rejects.toMatchObject({
      code: "BRAIN_ERR_STORAGE_UNAVAILABLE",
      statusCode: 503
    });

    const fallbackDecision = await evaluateOpaPolicy(
      humanAdminCtx,
      { projectId: "brain", accessPolicyId: "internal-project", action: "read" },
      { opaUrl: "http://127.0.0.1:59999", failOpen: true, fetchImpl: failingFetch }
    );
    expect(fallbackDecision.allowed).toBe(true);
    expect(fallbackDecision.engine).toBe("casl");
  });

  it("validates live OPA server (:8181) with brain.rego when running", async () => {
    const opaUrl = "http://localhost:8181";
    let isUp = false;
    try {
      const health = await fetch(`${opaUrl}/health`, { signal: AbortSignal.timeout(500) });
      isUp = health.ok;
    } catch {
      isUp = false;
    }
    if (!isUp) return;

    const humanApprove = await evaluateOpaPolicy(
      humanAdminCtx,
      { projectId: "brain", accessPolicyId: "internal-project", action: "approve", domainId: 3 },
      { opaUrl }
    );
    expect(humanApprove.engine).toBe("opa");
    expect(humanApprove.allowed).toBe(true);

    // Rego policy explicitly forbids non-human actors ("agent") from approving
    const agentApprove = await evaluateOpaPolicy(
      agentAdminCtx,
      { projectId: "brain", accessPolicyId: "internal-project", action: "approve", domainId: 3 },
      { opaUrl }
    );
    expect(agentApprove.engine).toBe("opa");
    expect(agentApprove.allowed).toBe(false);

    // Developer cannot approve
    await expect(
      enforceOpaPolicy(
        developerCtx,
        { projectId: "brain", accessPolicyId: "internal-project", action: "approve", domainId: 3 },
        { opaUrl }
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
