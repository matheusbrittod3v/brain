import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

export interface GitCommitResult {
  branch: string;
  commitSha: string;
  filesCommitted: string[];
}

/**
 * Native Git operations powered by `simple-git` and system `git` binary.
 * Works with local repositories as well as GitHub/GitLab/Bitbucket remotes via SSH or HTTPS PAT.
 */
export function createGitClient(workingDir: string): SimpleGit {
  mkdirSync(workingDir, { recursive: true });
  return simpleGit({ baseDir: workingDir, binary: "git", maxConcurrentProcesses: 4 });
}

export async function cloneOrPullRepo(repoUrl: string, targetDir: string, branch = "main"): Promise<SimpleGit> {
  const git = createGitClient(targetDir);
  const isRepo = await git.checkIsRepo().catch(() => false);
  if (isRepo) {
    await git.fetch(["origin", branch]).catch(() => {});
    await git.checkout(branch).catch(() => {});
    await git.pull("origin", branch).catch(() => {});
  } else {
    await simpleGit().clone(repoUrl, targetDir, ["--branch", branch, "--depth", "1"]);
  }
  return createGitClient(targetDir);
}

export async function getChangedFilesBetweenCommits(workingDir: string, fromRef: string, toRef = "HEAD"): Promise<string[]> {
  const git = createGitClient(workingDir);
  const diff = await git.diffSummary([fromRef, toRef]);
  return diff.files.map((f) => f.file);
}

export async function createBranchAndCommitLocal(params: {
  workingDir: string;
  branchName: string;
  commitMessage: string;
  files: Array<{ path: string; content: string }>;
}): Promise<GitCommitResult> {
  const { writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const git = createGitClient(params.workingDir);

  await git.checkoutLocalBranch(params.branchName).catch(async () => {
    await git.checkout(params.branchName);
  });

  const paths: string[] = [];
  for (const file of params.files) {
    const absPath = join(params.workingDir, file.path);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, file.content, "utf8");
    paths.push(file.path);
  }

  await git.add(paths);
  const commit = await git.commit(params.commitMessage);
  return {
    branch: params.branchName,
    commitSha: commit.commit,
    filesCommitted: paths
  };
}

