import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("Auth & OAuth2 Endpoints end-to-end", async (t) => {
  const prevPgStores = process.env.NOEMA_PG_STORES;
  process.env.NOEMA_PG_STORES = "0";
  const app = buildApp("test-auth-key-12345", ["noema", "local-project"], new InMemoryAuditLogger());

  t.after(async () => {
    await app.close();
    if (prevPgStores === undefined) delete process.env.NOEMA_PG_STORES;
    else process.env.NOEMA_PG_STORES = prevPgStores;
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
  const testEmail = `operator-${Date.now()}@noema.local`;
  const regRes = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: {
      email: testEmail,
      password: "StrongPassword123!",
      name: "Engenheiro Noema"
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
  assert.ok(meData.allowedProjects.includes("noema"));
  assert.ok(meData.allowedProjects.includes("local-project"));

  // 5. OAuth2 Device Code flow for MCP server
  const deviceRes = await app.inject({
    method: "POST",
    url: "/v1/auth/oauth/device/code",
    payload: {
      clientId: "cursor-mcp-plugin",
      clientName: "Cursor IDE MCP Integration"
    }
  });
  assert.equal(deviceRes.statusCode, 200);
  const device = JSON.parse(deviceRes.body);
  assert.ok(device.device_code);
  assert.ok(device.user_code);

  // 6. User approves OAuth session via Web interface
  const approveRes = await app.inject({
    method: "POST",
    url: "/v1/auth/oauth/approve",
    headers: {
      authorization: `Bearer ${userToken}`
    },
    payload: {
      userCode: device.user_code
    }
  });
  assert.equal(approveRes.statusCode, 200);

  // 7. MCP exchanges device_code for Bearer token
  const tokenRes = await app.inject({
    method: "POST",
    url: "/v1/auth/oauth/token",
    payload: {
      deviceCode: device.device_code,
      clientId: "cursor-mcp-plugin"
    }
  });
  assert.equal(tokenRes.statusCode, 200);
  const tokenData = JSON.parse(tokenRes.body);
  assert.ok(tokenData.access_token);
  assert.equal(tokenData.user.email, testEmail);

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
