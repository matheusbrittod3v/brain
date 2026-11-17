import { execFileSync } from "node:child_process";
import { createHmac, createSign, timingSafeEqual } from "node:crypto";

async function githubRequest<T>(
  url: string,
  token: string | undefined,
  init: RequestInit = {},
  errorPrefix = "GitHub API falhou",
  fetchFn: typeof fetch = fetch
): Promise<T> {
  const res = await fetchFn(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "noema-brain-os",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {})
    }
  });
  if (!res.ok) {
    throw new Error(`${errorPrefix}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function verifyGitHubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface GitHubPushSummary {
  repository: string;
  ref: string;
  beforeCommitSha: string;
  commitSha: string;
  changedFiles: string[];
  removedFiles: string[];
}

export function parseGitHubPushEvent(payload: Record<string, unknown>): GitHubPushSummary {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name ?? "unknown";
  const ref = String(payload.ref ?? "");
  const commitSha = String(payload.after ?? "");
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const changed = new Set<string>();

  const removedFiles = new Set<string>();
  for (const c of commits as Array<{ added?: string[]; modified?: string[]; removed?: string[] }>) {
    for (const f of c.added ?? []) changed.add(f);
    for (const f of c.modified ?? []) changed.add(f);
    for (const f of c.removed ?? []) removedFiles.add(f);
  }

  return {
    repository: repo,
    ref,
    beforeCommitSha: String(payload.before ?? ""),
    commitSha,
    changedFiles: [...changed],
    removedFiles: [...removedFiles]
  };
}

export interface CreatePullRequestInput {
  owner: string;
  repo: string;
  title: string;
  head: string;
  base: string;
  body: string;
  token: string;
}

export async function createGitHubPullRequest(
  input: CreatePullRequestInput,
  fetchFn: typeof fetch = fetch
): Promise<{ number: number; htmlUrl: string }> {
  const data = await githubRequest<{ number: number; html_url: string }>(
    `https://api.github.com/repos/${input.owner}/${input.repo}/pulls`,
    input.token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body
      })
    },
    "GitHub PR falhou",
    fetchFn
  );
  return { number: data.number, htmlUrl: data.html_url };
}

export function shallowCloneRepo(repoUrl: string, targetDir: string, branch = "main"): string {
  execFileSync(
    "git",
    ["clone", "--depth", "1", "--filter=blob:none", "--branch", branch, repoUrl, targetDir],
    { stdio: "ignore" }
  );
  return targetDir;
}

export async function postPullRequestGuardianComment(
  opts: { owner: string; repo: string; prNumber: number; body: string; token: string },
  fetchFn: typeof fetch = fetch
): Promise<{ id: number }> {
  return githubRequest<{ id: number }>(
    `https://api.github.com/repos/${opts.owner}/${opts.repo}/issues/${opts.prNumber}/comments`,
    opts.token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: opts.body })
    },
    "GitHub PR comment falhou",
    fetchFn
  );
}

/**
 * Gera um JWT RS256 para autenticação como GitHub App (validade de 10 minutos).
 */
export function createGitHubAppJwt(
  appId: string | number,
  privateKeyPem: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 600,
      iss: String(appId)
    })
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem, "base64url");
  return `${signingInput}.${signature}`;
}

export async function exchangeInstallationToken(
  appJwt: string,
  installationId: string | number,
  fetchFn: typeof fetch = fetch
): Promise<{ token: string; expiresAt: string }> {
  const data = await githubRequest<{ token: string; expires_at: string }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    appJwt,
    { method: "POST" },
    "GitHub installation token exchange falhou",
    fetchFn
  );
  return { token: data.token, expiresAt: data.expires_at };
}

export interface RemoteRepoFile {
  path: string;
  sha: string;
  content: string;
  contentEncoding?: "base64";
}

function isScipIndexPath(path: string): boolean {
  return path === "index.scip" || path === ".scip/index.scip";
}

export async function fetchRepoCommitChanges(
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  token: string | undefined,
  opts?: { pathFilter?: (path: string) => boolean; maxFiles?: number; maxFileBytes?: number; maxBinaryFileBytes?: number },
  fetchFn: typeof fetch = fetch
): Promise<{
  commitSha: string;
  isPrivate: boolean;
  fallbackRequired: boolean;
  files: RemoteRepoFile[];
  deletedPaths: string[];
}> {
  if (!/^[a-f0-9]{40,64}$/i.test(baseSha) || !/^[a-f0-9]{40,64}$/i.test(headSha)) {
    throw new Error("GitHub commit comparison requires immutable 40-64 character SHAs.");
  }
  const repoData = await githubRequest<{ private: boolean }>(
    `https://api.github.com/repos/${owner}/${repo}`,
    token,
    {},
    "GitHub repository lookup falhou",
    fetchFn
  );
  if (typeof repoData.private !== "boolean") {
    throw new Error("GitHub repository response is missing the privacy classification.");
  }
  const comparison = await githubRequest<{
    status?: string;
    files?: Array<{ filename: string; sha?: string; status: string; previous_filename?: string }>;
  }>(
    `https://api.github.com/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`,
    token,
    {},
    "GitHub commit comparison falhou",
    fetchFn
  );
  const changedFiles = comparison.files ?? [];
  const maxFiles = Math.min(opts?.maxFiles ?? 500, 300);
  if (!(["ahead", "identical"] as Array<string | undefined>).includes(comparison.status) || changedFiles.length >= maxFiles) {
    return { commitSha: headSha.toLowerCase(), isPrivate: repoData.private, fallbackRequired: true, files: [], deletedPaths: [] };
  }

  const files: RemoteRepoFile[] = [];
  const deletedPaths = new Set<string>();
  for (const change of changedFiles) {
    if (!change.filename || typeof change.filename !== "string") {
      throw new Error("GitHub commit comparison returned a file without a path.");
    }
    const includePath = (path: string) => opts?.pathFilter?.(path) ?? true;
    if (change.status === "removed") {
      if (includePath(change.filename)) deletedPaths.add(change.filename);
      continue;
    }
    if (change.status === "renamed" && change.previous_filename && includePath(change.previous_filename)) {
      deletedPaths.add(change.previous_filename);
    }
    if (!["added", "modified", "changed", "renamed", "copied"].includes(change.status) || !includePath(change.filename)) {
      continue;
    }
    const encodedPath = change.filename.split("/").map(encodeURIComponent).join("/");
    const fileData = await githubRequest<{ content?: string; encoding?: string; sha?: string }>(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(headSha)}`,
      token,
      {},
      `GitHub content fetch falhou para ${change.filename}`,
      fetchFn
    );
    const isScipIndex = isScipIndexPath(change.filename);
    const encoded = fileData.content?.replace(/\s/g, "") ?? "";
    const bytes = fileData.encoding === "base64" ? Buffer.from(encoded, "base64") : Buffer.from(fileData.content ?? "", "utf8");
    const maxBytes = isScipIndex ? opts?.maxBinaryFileBytes ?? 16_777_216 : opts?.maxFileBytes ?? 1_048_576;
    if (bytes.byteLength > maxBytes) throw new Error(`GitHub arquivo excede o limite de ${maxBytes} bytes: ${change.filename}`);
    if (isScipIndex && fileData.encoding !== "base64") throw new Error(`Índice SCIP remoto precisa vir codificado em base64: ${change.filename}`);
    const content = isScipIndex ? encoded : (fileData.encoding === "base64" ? bytes.toString("utf8") : (fileData.content ?? ""));
    const sha = fileData.sha ?? change.sha;
    if (!sha) throw new Error(`GitHub content response is missing a blob SHA for ${change.filename}.`);
    files.push({ path: change.filename, sha, content, ...(isScipIndex ? { contentEncoding: "base64" as const } : {}) });
  }

  return {
    commitSha: headSha.toLowerCase(),
    isPrivate: repoData.private,
    fallbackRequired: false,
    files,
    deletedPaths: [...deletedPaths]
  };
}

export async function fetchRepoTreeAndFiles(
  owner: string,
  repo: string,
  ref: string,
  token: string | undefined,
  opts?: { pathFilter?: (path: string) => boolean; maxFiles?: number; maxFileBytes?: number; maxBinaryFileBytes?: number },
  fetchFn: typeof fetch = fetch
): Promise<{ commitSha: string; isPrivate: boolean; truncated: boolean; files: RemoteRepoFile[] }> {
  const repoData = await githubRequest<{ private: boolean }>(
    `https://api.github.com/repos/${owner}/${repo}`,
    token,
    {},
    "GitHub repository lookup falhou",
    fetchFn
  );
  if (typeof repoData.private !== "boolean") {
    throw new Error("GitHub repository response is missing the privacy classification.");
  }
  const commitData = await githubRequest<{ sha: string }>(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    token,
    {},
    "GitHub commit lookup falhou",
    fetchFn
  );
  const treeData = await githubRequest<{
    sha: string;
    truncated?: boolean;
    tree?: Array<{ path: string; type: string; sha: string }>;
  }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(commitData.sha)}?recursive=1`,
    token,
    {},
    "GitHub tree fetch falhou",
    fetchFn
  );

  const blobs = (treeData.tree ?? []).filter(
    (entry) => entry.type === "blob" && (opts?.pathFilter ? opts.pathFilter(entry.path) : true)
  );
  if (blobs.length > (opts?.maxFiles ?? 500)) {
    throw new Error(`GitHub repo excede o limite de ${opts?.maxFiles ?? 500} arquivos selecionados.`);
  }

  const files: RemoteRepoFile[] = [];
  for (const blob of blobs) {
    const encodedPath = blob.path.split("/").map(encodeURIComponent).join("/");
    const fileData = await githubRequest<{ content?: string; encoding?: string; sha?: string }>(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      token,
      {},
      `GitHub content fetch falhou para ${blob.path}`,
      fetchFn
    );
    const isScipIndex = isScipIndexPath(blob.path);
    const encoded = fileData.content?.replace(/\s/g, "") ?? "";
    const bytes = fileData.encoding === "base64" ? Buffer.from(encoded, "base64") : Buffer.from(fileData.content ?? "", "utf8");
    const maxBytes = isScipIndex ? opts?.maxBinaryFileBytes ?? 16_777_216 : opts?.maxFileBytes ?? 1_048_576;
    if (bytes.byteLength > maxBytes) throw new Error(`GitHub arquivo excede o limite de ${maxBytes} bytes: ${blob.path}`);
    if (isScipIndex && fileData.encoding !== "base64") throw new Error(`Índice SCIP remoto precisa vir codificado em base64: ${blob.path}`);
    const content = isScipIndex ? encoded : (fileData.encoding === "base64" ? bytes.toString("utf8") : (fileData.content ?? ""));
    files.push({
      path: blob.path,
      sha: fileData.sha ?? blob.sha,
      content,
      ...(isScipIndex ? { contentEncoding: "base64" as const } : {})
    });
  }

  return {
    commitSha: commitData.sha,
    isPrivate: repoData.private,
    truncated: Boolean(treeData.truncated),
    files
  };
}

export interface CommitFileInput {
  path: string;
  content: string;
}

export async function createBranchAndCommitFiles(
  owner: string,
  repo: string,
  baseBranch: string,
  newBranch: string,
  files: readonly CommitFileInput[],
  message: string,
  token: string,
  fetchFn: typeof fetch = fetch
): Promise<{ branch: string; commitSha: string; treeSha: string }> {
  const baseRef = await githubRequest<{ object: { sha: string } }>(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    token,
    {},
    "GitHub base ref lookup falhou",
    fetchFn
  );
  const baseCommitSha = baseRef.object.sha;

  const baseCommit = await githubRequest<{ tree: { sha: string } }>(
    `https://api.github.com/repos/${owner}/${repo}/git/commits/${baseCommitSha}`,
    token,
    {},
    "GitHub base commit lookup falhou",
    fetchFn
  );

  const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (const file of files) {
    const blob = await githubRequest<{ sha: string }>(
      `https://api.github.com/repos/${owner}/${repo}/git/blobs`,
      token,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: file.content, encoding: "utf-8" })
      },
      `GitHub blob creation falhou para ${file.path}`,
      fetchFn
    );
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const newTree = await githubRequest<{ sha: string }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees`,
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeEntries })
    },
    "GitHub tree creation falhou",
    fetchFn
  );

  const newCommit = await githubRequest<{ sha: string }>(
    `https://api.github.com/repos/${owner}/${repo}/git/commits`,
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, tree: newTree.sha, parents: [baseCommitSha] })
    },
    "GitHub commit creation falhou",
    fetchFn
  );

  await githubRequest<{ ref: string }>(
    `https://api.github.com/repos/${owner}/${repo}/git/refs`,
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha: newCommit.sha })
    },
    "GitHub branch ref creation falhou",
    fetchFn
  );

  return {
    branch: newBranch,
    commitSha: newCommit.sha,
    treeSha: newTree.sha
  };
}

export type GitHubCheckConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "success"
  | "skipped"
  | "stale"
  | "timed_out";

export async function publishGitHubCheckRun(
  owner: string,
  repo: string,
  headSha: string,
  name: string,
  conclusion: GitHubCheckConclusion,
  summary: string,
  token: string,
  fetchFn: typeof fetch = fetch
): Promise<{ id: number; htmlUrl?: string; conclusion: GitHubCheckConclusion }> {
  const data = await githubRequest<{ id: number; html_url?: string }>(
    `https://api.github.com/repos/${owner}/${repo}/check-runs`,
    token,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        head_sha: headSha,
        status: "completed",
        conclusion,
        output: { title: name, summary }
      })
    },
    "GitHub check-run creation falhou",
    fetchFn
  );
  return {
    id: data.id,
    htmlUrl: data.html_url,
    conclusion
  };
}


