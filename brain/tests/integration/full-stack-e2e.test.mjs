import test from "node:test";
import assert from "node:assert/strict";

const enabled = process.env.BRAIN_FULL_STACK_E2E === "1";

test("full-stack --profile full health checks (OPA, Keycloak, MinIO, Ollama, AI Worker)", { skip: !enabled }, async () => {
  const checks = [
    { name: "opa", url: process.env.OPA_URL ?? "http://localhost:8181/health" },
    { name: "keycloak", url: process.env.KEYCLOAK_URL ?? "http://localhost:8080/health/ready" },
    { name: "minio", url: process.env.MINIO_URL ?? "http://localhost:9000/minio/health/live" },
    { name: "ollama", url: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/api/tags" },
    { name: "ai-worker", url: process.env.AI_WORKER_URL ?? "http://localhost:8000/health" }
  ];
  for (const c of checks) {
    const res = await fetch(c.url);
    assert.ok(res.ok, `${c.name} health check failed (${res.status})`);
  }
});

