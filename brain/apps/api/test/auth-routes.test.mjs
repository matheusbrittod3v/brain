import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryAuditLogger } from "@brain/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("Auth & OAuth2 Endpoints end-to-end", async (t) => {
  const prevPgStores = process.env.BRAIN_PG_STORES;
  process.env.BRAIN_PG_STORES = "0";
  const app = buildApp("test-auth-key-12345", ["brain", "local-project"], new InMemoryAuditLogger());

  t.after(async () => {
    await app.close();
    if (prevPgStores === undefined) delete process.env.BRAIN_PG_STORES;
    else process.env.BRAIN_PG_STORES = prevPgStores;
  });

  // 1. Config
  const configRes = await app.inject({
    method: "GET",
    url: "/v1/auth/config"
  });
  assert.equal(configRes.statusCode, 200);
  const config = JSON.parse(configRes.body);
  assert.equal(typeof config.registrationEnabled, "boolean");

  // 2. Register
  const testEmail = `operator-${Date.now()}@brain.local`;
  const regRes = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: testEmail,
      password: "StrongPassword123!",
      name: "Engenheiro Brain"
    }
  });
  assert.equal(regRes.statusCode, 201);
  const regData = JSON.parse(regRes.body);
  assert.ok(regData.token, "Deve retornar JWT no cadastro");
  assert.equal(regData.user.email, testEmail);

  // 3. Login
  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: {
      email: testEmail,
      password: "StrongPassword123!"
    }
  });
  assert.equal(loginRes.statusCode, 200);
  const loginData = JSON.parse(loginRes.body);
  assert.ok(loginData.token);
  const userToken = loginData.token;

  // 4. Me endpoint with JWT
  const meRes = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: {
      authorization: `Bearer ${userToken}`
    }
  });
  assert.equal(meRes.statusCode, 200);
  const meData = JSON.parse(meRes.body);
  assert.equal(meData.email, testEmail);
  assert.ok(Array.isArray(meData.allowedProjects));

  // 5. OAuth 2.1 PKCE dynamic client registration & authorization
  const { createHash } = await import("node:crypto");
  const codeVerifier = "pkce_verifier_secret_value_for_test_1234567890";
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const redirectUri = "http://127.0.0.1:43210/callback";

  const registerClientRes = await app.inject({
    method: "POST",
    url: "/oauth/register",
    payload: {
      client_name: "Cursor IDE MCP Integration",
      redirect_uris: [redirectUri]
    }
  });
  assert.equal(registerClientRes.statusCode, 201);
  const clientData = JSON.parse(registerClientRes.body);
  assert.ok(clientData.client_id);

  // 6. User approves OAuth 2.1 PKCE session via Web interface
  const authorizeRes = await app.inject({
    method: "POST",
    url: "/v1/auth/oauth/authorize",
    headers: { authorization: `Bearer ${userToken}` },
    payload: {
      clientId: clientData.client_id,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: "S256"
    }
  });
  assert.equal(authorizeRes.statusCode, 200);
  const authCodeData = JSON.parse(authorizeRes.body);
  assert.ok(authCodeData.code);

  // 7. MCP exchanges PKCE authorization code for Bearer token
  const tokenRes = await app.inject({
    method: "POST",
    url: "/oauth/token",
    payload: {
      grant_type: "authorization_code",
      code: authCodeData.code,
      redirect_uri: redirectUri,
      client_id: clientData.client_id,
      code_verifier: codeVerifier
    }
  });
  assert.equal(tokenRes.statusCode, 200);
  const tokenData = JSON.parse(tokenRes.body);
  assert.ok(tokenData.access_token);

  // 8. MCP uses its access_token to access API
  const mcpAccessRes = await app.inject({
    method: "GET",
    url: "/v1/auth/me",
    headers: {
      authorization: `Bearer ${tokenData.access_token}`
    }
  });
  assert.equal(mcpAccessRes.statusCode, 200);
  const mcpMe = JSON.parse(mcpAccessRes.body);
  assert.equal(mcpMe.actorType, "agent");
  assert.equal(mcpMe.actorId, loginData.user.id);
});
