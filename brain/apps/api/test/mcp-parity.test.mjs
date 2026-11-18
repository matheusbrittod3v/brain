import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { InMemoryAuditLogger } from "@brain/audit-engine";
import { buildApp } from "../dist/src/server.js";

const catalog = JSON.parse(readFileSync(new URL("../../../protocols/mcp-tools/catalog.json", import.meta.url), "utf8"));

test("Streamable HTTP exposes the same canonical 35 MCP tools as stdio", async () => {
  const app = buildApp("mcp-catalog-test", ["allowed-project"], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: "Bearer mcp-catalog-test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /text\/event-stream/);
    const dataLine = response.body.split(/\r?\n/).find((line) => line.startsWith("data: "));
    assert.ok(dataLine, "MCP response should contain a JSON-RPC event");
    const payload = JSON.parse(dataLine.slice("data: ".length));
    assert.deepEqual(payload.result.tools.map((tool) => tool.name), catalog);
    assert.equal(payload.result.tools.length, 66);
    assert.match(payload.result.tools[0].description, /^\[Brain principal · MCP HTTP conectado:/);
  } finally {
    await app.close();
  }
});

test("Runner schedule endpoints reject cross-project list and cancellation attempts", async () => {
  const app = buildApp("runner-schedule-api-test", ["allowed-project"], new InMemoryAuditLogger());
  try {
    const headers = { authorization: "Bearer runner-schedule-api-test" };
    const list = await app.inject({ method: "GET", url: "/v1/projects/other-project/runner/schedules", headers });
    const cancel = await app.inject({
      method: "DELETE", url: "/v1/projects/other-project/runner/schedules/guessed-id", headers
    });
    assert.equal(list.statusCode, 403);
    assert.equal(cancel.statusCode, 403);
  } finally {
    await app.close();
  }
});

test("POST /v1/projects and GET /v1/projects register and list authorized projects", async () => {
  const app = buildApp("project-create-test", ["allowed-project"], new InMemoryAuditLogger());
  try {
    const headers = { authorization: "Bearer project-create-test", "content-type": "application/json" };
    const createdRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers,
      payload: { projectId: "allowed-project", name: "Allowed Project", description: "Main repo" }
    });
    assert.equal(createdRes.statusCode, 200);
    const created = JSON.parse(createdRes.body);
    assert.equal(created.created, true);
    assert.equal(created.project.projectId, "allowed-project");
    assert.equal(created.project.name, "Allowed Project");

    const listRes = await app.inject({ method: "GET", url: "/v1/projects", headers });
    assert.equal(listRes.statusCode, 200);
    const listed = JSON.parse(listRes.body);
    assert.equal(listed.projects.length, 1);
    assert.equal(listed.projects[0].name, "Allowed Project");

    const forbiddenRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers,
      payload: { projectId: "forbidden-project", name: "Forbidden" }
    });
    assert.equal(forbiddenRes.statusCode, 403);
  } finally {
    await app.close();
  }
});
