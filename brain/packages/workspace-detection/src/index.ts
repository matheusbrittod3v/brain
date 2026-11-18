import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseProjectManifest, type ProjectManifest } from "@brain/knowledge";

export interface WorkspaceSourceHash {
  sourceUri: string;
  sourceHash: string;
}

interface ResolvedWorkspaceSource {
  canonicalPath: string;
  missing: boolean;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function resolveWorkspaceSource(root: string, sourceUri: string): ResolvedWorkspaceSource | undefined {
  const trimmed = sourceUri.trim();
  if (!trimmed || trimmed.includes("\0")) return undefined;

  let pathValue: string;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname && url.hostname !== "localhost") return undefined;
      pathValue = decodeURIComponent(url.pathname);
    } catch {
      return undefined;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return undefined;
  } else {
    pathValue = trimmed.replace(/\\/g, "/");
  }

  const candidate = isAbsolute(pathValue) ? resolve(pathValue) : resolve(root, pathValue);
  if (!isWithin(root, candidate)) return undefined;

  try {
    const canonicalPath = realpathSync(candidate);
    if (!isWithin(root, canonicalPath) || !statSync(canonicalPath).isFile()) return undefined;
    return { canonicalPath, missing: false };
  } catch {
    try {
      if (lstatSync(candidate).isSymbolicLink()) return undefined;
    } catch {
      // Missing paths are valid deletion candidates only when their nearest
      // existing parent still resolves inside the authorized workspace.
    }
    let ancestor = candidate;
    while (isWithin(root, ancestor)) {
      try {
        const realAncestor = realpathSync(ancestor);
        if (!isWithin(root, realAncestor)) return undefined;
        return { canonicalPath: candidate, missing: true };
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) return undefined;
        ancestor = parent;
      }
    }
    return undefined;
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

/** Hash authorized source URIs that resolve to local regular files inside a workspace. */
export async function hashWorkspaceSources(
  workspaceRoot: string,
  sourceUris: readonly string[]
): Promise<WorkspaceSourceHash[]> {
  let root: string;
  try {
    root = realpathSync(workspaceRoot);
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  const results: WorkspaceSourceHash[] = [];
  const seen = new Set<string>();
  for (const sourceUri of sourceUris) {
    if (seen.has(sourceUri)) continue;
    seen.add(sourceUri);
    const resolvedSource = resolveWorkspaceSource(root, sourceUri);
    if (!resolvedSource || resolvedSource.missing) continue;
    try {
      results.push({ sourceUri, sourceHash: await hashFile(resolvedSource.canonicalPath) });
    } catch {
      // A file that cannot be read has no trustworthy baseline.
    }
  }
  return results;
}

/** Return baselined source URIs whose current in-workspace bytes differ or were deleted. */
export async function findChangedWorkspaceSources(
  workspaceRoot: string,
  baselines: readonly WorkspaceSourceHash[]
): Promise<string[]> {
  let root: string;
  try {
    root = realpathSync(workspaceRoot);
    if (!statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  const changed: string[] = [];
  for (const baseline of baselines) {
    if (!/^[a-f0-9]{64}$/.test(baseline.sourceHash)) continue;
    const resolvedSource = resolveWorkspaceSource(root, baseline.sourceUri);
    if (!resolvedSource) continue;
    if (resolvedSource.missing) {
      changed.push(baseline.sourceUri);
      continue;
    }
    try {
      if (await hashFile(resolvedSource.canonicalPath) !== baseline.sourceHash) changed.push(baseline.sourceUri);
    } catch {
      // Read failures are not evidence of an edit.
    }
  }
  return changed;
}

export interface WorkspaceContext {
  workspaceRoot: string;
  projectId: string;
  tenantId: string;
  manifest?: ProjectManifest;
  repoUrl: string;
  branch: string;
  baseCommitSha: string;
  workingTreeDirty: boolean;
  modifiedFiles: string[];
}

function tryGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

export function detectWorkspaceContext(workspaceRoot: string): WorkspaceContext {
  const manifest = parseProjectManifest(workspaceRoot);
  const projectId = manifest?.projectId ?? basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const tenantId = manifest?.tenantId ?? "default-org";
  const branch = tryGit(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "main";
  const baseCommitSha = tryGit(workspaceRoot, ["rev-parse", "HEAD"]) ?? "0000000";
  const repoUrl = tryGit(workspaceRoot, ["config", "--get", "remote.origin.url"]) ?? `file://${workspaceRoot.replace(/\\/g, "/")}`;
  const statusOut = tryGit(workspaceRoot, ["status", "--porcelain"]) ?? "";
  const modifiedFiles = statusOut
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => l.slice(3).trim().replace(/\\/g, "/"))
    .filter((p) => !/^\.env(\.|$)/.test(basename(p)) || basename(p) === ".env.example");

  return {
    workspaceRoot: workspaceRoot.replace(/\\/g, "/"),
    projectId,
    tenantId,
    manifest,
    repoUrl,
    branch,
    baseCommitSha,
    workingTreeDirty: modifiedFiles.length > 0,
    modifiedFiles
  };
}

