import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import test from "node:test";
import { authenticateRequest, buildAbilityForContext, subject, verifyOidcJwt } from "../dist/index.js";

function makeCtx(overrides = {}) {
  return {
    tenantId: "tenant-a",
    actorId: "user-1",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["project-a"],
    allowedPolicies: ["internal-project"],
    ...overrides
  };
}

function signHs256(payload, secret) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function canCasl(ctx, resource) {
  const ability = buildAbilityForContext(ctx);
  return ability.can(resource.action, subject("Knowledge", resource));
}

test("CASL ability denies cross-tenant access and missing tenantId", async () => {
  const ctx = makeCtx({ tenantId: "tenant-a" });
  const crossTenant = canCasl(ctx, { projectId: "project-a", accessPolicyId: "internal-project", action: "read", tenantId: "tenant-b" });
  assert.equal(crossTenant, false);

  const missingSubjectTenant = canCasl(
    makeCtx({ tenantId: "" }),
    { projectId: "project-a", accessPolicyId: "internal-project", action: "read" }
  );
  assert.equal(missingSubjectTenant, false);

  const sameTenant = canCasl(ctx, { projectId: "project-a", accessPolicyId: "internal-project", action: "read", tenantId: "tenant-a" });
  assert.equal(sameTenant, true);
});

test("CASL ability allows __org__ only when explicitly in allowedProjects", async () => {
  const withoutOrg = makeCtx({ allowedProjects: ["project-a"] });
  assert.equal(
    canCasl(withoutOrg, { projectId: "__org__", accessPolicyId: "internal-project", action: "read" }),
    false
  );

  const withOrg = makeCtx({ allowedProjects: ["__org__"] });
  assert.equal(
    canCasl(withOrg, { projectId: "__org__", accessPolicyId: "internal-project", action: "read" }),
    true
  );
});

test("CASL ability enforces write roles for write, create, and update", async () => {
  const viewerCtx = makeCtx({ roles: ["viewer"] });
  for (const action of ["write", "create", "update"]) {
    assert.equal(
      canCasl(viewerCtx, { projectId: "project-a", accessPolicyId: "internal-project", action }),
      false
    );
  }

  for (const role of ["developer", "tech-lead", "admin", "ci-bot", "agent"]) {
    const allowedCtx = makeCtx({ roles: [role] });
    assert.equal(
      canCasl(allowedCtx, { projectId: "project-a", accessPolicyId: "internal-project", action: "create" }),
      true
    );
  }
});

test("CASL ability denies agent approval and unprivileged roles on critical domains", async () => {
  for (const domainId of [1, 2, 3, 7, 11]) {
    const agentAdmin = makeCtx({ actorType: "agent", roles: ["admin", "tech-lead"] });
    assert.equal(
      canCasl(agentAdmin, { projectId: "project-a", accessPolicyId: "internal-project", action: "approve", domainId }),
      false
    );

    const productOwner = makeCtx({ actorType: "human", roles: ["product-owner"] });
    assert.equal(
      canCasl(productOwner, { projectId: "project-a", accessPolicyId: "internal-project", action: "approve", domainId }),
      false
    );

    const appsecHuman = makeCtx({ actorType: "human", roles: ["appsec"] });
    assert.equal(
      canCasl(appsecHuman, { projectId: "project-a", accessPolicyId: "internal-project", action: "approve", domainId }),
      true
    );
  }

  const productOwnerNonCritical = makeCtx({ actorType: "human", roles: ["product-owner"] });
  assert.equal(
    canCasl(productOwnerNonCritical, { projectId: "project-a", accessPolicyId: "internal-project", action: "approve", domainId: 4 }),
    true
  );
});

test("authenticateRequest rejects missing or invalid API keys when OIDC is not configured", async () => {
  const prevKey = process.env.NOEMA_LOCAL_API_KEY;
  delete process.env.NOEMA_LOCAL_API_KEY;
  try {
    await assert.rejects(
      () => authenticateRequest(undefined, undefined, "tenant-a", ["project-a"], {}),
      { code: "BRAIN_ERR_UNAUTHORIZED", statusCode: 401 }
    );

    await assert.rejects(
      () => authenticateRequest("Bearer any-key", undefined, "tenant-a", ["project-a"], {}),
      { code: "BRAIN_ERR_UNAUTHORIZED", statusCode: 401 }
    );

    await assert.rejects(
      () => authenticateRequest("Bearer wrong-key", "configured-local-key", "tenant-a", ["project-a"], {}),
      { code: "BRAIN_ERR_UNAUTHORIZED", statusCode: 401 }
    );

    const ok = await authenticateRequest("Bearer configured-local-key", "configured-local-key", "tenant-a", ["project-a"], {});
    assert.equal(ok.tenantId, "tenant-a");
    assert.deepEqual(ok.allowedProjects, ["project-a"]);
  } finally {
    if (prevKey !== undefined) {
      process.env.NOEMA_LOCAL_API_KEY = prevKey;
    }
  }
});

test("authenticateRequest separates OIDC JWT verification from local API key fallback", async () => {
  const secret = "oidc-hs256-secret";
  const jwt = signHs256(
    {
      sub: "user-99",
      tenant_id: "tenant-oidc",
      roles: ["tech-lead"],
      allowed_projects: ["project-a"],
      exp: Math.floor(Date.now() / 1000) + 300
    },
    secret
  );

  const ctx = await authenticateRequest(`Bearer ${jwt}`, "", "default-org", [], { hmacSecret: secret });
  assert.equal(ctx.actorId, "user-99");
  assert.equal(ctx.tenantId, "tenant-oidc");

  await assert.rejects(
    () => authenticateRequest("Bearer not-a-jwt", "", "default-org", [], { hmacSecret: secret }),
    { code: "BRAIN_ERR_UNAUTHORIZED", statusCode: 401 }
  );
});

test("verifyOidcJwt rejects the Unix epoch as an expired exp claim", async () => {
  const jwt = signHs256({ sub: "user-epoch", tenant_id: "tenant-a", exp: 0 }, "secret");
  await assert.rejects(
    () => verifyOidcJwt(jwt, { hmacSecret: "secret" }),
    { code: "BRAIN_ERR_UNAUTHORIZED", statusCode: 401 }
  );
});

test("verifyOidcJwt verifies RS256 via JWKS with key id, issuer, and audience", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  const jwt = await new SignJWT({
    sub: "service-7",
    tenant_id: "tenant-rs",
    client_id: "billing-worker",
    allowed_projects: ["billing"]
  })
    .setProtectedHeader({ alg: "RS256", kid: "key-7", typ: "JWT" })
    .setIssuer("https://issuer.example")
    .setAudience("noema-api")
    .setExpirationTime("5m")
    .sign(privateKey);

  let jwksFetches = 0;
  const verifyOptions = {
    jwksUri: "https://issuer.example/.well-known/jwks.json",
    expectedIssuer: "https://issuer.example",
    expectedAudience: "noema-api",
    fetchFn: async () => {
      jwksFetches += 1;
      return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: "key-7", alg: "RS256", use: "sig" }] }));
    }
  };
  const ctx = await verifyOidcJwt(jwt, verifyOptions);
  await verifyOidcJwt(jwt, verifyOptions);
  assert.equal(ctx.actorId, "service-7");
  assert.equal(ctx.actorType, "agent");
  assert.equal(ctx.agentId, "billing-worker");
  assert.deepEqual(ctx.allowedProjects, ["billing"]);
  assert.equal(jwksFetches, 1, "the remote JWKS resolver should reuse its cached key set");
});

test("verifyOidcJwt rejects an otherwise valid token with the wrong configured issuer or audience", async () => {
  const jwt = signHs256({
    sub: "user-claims",
    tenant_id: "tenant-a",
    iss: "https://issuer.example",
    aud: "noema-api",
    exp: Math.floor(Date.now() / 1000) + 300
  }, "claims-secret");
  await assert.rejects(
    () => verifyOidcJwt(jwt, { hmacSecret: "claims-secret", expectedIssuer: "https://other.example", expectedAudience: "noema-api" }),
    { code: "BRAIN_ERR_UNAUTHORIZED", statusCode: 401 }
  );
  await assert.rejects(
    () => verifyOidcJwt(jwt, { hmacSecret: "claims-secret", expectedIssuer: "https://issuer.example", expectedAudience: "other-api" }),
    { code: "BRAIN_ERR_UNAUTHORIZED", statusCode: 401 }
  );
});
