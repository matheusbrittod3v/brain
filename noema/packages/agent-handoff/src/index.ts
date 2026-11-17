import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { AuthContext } from "@noema/auth";
import { BrainError } from "@noema/core";

export interface AgentHandoff {
  handoffId: string;
  tenantId: string;
  fromAgent: string;
  projectId: string;
  taskId: string;
  repoUrl: string;
  branch: string;
  baseCommitSha: string;
  workingTreeDirty: boolean;
  ephemeralBranch?: string;
  modifiedFiles: string[];
  testsExecuted: string[];
  decisions: string[];
  nextSteps: string[];
  createdAt: string;
}

export interface TaskLease {
  taskId: string;
  actorId: string;
  branch: string;
  expiresAt: number;
}

export class HandoffStore {
  private readonly handoffs: AgentHandoff[] = [];
  private readonly leases = new Map<string, TaskLease>();

  createHandoff(
    ctx: AuthContext,
    input: Omit<AgentHandoff, "handoffId" | "tenantId" | "createdAt">
  ): AgentHandoff {
    const handoff: AgentHandoff = {
      ...input,
      handoffId: `HO-${randomUUID().slice(0, 8)}`,
      tenantId: ctx.tenantId,
      modifiedFiles: input.modifiedFiles.map((f) => f.replace(/\\/g, "/")),
      createdAt: new Date().toISOString()
    };
    this.handoffs.push(handoff);
    return handoff;
  }

  resumeHandoff(
    ctx: AuthContext,
    query: { projectId: string; handoffId?: string; taskId?: string; currentBranch?: string; currentCommit?: string }
  ): { handoff?: AgentHandoff; warnings: string[] } {
    const warnings: string[] = [];
    const match = [...this.handoffs]
      .reverse()
      .find(
        (h) =>
          h.tenantId === ctx.tenantId &&
          h.projectId === query.projectId &&
          (query.handoffId ? h.handoffId === query.handoffId : true) &&
          (query.taskId ? h.taskId === query.taskId : true)
      );

    if (!match) {
      return { warnings: ["Nenhum handoff encontrado para os critérios informados."] };
    }

    if (query.currentBranch && query.currentBranch !== match.branch) {
      warnings.push(`Branch local ('${query.currentBranch}') diverge do handoff ('${match.branch}').`);
    }
    if (query.currentCommit && query.currentCommit !== match.baseCommitSha) {
      warnings.push(`Commit local diverge de '${match.baseCommitSha}'; considere criar branch isolada.`);
    }

    const leaseKey = `${ctx.tenantId}:${query.projectId}:${match.taskId}`;
    const existingLease = this.leases.get(leaseKey);
    const now = Date.now();
    if (existingLease && existingLease.expiresAt > now && existingLease.actorId !== ctx.actorId) {
      warnings.push(`Task Lease ativo por '${existingLease.actorId}' na branch '${existingLease.branch}'.`);
    }
    this.leases.set(leaseKey, {
      taskId: match.taskId,
      actorId: ctx.actorId,
      branch: match.branch,
      expiresAt: now + 30 * 60_000
    });

    return { handoff: match, warnings };
  }
}

export interface EncryptedPatchEnvelope {
  algorithm: "aes-256-gcm";
  ivHex: string;
  tagHex: string;
  ciphertextHex: string;
  hmacSha256: string;
}

export function encryptHandoffPatch(patch: string, secret: string): EncryptedPatchEnvelope {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(patch, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ivHex = iv.toString("hex");
  const tagHex = tag.toString("hex");
  const ciphertextHex = ciphertext.toString("hex");
  const hmacSha256 = createHmac("sha256", key).update(`${ivHex}:${tagHex}:${ciphertextHex}`).digest("hex");
  return { algorithm: "aes-256-gcm", ivHex, tagHex, ciphertextHex, hmacSha256 };
}

export function decryptHandoffPatch(envelope: EncryptedPatchEnvelope, secret: string): string {
  const key = createHash("sha256").update(secret).digest();
  const expectedHmac = createHmac("sha256", key)
    .update(`${envelope.ivHex}:${envelope.tagHex}:${envelope.ciphertextHex}`)
    .digest("hex");
  if (expectedHmac !== envelope.hmacSha256) {
    throw new Error("Assinatura HMAC-SHA256 do patch inválida.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(envelope.tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertextHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}

export function publishHandoffGitBranch(repoDir: string, taskId: string, pushRemote = false): string {
  const branchName = `handoff/${taskId}`;
  execFileSync("git", ["-C", repoDir, "checkout", "-B", branchName], { stdio: "ignore" });
  execFileSync("git", ["-C", repoDir, "add", "-A"], { stdio: "ignore" });
  try {
    execFileSync("git", ["-C", repoDir, "commit", "-m", `chore(handoff): checkpoint ${taskId}`], { stdio: "ignore" });
  } catch {
    // Sem alterações pendentes para commit
  }
  if (pushRemote) {
    execFileSync("git", ["-C", repoDir, "push", "-u", "origin", branchName], { stdio: "ignore" });
  }
  return branchName;
}

export function prepareResumeBranch(repoDir: string, handoffId: string, baseCommitSha: string): string {
  const branchName = `resume/${handoffId}`;
  execFileSync("git", ["-C", repoDir, "checkout", "-B", branchName, baseCommitSha], { stdio: "ignore" });
  return branchName;
}

export async function uploadEncryptedPatchToMinio(
  minioEndpoint: string,
  bucket: string,
  objectKey: string,
  envelope: EncryptedPatchEnvelope,
  fetchFn: typeof fetch = fetch
): Promise<{ uri: string; uploaded: boolean }> {
  const url = `${minioEndpoint.replace(/\/$/, "")}/${bucket}/${objectKey}.enc.json`;
  const res = await fetchFn(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope)
  });
  return { uri: url, uploaded: res.ok };
}

export async function createHandoffWithSync(
  store: HandoffStore,
  ctx: AuthContext,
  input: Omit<AgentHandoff, "handoffId" | "tenantId" | "createdAt"> & {
    repoDir?: string;
    pushRemote?: boolean;
    patchContent?: string;
    minioEndpoint?: string;
    minioBucket?: string;
    patchSecret?: string;
  }
): Promise<{ handoff: AgentHandoff; patchRef?: string }> {
  let ephemeralBranch = input.ephemeralBranch;
  let patchRef: string | undefined;

  if (input.workingTreeDirty) {
    if (input.repoDir && input.pushRemote) {
      ephemeralBranch = publishHandoffGitBranch(input.repoDir, input.taskId, true);
      patchRef = `git:${ephemeralBranch}`;
    } else if (input.patchContent && input.minioEndpoint && input.patchSecret) {
      const envelope = encryptHandoffPatch(input.patchContent, input.patchSecret);
      const uploaded = await uploadEncryptedPatchToMinio(
        input.minioEndpoint,
        input.minioBucket ?? "noema-handoffs",
        `${ctx.tenantId}/${input.projectId}/${input.taskId}`,
        envelope
      );
      if (!uploaded.uploaded) {
        throw new BrainError(
          "BRAIN_ERR_CONFLICT",
          "Falha ao enviar patch criptografado para o MinIO; workingTreeDirty=true não pode ser declarado transferido.",
          409
        );
      }
      patchRef = uploaded.uri;
    } else {
      throw new BrainError(
        "BRAIN_ERR_CONFLICT",
        "workingTreeDirty=true exige publicação de branch efêmera Git ou upload de patch criptografado no MinIO.",
        409
      );
    }
  }

  const handoff = store.createHandoff(ctx, {
    fromAgent: input.fromAgent,
    projectId: input.projectId,
    taskId: input.taskId,
    repoUrl: input.repoUrl,
    branch: input.branch,
    baseCommitSha: input.baseCommitSha,
    workingTreeDirty: input.workingTreeDirty,
    ephemeralBranch,
    modifiedFiles: input.modifiedFiles,
    testsExecuted: input.testsExecuted,
    decisions: input.decisions,
    nextSteps: input.nextSteps
  });

  return { handoff, patchRef };
}

export function resumeHandoffWithSync(
  store: HandoffStore,
  ctx: AuthContext,
  query: {
    projectId: string;
    handoffId?: string;
    taskId?: string;
    currentBranch?: string;
    currentCommit?: string;
    repoDir?: string;
    createResumeBranch?: boolean;
  }
): { handoff?: AgentHandoff; resumeBranch?: string; warnings: string[] } {
  const res = store.resumeHandoff(ctx, query);
  let resumeBranch: string | undefined;
  if (
    res.handoff &&
    query.createResumeBranch &&
    query.repoDir &&
    ((query.currentBranch && query.currentBranch !== res.handoff.branch) ||
      (query.currentCommit && query.currentCommit !== res.handoff.baseCommitSha))
  ) {
    resumeBranch = prepareResumeBranch(query.repoDir, res.handoff.handoffId, res.handoff.baseCommitSha);
    res.warnings.push(`Branch isolada de retomada criada: '${resumeBranch}'.`);
  }
  return { ...res, resumeBranch };
}


