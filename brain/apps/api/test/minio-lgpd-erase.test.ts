import test from "node:test";
import assert from "node:assert/strict";
import {
  eraseMinioObjectsForSubject,
  getMinioObjectText,
  uploadObjectToMinio
} from "../src/services/minio-storage.js";

test("eraseMinioObjectsForSubject finds and deletes objects whose key lacks subjectId by content/explicitKeys", async () => {
  const endpoint = process.env.MINIO_ENDPOINT ?? "http://localhost:9000";
  let minioUp = false;
  try {
    const h = await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(800) });
    minioUp = h.ok;
  } catch {
    minioUp = false;
  }
  if (!minioUp) return;

  const subjectId = `usr-lgpd-verify-${Date.now()}`;
  const key = `default-org/brain/runner-tasks/RUN-VERIFY-${Date.now()}/task-spec.json`;
  const uploadRes = await uploadObjectToMinio({
    key,
    body: JSON.stringify({ actorId: subjectId, instruction: "LGPD erase verification artifact" }),
    contentType: "application/json"
  });
  assert.equal(uploadRes.uploaded, true);

  const before = await getMinioObjectText(key);
  assert.ok(before && before.includes(subjectId));

  const eraseRes = await eraseMinioObjectsForSubject({
    tenantId: "default-org",
    projectId: "brain",
    subjectId
  });

  assert.equal(eraseRes.reachable, true);
  assert.equal(eraseRes.ok, true);
  assert.ok(eraseRes.matchedCount >= 1);
  assert.ok(eraseRes.deletedCount >= 1);
  assert.equal(eraseRes.failedCount, 0);

  const after = await getMinioObjectText(key);
  assert.equal(after, null);
});
