import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import {
  createBranchAndCommitFiles,
  createGitHubAppJwt,
  createGitHubPullRequest,
  exchangeInstallationToken,
  fetchRepoCommitChanges,
  fetchRepoTreeAndFiles,
  parseGitHubPushEvent,
  publishGitHubCheckRun,
  verifyGitHubSignature
} from "../src/index.js";

test("verifies GitHub HMAC-SHA256 webhook signature", () => {
  const body = JSON.stringify({ ref: "refs/heads/main" });
  const secret = "webhook-secret";
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyGitHubSignature(body, sig, secret), true);
  assert.equal(verifyGitHubSignature(body, "sha256=bad", secret), false);
});

test("extracts changed files from GitHub push payload", () => {
  const summary = parseGitHubPushEvent({
    repository: { full_name: "acme/sub" },
    ref: "refs/heads/main",
    before: "oldsha123",
    after: "deadbeef",
    commits: [{ added: [".brain/01-business/BR-1.yaml"], modified: ["src/app.ts"] }]
  });
  assert.equal(summary.repository, "acme/sub");
  assert.equal(summary.beforeCommitSha, "oldsha123");
  assert.equal(summary.changedFiles.length, 2);
});

test("creates GitHub Pull Request via REST API", async () => {
  const pr = await createGitHubPullRequest(
    {
      owner: "acme",
      repo: "sub",
      title: "chore(brain): approve BR-SUB-014",
      head: "brain/br-sub-014",
      base: "main",
      body: "Aprovado no Command Center",
      token: "ghs_test"
    },
    async () => new Response(JSON.stringify({ number: 42, html_url: "https://github.com/acme/sub/pull/42" }), { status: 201 })
  );
  assert.equal(pr.number, 42);
  assert.ok(pr.htmlUrl.endsWith("/pull/42"));
});

test("creates RS256 GitHub App JWT and exchanges installation token", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const jwt = createGitHubAppJwt("12345", privateKey, 1_700_000_000);
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);

  const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as { alg: string; typ: string };
  const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
    iss: string;
    iat: number;
    exp: number;
  };
  assert.equal(header.alg, "RS256");
  assert.equal(header.typ, "JWT");
  assert.equal(payload.iss, "12345");
  assert.equal(payload.iat, 1_700_000_000 - 60);
  assert.equal(payload.exp, 1_700_000_000 + 600);

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  assert.equal(verifier.verify(publicKey, parts[2]!, "base64url"), true);

  const tokenResult = await exchangeInstallationToken(
    jwt,
    99,
    async (url) => {
      assert.ok(String(url).endsWith("/app/installations/99/access_tokens"));
      return new Response(
        JSON.stringify({ token: "ghs_install_token", expires_at: "2026-11-16T23:00:00Z" }),
        { status: 201 }
      );
    }
  );
  assert.equal(tokenResult.token, "ghs_install_token");
  assert.equal(tokenResult.expiresAt, "2026-11-16T23:00:00Z");
});

test("fetches remote repo tree and decodes file contents", async () => {
  const result = await fetchRepoTreeAndFiles(
    "acme",
    "sub",
    "main",
    "ghs_test",
    { pathFilter: (p) => p.startsWith(".brain/") },
    async (url) => {
      const u = String(url);
      if (u.endsWith("/repos/acme/sub")) return new Response(JSON.stringify({ private: false }), { status: 200 });
      if (u.includes("/commits/main")) {
        return new Response(JSON.stringify({ sha: "commit-sha-1" }), { status: 200 });
      }
      if (u.includes("/git/trees/")) {
        return new Response(
          JSON.stringify({
            sha: "tree-sha-1",
            truncated: false,
            tree: [
              { path: ".brain/01-business/BR-1.yaml", type: "blob", sha: "blob-1" },
              { path: "README.md", type: "blob", sha: "blob-2" }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          sha: "blob-1",
          encoding: "base64",
          content: Buffer.from("id: BR-1\ntitle: Cancelamento\n", "utf8").toString("base64")
        }),
        { status: 200 }
      );
    }
  );

  assert.equal(result.commitSha, "commit-sha-1");
  assert.equal(result.isPrivate, false);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.path, ".brain/01-business/BR-1.yaml");
  assert.match(result.files[0]?.content ?? "", /id: BR-1/);
});

test("preserves remote SCIP index bytes as base64 and applies the larger bounded index limit", async () => {
  const index = Buffer.from("\u0000SCIP binary fixture\ufffd");
  const result = await fetchRepoTreeAndFiles(
    "acme", "sub", "main", "ghs_test",
    { pathFilter: (path) => path === ".scip/index.scip", maxBinaryFileBytes: 128 },
    async (url) => {
      const target = String(url);
      if (target.endsWith("/repos/acme/sub")) return new Response(JSON.stringify({ private: true }), { status: 200 });
      if (target.includes("/commits/main")) return new Response(JSON.stringify({ sha: "commit-sha-1" }), { status: 200 });
      if (target.includes("/git/trees/")) return new Response(JSON.stringify({
        sha: "tree-sha-1", truncated: false, tree: [{ path: ".scip/index.scip", type: "blob", sha: "scip-blob" }]
      }), { status: 200 });
      return new Response(JSON.stringify({ sha: "scip-blob", encoding: "base64", content: index.toString("base64") }), { status: 200 });
    }
  );
  assert.deepEqual(result.files, [{ path: ".scip/index.scip", sha: "scip-blob", content: index.toString("base64"), contentEncoding: "base64" }]);
});

test("fetches only changed GitHub files and reports removed and renamed paths", async () => {
  const calls: string[] = [];
  const result = await fetchRepoCommitChanges(
    "acme", "billing", "a".repeat(40), "b".repeat(40), "ghs_test",
    { pathFilter: (path) => path.startsWith(".brain/"), maxFileBytes: 1024 },
    async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith("/repos/acme/billing")) return new Response(JSON.stringify({ private: true }), { status: 200 });
      if (target.includes("/compare/")) return new Response(JSON.stringify({
        status: "ahead",
        files: [
          { filename: ".brain/01-business/BR-1.yaml", status: "modified" },
          { filename: ".brain/01-business/BR-2.yaml", status: "renamed", previous_filename: ".brain/01-business/BR-OLD.yaml" },
          { filename: ".brain/01-business/BR-3.yaml", status: "removed" },
          { filename: "README.md", status: "modified" }
        ]
      }), { status: 200 });
      assert.ok(target.includes("/contents/.brain/01-business/"));
      assert.ok(target.includes("?ref=" + "b".repeat(40)));
      return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from("title: Updated\n").toString("base64"), sha: "blob-new" }), { status: 200 });
    }
  );

  assert.equal(result.commitSha, "b".repeat(40));
  assert.equal(result.isPrivate, true);
  assert.equal(result.fallbackRequired, false);
  assert.deepEqual(result.files, [
    { path: ".brain/01-business/BR-1.yaml", sha: "blob-new", content: "title: Updated\n" },
    { path: ".brain/01-business/BR-2.yaml", sha: "blob-new", content: "title: Updated\n" }
  ]);
  assert.deepEqual(result.deletedPaths, [".brain/01-business/BR-OLD.yaml", ".brain/01-business/BR-3.yaml"]);
  assert.equal(calls.filter((target) => target.includes("/contents/")).length, 2);
});

test("requests full-snapshot fallback at GitHub's compare file cap", async () => {
  const result = await fetchRepoCommitChanges(
    "acme", "billing", "a".repeat(40), "b".repeat(40), undefined, undefined,
    async (url) => {
      const target = String(url);
      if (target.endsWith("/repos/acme/billing")) return new Response(JSON.stringify({ private: false }), { status: 200 });
      assert.ok(target.includes("/compare/"));
      return new Response(JSON.stringify({ status: "ahead", files: Array.from({ length: 300 }, (_, i) => ({ filename: `src/${i}.ts`, status: "modified" })) }), { status: 200 });
    }
  );
  assert.equal(result.fallbackRequired, true);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.deletedPaths, []);
});

test("requests full-snapshot fallback when the commit range diverged", async () => {
  const result = await fetchRepoCommitChanges(
    "acme", "billing", "a".repeat(40), "b".repeat(40), undefined, undefined,
    async (url) => {
      const target = String(url);
      if (target.endsWith("/repos/acme/billing")) return new Response(JSON.stringify({ private: true }), { status: 200 });
      return new Response(JSON.stringify({ status: "diverged", files: [{ filename: "src/app.ts", status: "modified" }] }), { status: 200 });
    }
  );
  assert.equal(result.fallbackRequired, true);
  assert.deepEqual(result.files, []);
});

test("creates branch and commits files via GitHub Git Data API", async () => {
  const calls: string[] = [];
  const res = await createBranchAndCommitFiles(
    "acme",
    "sub",
    "main",
    "brain/br-1",
    [{ path: ".brain/01-business/BR-1.yaml", content: "id: BR-1\n" }],
    "chore(brain): approve BR-1",
    "ghs_test",
    async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/git/ref/heads/main")) {
        return new Response(JSON.stringify({ object: { sha: "base-commit-sha" } }), { status: 200 });
      }
      if (u.includes("/git/commits/base-commit-sha")) {
        return new Response(JSON.stringify({ tree: { sha: "base-tree-sha" } }), { status: 200 });
      }
      if (u.endsWith("/git/blobs")) {
        return new Response(JSON.stringify({ sha: "new-blob-sha" }), { status: 201 });
      }
      if (u.endsWith("/git/trees")) {
        return new Response(JSON.stringify({ sha: "new-tree-sha" }), { status: 201 });
      }
      if (u.endsWith("/git/commits")) {
        return new Response(JSON.stringify({ sha: "new-commit-sha" }), { status: 201 });
      }
      if (u.endsWith("/git/refs")) {
        return new Response(JSON.stringify({ ref: "refs/heads/brain/br-1" }), { status: 201 });
      }
      return new Response("Not found", { status: 404 });
    }
  );

  assert.equal(res.branch, "brain/br-1");
  assert.equal(res.commitSha, "new-commit-sha");
  assert.equal(res.treeSha, "new-tree-sha");
  assert.equal(calls.length, 6);
});

test("publishes GitHub Check Run for Guardians", async () => {
  const check = await publishGitHubCheckRun(
    "acme",
    "sub",
    "head-sha-123",
    "noema/business-guardian",
    "success",
    "Todas as regras de negócio validadas.",
    "ghs_test",
    async (url) => {
      assert.ok(String(url).endsWith("/repos/acme/sub/check-runs"));
      return new Response(
        JSON.stringify({ id: 777, html_url: "https://github.com/acme/sub/runs/777" }),
        { status: 201 }
      );
    }
  );

  assert.equal(check.id, 777);
  assert.equal(check.conclusion, "success");
  assert.equal(check.htmlUrl, "https://github.com/acme/sub/runs/777");
});

