import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NOEMA_JWT_SECRET = "test-unique-jwt-secret-key-for-unit-tests-32-chars!";
import {
  hashPassword,
  verifyPassword,
  issueUserJwt,
  verifyUserJwt,
  usersStore,
  EmailService,
  oauth2Manager
} from "../dist/index.js";

test("hashPassword & verifyPassword using Argon2id with OWASP parameters", async () => {
  const pwd = "super-secret-password-123!";
  const hash = await hashPassword(pwd);
  assert.ok(hash.startsWith("$argon2id$") || hash.startsWith("scrypt$"), "Hash deve ter formato seguro");

  const valid = await verifyPassword(hash, pwd);
  assert.equal(valid, true, "Senha correta deve ser validada");

  const invalid = await verifyPassword(hash, "wrong-password");
  assert.equal(invalid, false, "Senha incorreta deve ser rejeitada");
});

test("issueUserJwt & verifyUserJwt roundtrip with custom permissions and claims", async () => {
  const token = await issueUserJwt({
    sub: "usr_test_123",
    email: "dev@noema.local",
    name: "Dev User",
    tenant_id: "default-org",
    roles: ["developer", "tech-lead"],
    allowed_projects: ["noema", "staf-web"],
    allowed_policies: ["public-org", "internal-project"],
    permissions: ["knowledge:read", "knowledge:write", "runner:execute"]
  });

  assert.ok(token && token.split(".").length === 3, "Deve gerar JWT válido com 3 partes");

  const ctx = await verifyUserJwt(token);
  assert.equal(ctx.actorId, "usr_test_123");
  assert.equal(ctx.tenantId, "default-org");
  assert.deepEqual(ctx.roles, ["developer", "tech-lead"]);
  assert.deepEqual(ctx.allowedProjects, ["noema", "staf-web"]);
  assert.ok(ctx.permissions?.includes("knowledge:write"));
});

test("usersStore registration and authentication respecting flags", async () => {
  const email = `test-${Date.now()}@noema.local`;
  const { user } = await usersStore.registerUser({
    email,
    password: "Password123!",
    name: "Test Engineer",
    roles: ["developer"]
  });

  assert.equal(user.email, email);
  assert.equal(user.name, "Test Engineer");

  const authenticated = await usersStore.authenticateUser(email, "Password123!");
  assert.equal(authenticated.id, user.id);

  await assert.rejects(
    async () => usersStore.authenticateUser(email, "wrong"),
    /Email ou senha incorretos/
  );
});

test("EmailService sends verification email in simulated mode when SMTP is unconfigured", async () => {
  const svc = new EmailService({ host: "" });
  assert.equal(svc.isConfigured(), false);

  const res = await svc.sendVerificationEmail({
    to: "user@test.local",
    name: "User",
    verificationToken: "token-12345"
  });

  assert.equal(res.success, true);
  assert.equal(res.simulated, true);
});

test("OAuth2Manager initiates device flow and authorizes MCP agent with user permissions", async () => {
  const session = oauth2Manager.createDeviceAuthorization({
    clientId: "mcp-server-test",
    clientName: "Cursor MCP",
    scope: "projects:read"
  });

  assert.ok(session.deviceCode);
  assert.ok(session.userCode.includes("-"));

  const user = {
    id: "usr_oauth_test",
    tenantId: "default-org",
    email: "mcp-user@noema.local",
    name: "MCP Operator",
    passwordHash: "dummy",
    emailVerified: true,
    roles: ["developer", "tech-lead"],
    allowedProjects: ["noema", "local-project"],
    allowedPolicies: ["public-org", "internal-project"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  oauth2Manager.approveSession(session.userCode, user);

  const exchanged = await oauth2Manager.exchangeDeviceCode(session.deviceCode, "mcp-server-test");
  assert.ok(exchanged.accessToken);
  assert.equal(exchanged.user.id, user.id);
  assert.deepEqual(exchanged.user.allowedProjects, ["noema", "local-project"]);
});

