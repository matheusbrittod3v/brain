import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename, relative } from "node:path";
import os from "node:os";
import { createHandoffWithSync, HandoffStore } from "@noema/agent-handoff";
import {
  evaluateArchitectureChange,
  type AppAdapterFile,
  type ArchitectureImportEdge
} from "@noema/architecture-guardian";
import type { AuthContext } from "@noema/auth";
import { evaluateBusinessRuleCompliance, type GuardianMode } from "@noema/business-rule-guardian";
import { parseKnowledgeFile } from "@noema/knowledge";
import type { KnowledgeItem } from "@noema/core";
import type { EdgeDatabase, EdgeRunnerTask } from "./edge-db.js";

export function runInit(rootDir: string, projectId?: string) {
  const resolvedId = projectId ?? basename(rootDir).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const pkgPath = join(rootDir, "package.json");
  const hasNode = existsSync(pkgPath);
  const hasPython = existsSync(join(rootDir, "pyproject.toml")) || existsSync(join(rootDir, "requirements.txt"));
  const hasEnvExample = existsSync(join(rootDir, ".env.example"));

  const files = readdirSync(rootDir);
  const manifest = {
    schemaVersion: "1.0.0",
    tenantId: "default-org",
    projectId: resolvedId,
    knowledgeRoot: ".brain/",
    guardianMode: "advisory",
    detectedStack: { node: hasNode, python: hasPython, envExample: hasEnvExample }
  };

  writeFileSync(join(rootDir, ".project-brain.json"), JSON.stringify(manifest, null, 2));
  mkdirSync(join(rootDir, ".brain/00-overview"), { recursive: true });
  mkdirSync(join(rootDir, ".brain/01-business/business-rules"), { recursive: true });
  mkdirSync(join(rootDir, ".brain/03-architecture/decisions"), { recursive: true });

  writeFileSync(
    join(rootDir, ".brain/00-overview/vision.md"),
    `---\nid: VIS-${resolvedId}\ntype: document\nstatus: draft\n---\n\n# Visão do Projeto (${resolvedId})\n\nGerado automaticamente pelo Noema Autodiscovery (${files.length} entradas na raiz).\n`
  );

  return { projectId: resolvedId, manifestPath: ".project-brain.json", stack: manifest.detectedStack };
}

export function runDoctor(rootDir: string, env: NodeJS.ProcessEnv = process.env) {
  const nodeVersion = process.version;
  const envExamplePath = join(rootDir, ".env.example");
  const missingEnvVars: string[] = [];

  if (existsSync(envExamplePath)) {
    const lines = readFileSync(envExamplePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        if (!(key in env)) missingEnvVars.push(key);
      }
    }
  }

  return {
    nodeVersion,
    platform: process.platform,
    arch: process.arch,
    totalRamGb: Math.round(os.totalmem() / 1024 ** 3),
    missingEnvVars
  };
}

export function selectRunnerProfile(totalRamBytes = os.totalmem()) {
  const ramGb = totalRamBytes / 1024 ** 3;
  if (ramGb <= 8) {
    return { profile: "lite", model: "qwen2.5-coder:1.5b", useVector: false };
  }
  return { profile: "standard", model: "qwen2.5-coder:3b", useVector: true };
}

export async function runRunnerUp(
  opts: { local?: boolean; pull?: boolean; provider?: string; hybrid?: boolean; ollamaUrl?: string },
  fetchFn: typeof fetch = fetch
) {
  const selected = selectRunnerProfile();
  if (opts.hybrid) {
    throw new Error("O modo --hybrid ainda não tem executor de fallback implementado.");
  }
  if (opts.provider && opts.provider !== "ollama") {
    throw new Error(`O provedor '${opts.provider}' ainda não está implementado no Brain Runner.`);
  }
  if (!opts.local && !opts.provider) {
    throw new Error("Selecione --local ou --provider ollama; nenhum provedor padrão está configurado.");
  }
  const baseUrl = opts.ollamaUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  const tagsRes = await fetchFn(`${baseUrl}/api/tags`);
  if (!tagsRes.ok) {
    throw new Error(`Ollama indisponível em ${baseUrl} (HTTP ${tagsRes.status}).`);
  }
  const tagsJson = (await tagsRes.json()) as { models?: Array<{ name: string }> };
  const installed = (tagsJson.models ?? []).some((m) => m.name.startsWith(selected.model));
  if (!installed && opts.pull) {
    const pullRes = await fetchFn(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: selected.model, stream: false })
    });
    if (!pullRes.ok) throw new Error(`Ollama não conseguiu baixar ${selected.model} (HTTP ${pullRes.status}).`);
  }
  return {
    mode: "local",
    status: installed || opts.pull ? "ready" : "model_missing_use_--pull",
    pulled: !installed && Boolean(opts.pull),
    ...selected
  };
}

export function runLocalTaskEnqueue(db: EdgeDatabase, projectId: string, instruction: string): EdgeRunnerTask {
  if (!instruction.trim()) throw new Error("A tarefa local precisa de uma instrução.");
  return db.enqueueRunnerTask(projectId, instruction.trim());
}

export function runLocalTaskList(db: EdgeDatabase, projectId?: string): EdgeRunnerTask[] {
  return db.listRunnerTasks(projectId);
}

export function enforceOfflineLeaseIfStored(db: EdgeDatabase, now = new Date()): void {
  if (db.hasOfflineLease()) {
    db.assertOfflineLeaseValid(now);
  }
}

export async function runSyncPull(
  opts: { hubUrl: string; apiKey: string; projectId: string; db: EdgeDatabase },
  fetchFn: typeof fetch = fetch
) {
  enforceOfflineLeaseIfStored(opts.db);
  const cursor = opts.db.getSyncCursor();
  const knownPolicies = opts.db.listKnownPolicies();
  type SyncPage = {
    syncMode?: "snapshot" | "delta";
    syncSeq: number;
    policyEpoch?: number;
    revokedPolicies: string[];
    tombstones?: string[];
    snapshotSeq?: number;
    snapshotCursor?: string | null;
    snapshotDone?: boolean;
    snapshotRestarted?: boolean;
    items: Array<{ id: string; projectId: string; title: string; content: string; accessPolicyId: string; contentHash: string }>;
  };
  const fetchPage = async (snapshot?: { cursor: string | null; seq: number; epoch: number }): Promise<SyncPage> => {
    const res = await fetchFn(`${opts.hubUrl}/v1/sync/pull`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`
      },
      body: JSON.stringify({
        projectId: opts.projectId,
        sinceSeq: cursor.syncSeq,
        policyEpoch: snapshot?.epoch ?? cursor.policyEpoch,
        knownPolicies,
        ...(snapshot ? { snapshotSeq: snapshot.seq, snapshotCursor: snapshot.cursor } : {})
      })
    });
    if (!res.ok) throw new Error(`Sync pull falhou: HTTP ${res.status}`);
    return (await res.json()) as SyncPage;
  };

  let data = await fetchPage();
  let syncMode = data.syncMode ?? "snapshot";
  let upserted = 0;
  const revokedPolicies = new Set(data.revokedPolicies ?? []);
  const tombstones = new Set(data.tombstones ?? []);
  let snapshotOpen = syncMode === "snapshot";
  try {
    if (snapshotOpen) {
      opts.db.beginAtomicSnapshotRebuild();
      opts.db.appendAtomicSnapshotPage(data.items ?? []);
      upserted += data.items?.length ?? 0;
    }
    while (syncMode === "snapshot" && data.snapshotDone === false) {
      if (!data.snapshotCursor || data.snapshotSeq === undefined) {
        throw new Error("Snapshot de sync retornou página incompleta sem cursor de continuação.");
      }
      data = await fetchPage({
        cursor: data.snapshotCursor,
        seq: data.snapshotSeq,
        epoch: data.policyEpoch ?? cursor.policyEpoch
      });
      if (data.snapshotRestarted) {
        opts.db.beginAtomicSnapshotRebuild();
        upserted = 0;
        revokedPolicies.clear();
        tombstones.clear();
      }
      syncMode = data.syncMode ?? "snapshot";
      if (syncMode !== "snapshot") throw new Error("O Hub mudou o modo de sync antes do snapshot terminar.");
      opts.db.appendAtomicSnapshotPage(data.items ?? []);
      upserted += data.items?.length ?? 0;
      for (const policy of data.revokedPolicies ?? []) revokedPolicies.add(policy);
      for (const id of data.tombstones ?? []) tombstones.add(id);
    }

    if (snapshotOpen) {
      opts.db.commitAtomicSnapshotRebuild(data.snapshotSeq ?? data.syncSeq, data.policyEpoch ?? cursor.policyEpoch);
      snapshotOpen = false;
    }
  } catch (error) {
    if (snapshotOpen) opts.db.abortAtomicSnapshotRebuild();
    throw error;
  }

  const incomingEpoch = data.policyEpoch ?? cursor.policyEpoch;
  const revokedCount = opts.db.revokePolicies([...revokedPolicies]);
  let tombstonesRemoved = 0;
  if (syncMode === "delta") {
    tombstonesRemoved = opts.db.applyTombstones([...tombstones]);
    for (const item of data.items ?? []) {
      opts.db.upsertItem(item);
    }
    opts.db.setSyncCursor(data.syncSeq, incomingEpoch);
    upserted = data.items?.length ?? 0;
  }
  return {
    syncMode,
    syncSeq: data.syncSeq,
    policyEpoch: incomingEpoch,
    upserted,
    revokedCount,
    tombstonesRemoved
  };
}

export async function runSyncPush(
  opts: { hubUrl: string; apiKey: string; projectId: string; db: EdgeDatabase },
  fetchFn: typeof fetch = fetch
) {
  enforceOfflineLeaseIfStored(opts.db);
  const drafts = opts.db.listStaged();
  if (drafts.length === 0) return { pushed: 0 };
  const res = await fetchFn(`${opts.hubUrl}/v1/sync/push`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`
    },
    body: JSON.stringify({ projectId: opts.projectId, drafts })
  });
  if (!res.ok) throw new Error(`Sync push falhou: HTTP ${res.status}`);
  const body = (await res.json()) as { acceptedCount: number; acceptedIds?: string[] };
  for (const id of body.acceptedIds ?? drafts.map((d) => d.id)) {
    opts.db.markStagedPromoted(id);
  }
  const cleanedPromoted = opts.db.cleanupPromotedStaging(30);
  return { pushed: body.acceptedCount, cleanedPromoted };
}

export interface ScaffoldAppliedAdr {
  id: string;
  title: string;
  summary?: string;
  sourceUri?: string;
  sourceProjectId?: string;
}

export interface ScaffoldBlueprint {
  objective?: string;
  domain?: string;
  criticality?: "low" | "medium" | "high" | "critical";
  stack?: "node-ts" | "python";
  communication?: "sync" | "events";
  handlesPii?: boolean;
  handlesPayments?: boolean;
  appliedAdrs?: ScaffoldAppliedAdr[];
  ciGuardians?: boolean;
}

export function runScaffold(targetDir: string, serviceName: string, blueprint: ScaffoldBlueprint = {}) {
  const projectId = serviceName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
  if (!projectId) throw new Error("O nome do projeto deve conter letras ou números.");
  const domain = (blueprint.domain?.trim() || "general").replace(/[\r\n]+/g, " ").slice(0, 80);
  const resolvedBlueprint = {
    objective: blueprint.objective?.trim() || `Serviço ${projectId}`,
    domain,
    criticality: blueprint.criticality ?? "medium",
    stack: blueprint.stack ?? "node-ts",
    communication: blueprint.communication ?? "sync",
    handlesPii: blueprint.handlesPii ?? false,
    handlesPayments: blueprint.handlesPayments ?? false
  };
  const accessPolicyId = resolvedBlueprint.handlesPii || resolvedBlueprint.handlesPayments || resolvedBlueprint.criticality === "critical"
    ? "restricted-security"
    : "internal-project";
  const ruleId = `BR-${projectId.toUpperCase()}-001`;
  const safeObjective = resolvedBlueprint.objective.replace(/[\r\n]+/g, " ");
  const dataRiskGuidance = [
    resolvedBlueprint.handlesPii ? "Trate PII conforme classificação e retenção aprovadas." : "",
    resolvedBlueprint.handlesPayments ? "Revise os requisitos PCI e o tratamento de dados de pagamento." : ""
  ].filter(Boolean).join(" ");
  const appliedAdrs = (blueprint.appliedAdrs ?? []).filter((adr) => adr.id.trim().length > 0);
  const ciGuardians = blueprint.ciGuardians ?? true;
  mkdirSync(join(targetDir, ".brain/00-overview"), { recursive: true });
  mkdirSync(join(targetDir, ".brain/03-architecture/decisions"), { recursive: true });
  mkdirSync(join(targetDir, ".brain/04-engineering"), { recursive: true });
  mkdirSync(join(targetDir, ".brain/01-business/business-rules"), { recursive: true });
  mkdirSync(join(targetDir, "src"), { recursive: true });
  if (ciGuardians) {
    mkdirSync(join(targetDir, ".github/workflows"), { recursive: true });
  }

  writeFileSync(
    join(targetDir, ".project-brain.json"),
    JSON.stringify(
      {
        schemaVersion: "1.0.0",
        tenantId: "default-org",
        projectId,
        knowledgeRoot: ".brain/",
        guardianMode: "advisory",
        accessPolicyId,
        appliedAdrs: appliedAdrs.map((adr) => ({
          id: adr.id,
          title: adr.title,
          ...(adr.sourceProjectId ? { sourceProjectId: adr.sourceProjectId } : {}),
          ...(adr.sourceUri ? { sourceUri: adr.sourceUri } : {})
        })),
        blueprint: { ...resolvedBlueprint, objective: safeObjective }
      },
      null,
      2
    )
  );
  writeFileSync(
    join(targetDir, ".env.example"),
    `PORT=3000\nNOEMA_PROJECT_ID=${projectId}\n`
  );
  writeFileSync(join(targetDir, ".brain/00-overview/vision.md"), `# ${projectId}\n\n${safeObjective}\n\n- Domínio: ${resolvedBlueprint.domain}\n- Criticidade: ${resolvedBlueprint.criticality}\n- Política inicial: ${accessPolicyId}\n`);
  writeFileSync(
    join(targetDir, ".brain/01-business/business-rules/BR-001.yaml"),
    `id: ${ruleId}\ntype: business_rule\nstatus: draft\ntitle: Regra inicial\ndescription: Defina as invariantes de negócio para ${resolvedBlueprint.domain}. ${dataRiskGuidance}\naccess_policy: ${accessPolicyId}\n`
  );
  writeFileSync(join(targetDir, ".brain/03-architecture/decisions/ADR-001.md"), `---\nid: ADR-${projectId.toUpperCase()}-001\ntitle: Estilo de comunicação inicial\nstatus: draft\naccess_policy: ${accessPolicyId}\n---\n\n# Contexto\n\n${safeObjective}\n\n# Decisão proposta\n\n${resolvedBlueprint.communication === "events" ? "Integração assíncrona orientada a eventos." : "Integração síncrona entre serviços."}\n\nValidar esta proposta com Arquitetura antes de promover para approved.\n`);
  writeFileSync(join(targetDir, ".brain/04-engineering/security-standards.md"), `# Segurança e dados\n\n- PII: ${resolvedBlueprint.handlesPii ? "sim — classificar campos e documentar retenção/acesso" : "não declarado"}\n- Pagamentos: ${resolvedBlueprint.handlesPayments ? "sim — revisar escopo PCI e segredos" : "não declarado"}\n- Política de acesso inicial: \`${accessPolicyId}\`\n- Criticidade: ${resolvedBlueprint.criticality}\n\nRevise esta classificação com AppSec antes de produção.\n`);
  if (appliedAdrs.length > 0) {
    const precedentsBody = appliedAdrs
      .map(
        (adr) =>
          `## ${adr.id} — ${adr.title}\n` +
          (adr.sourceProjectId ? `- Projeto de origem: ${adr.sourceProjectId}\n` : "") +
          (adr.sourceUri ? `- Fonte: ${adr.sourceUri}\n` : "") +
          (adr.summary ? `\n${adr.summary}\n` : "")
      )
      .join("\n");
    writeFileSync(
      join(targetDir, ".brain/03-architecture/decisions/ADR-PRECEDENTS.md"),
      `---\nid: ADR-${projectId.toUpperCase()}-PRECEDENTS\ntitle: Precedentes arquiteturais aplicados\nstatus: draft\naccess_policy: ${accessPolicyId}\n---\n\n# Precedentes aplicados ao starter\n\n${precedentsBody}`
    );
  }
  if (ciGuardians) {
    writeFileSync(
      join(targetDir, ".github/workflows/noema-guardians.yml"),
      `name: Noema Guardians\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  guardians:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: "22"\n      - name: Validate architecture and business rules\n        run: npx --yes noema validate --path .\n`
    );
  }
  if (resolvedBlueprint.stack === "python") {
    writeFileSync(join(targetDir, "src/main.py"), `# @brain-rule ${ruleId}\ndef health():\n    return {"ok": True, "service": "${projectId}"}\n`);
    writeFileSync(join(targetDir, "pyproject.toml"), `[project]\nname = "${projectId}"\nversion = "0.1.0"\nrequires-python = ">=3.11"\n`);
  } else {
    writeFileSync(join(targetDir, "src/index.ts"), `// @brain-rule ${ruleId}\nexport function health() { return { ok: true, service: ${JSON.stringify(projectId)} }; }\n`);
  }

  return {
    targetDir,
    serviceName: projectId,
    accessPolicyId,
    appliedAdrCount: appliedAdrs.length,
    ciGuardians,
    blueprint: resolvedBlueprint
  };
}

function walkFiles(dir: string, exts: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", ".next"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, exts));
    else if (exts.test(entry)) out.push(full);
  }
  return out;
}

function resolvePackageNameForFile(rootDir: string, relPath: string): string {
  const parts = relPath.split("/");
  if ((parts[0] === "apps" || parts[0] === "packages") && parts[1]) {
    const pkgJsonPath = join(rootDir, parts[0], parts[1], "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string };
        if (parsed.name) return parsed.name;
      } catch {
        // ignore invalid package.json
      }
    }
    return `${parts[0]}/${parts[1]}`;
  }
  const rootPkg = join(rootDir, "package.json");
  if (existsSync(rootPkg)) {
    try {
      const parsed = JSON.parse(readFileSync(rootPkg, "utf8")) as { name?: string };
      if (parsed.name) return parsed.name;
    } catch {
      // ignore
    }
  }
  return basename(rootDir);
}

export function runValidate(rootDir: string) {
  let mode: GuardianMode = "advisory";
  let projectId = basename(rootDir);
  let tenantId = "default-org";
  let knowledgeRoot = ".brain";

  const manifestPath = join(rootDir, ".project-brain.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        guardianMode?: GuardianMode;
        projectId?: string;
        tenantId?: string;
        knowledgeRoot?: string;
      };
      if (manifest.guardianMode) mode = manifest.guardianMode;
      if (manifest.projectId) projectId = manifest.projectId;
      if (manifest.tenantId) tenantId = manifest.tenantId;
      if (manifest.knowledgeRoot) knowledgeRoot = manifest.knowledgeRoot;
    } catch {
      // keep defaults
    }
  }

  const brainDir = join(rootDir, knowledgeRoot);
  const activeRules: KnowledgeItem[] = [];
  for (const filePath of walkFiles(brainDir, /\.(md|ya?ml)$/i)) {
    const rel = relative(rootDir, filePath).replace(/\\/g, "/");
    const raw = readFileSync(filePath, "utf8");
    const item = parseKnowledgeFile({ tenantId, projectId, filePath: rel, rawContent: raw });
    if (item.type === "business_rule") {
      activeRules.push(item);
    }
  }

  const codeFiles: Array<{ path: string; content: string }> = [];
  const imports: ArchitectureImportEdge[] = [];
  const appFiles: AppAdapterFile[] = [];
  const importRegex = /from\s+["'](@noema\/[a-z0-9-]+)["']/g;

  for (const fullPath of walkFiles(rootDir, /\.(ts|tsx|js|jsx)$/i)) {
    const rel = relative(rootDir, fullPath).replace(/\\/g, "/");
    const content = readFileSync(fullPath, "utf8");
    codeFiles.push({ path: rel, content });
    if (rel.startsWith("apps/")) {
      appFiles.push({ filePath: rel, content });
    }
    const fromPkg = resolvePackageNameForFile(rootDir, rel);
    importRegex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      imports.push({ fromPkg, toPkg: match[1]!, filePath: rel });
    }
  }

  const architecture = evaluateArchitectureChange({ mode, imports, appFiles });
  const businessRules = evaluateBusinessRuleCompliance({
    mode,
    files: codeFiles,
    activeRules
  });

  return {
    mode,
    passed: architecture.passed && businessRules.passed,
    architecture,
    businessRules
  };
}

export async function resolveCliAuthToken(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const tokenUrl = env.OIDC_TOKEN_URL?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim();

  if (tokenUrl && clientId && clientSecret) {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret
    });
    const res = await fetchFn(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    if (res.ok) {
      const json = (await res.json()) as { access_token?: string };
      if (json.access_token && json.access_token.trim().length > 0) {
        return json.access_token.trim();
      }
    }
  }

  const apiKey = env.NOEMA_LOCAL_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Token OIDC ou NOEMA_LOCAL_API_KEY é obrigatório para autenticar.");
  }
  return apiKey;
}

export async function runHandoffCreate(
  opts: {
    hubUrl: string;
    apiKey: string;
    tenantId?: string;
    projectId: string;
    taskId: string;
    repoDir: string;
    repoUrl: string;
    branch: string;
    baseCommitSha: string;
    modifiedFiles: string[];
    nextSteps: string[];
    pushRemote?: boolean;
    workingTreeDirty?: boolean;
    patchContent?: string;
    minioEndpoint?: string;
    patchSecret?: string;
  },
  fetchFn: typeof fetch = fetch
) {
  const useSync = Boolean(opts.pushRemote || opts.workingTreeDirty || opts.patchContent);
  let payload: Record<string, unknown> = {
    taskId: opts.taskId,
    fromAgent: "cli",
    repoUrl: opts.repoUrl,
    branch: opts.branch,
    baseCommitSha: opts.baseCommitSha,
    modifiedFiles: opts.modifiedFiles,
    nextSteps: opts.nextSteps
  };

  if (useSync) {
    const store = new HandoffStore();
    const ctx: AuthContext = {
      tenantId: opts.tenantId ?? "default-org",
      actorId: "cli",
      actorType: "human",
      roles: ["developer"],
      allowedProjects: [opts.projectId],
      allowedPolicies: ["internal-project"]
    };
    const synced = await createHandoffWithSync(store, ctx, {
      fromAgent: "cli",
      projectId: opts.projectId,
      taskId: opts.taskId,
      repoUrl: opts.repoUrl,
      branch: opts.branch,
      baseCommitSha: opts.baseCommitSha,
      workingTreeDirty: Boolean(opts.workingTreeDirty),
      modifiedFiles: opts.modifiedFiles,
      testsExecuted: [],
      decisions: [],
      nextSteps: opts.nextSteps,
      repoDir: opts.repoDir,
      pushRemote: opts.pushRemote,
      patchContent: opts.patchContent,
      minioEndpoint: opts.minioEndpoint,
      patchSecret: opts.patchSecret
    });
    payload = { ...synced.handoff, ...(synced.patchRef ? { patchRef: synced.patchRef } : {}) };
  }

  const res = await fetchFn(`${opts.hubUrl}/v1/projects/${opts.projectId}/handoffs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(payload)
  });
  return { status: res.status, body: await res.text() };
}

