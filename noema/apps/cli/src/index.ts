#!/usr/bin/env node
/**
 * Noema / Brain CLI — Ponto de entrada multiplataforma (Windows, Linux, macOS).
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { installIdeAdapter, type SupportedIde } from "@noema/agent-adapters";
import { detectWorkspaceContext } from "@noema/workspace-detection";
import {
  resolveCliAuthToken,
  runDoctor,
  runHandoffCreate,
  runHookEmit,
  runHookInstall,
  runInit,
  runInitWithScip,
  runRunnerUp,
  runScaffold,
  runValidate
} from "./commands.js";

const [, , command = "help", sub = "", ...rest] = process.argv;

function requireApiKey(): string {
  const key = process.env.NOEMA_LOCAL_API_KEY;
  if (!key || !key.trim()) {
    throw new Error("NOEMA_LOCAL_API_KEY é obrigatória para autenticar no Hub.");
  }
  return key.trim();
}

function getHubConfig(projectFallback?: string) {
  const hubUrl = (process.env.NOEMA_HUB_URL ?? "http://localhost:3333").replace(/\/$/, "");
  const apiKey = requireApiKey();
  const projectId = process.env.NOEMA_PROJECT_ID ?? projectFallback ?? detectWorkspaceContext(process.cwd()).projectId;
  return { hubUrl, apiKey, projectId };
}

async function main() {
  switch (command) {
    case "init": {
      const scip = sub === "--scip" || rest.includes("--scip");
      const initProjectId = (sub && !sub.startsWith("--") ? sub : rest.find((arg) => !arg.startsWith("--"))) || undefined;
      const res = scip
        ? await runInitWithScip(process.cwd(), initProjectId)
        : await runInit(process.cwd(), initProjectId);
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "doctor": {
      const res = runDoctor(process.cwd());
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "env": {
      if (sub === "check") {
        const res = runDoctor(process.cwd());
        console.log(JSON.stringify({ ok: res.missingEnvVars.length === 0, missingEnvVars: res.missingEnvVars }, null, 2));
        if (res.missingEnvVars.length > 0) process.exitCode = 1;
      } else {
        console.log("Uso: brain env check");
      }
      break;
    }
    case "scaffold": {
      const name = sub || "new-service";
      const safeName = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
      if (!safeName) throw new Error("Informe um nome com letras ou números para o projeto.");
      const readOption = (key: string) => {
        const index = rest.indexOf(`--${key}`);
        if (index < 0) return undefined;
        const value = rest[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`--${key} requer um valor.`);
        return value;
      };
      const hasFlag = (key: string) => rest.includes(`--${key}`);
      const stack = readOption("stack");
      const criticality = readOption("criticality");
      const communication = readOption("communication");
      if (stack && !["node-ts", "python"].includes(stack)) throw new Error("--stack aceita node-ts ou python.");
      if (criticality && !["low", "medium", "high", "critical"].includes(criticality)) throw new Error("--criticality aceita low, medium, high ou critical.");
      if (communication && !["sync", "events"].includes(communication)) throw new Error("--communication aceita sync ou events.");
      const adrRaw = readOption("adr");
      const appliedAdrs = adrRaw
        ? adrRaw
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean)
            .map((id) => ({ id, title: `Precedente ${id}` }))
        : undefined;
      const res = runScaffold(resolve(process.cwd(), safeName), safeName, {
        objective: readOption("objective"),
        domain: readOption("domain"),
        criticality: criticality as "low" | "medium" | "high" | "critical" | undefined,
        stack: stack as "node-ts" | "python" | undefined,
        communication: communication as "sync" | "events" | undefined,
        handlesPii: hasFlag("pii"),
        handlesPayments: hasFlag("payments"),
        appliedAdrs,
        ciGuardians: !hasFlag("no-ci")
      });
      console.log(JSON.stringify(res, null, 2));
      break;
    }
    case "runner": {
      if (sub === "up") {
        const isLocal = rest.includes("--local");
        const pull = rest.includes("--pull");
        const hybrid = rest.includes("--hybrid");
        const providerIdx = rest.indexOf("--provider");
        const provider = providerIdx >= 0 ? rest[providerIdx + 1] : undefined;
        const res = await runRunnerUp({ local: isLocal, pull, provider, hybrid });
        console.log(JSON.stringify(res, null, 2));
        const readyForDaemon = res.status === "ready" || res.status === "cloud_fallback_ready";
        if (!readyForDaemon) {
          process.exitCode = 1;
        }
      } else {
        console.log("Uso: brain runner up --local [--pull] | --hybrid | --provider <ollama|fm|openai|anthropic> [--pull]");
      }
      break;
    }
    case "adapters": {
      if (sub === "install") {
        const ide = (rest[0] || "antigravity") as SupportedIde;
        const written = installIdeAdapter(process.cwd(), ide);
        console.log(JSON.stringify({ installed: ide, files: written }, null, 2));
      } else {
        console.log("Uso: brain adapters install <antigravity|cursor|claude-code|codex|kiro|vscode|jetbrains>");
      }
      break;
    }
    case "privacy": {
      if (sub === "erase" && rest[0]) {
        const { hubUrl, apiKey, projectId } = getHubConfig(rest[1]);
        const res = await fetch(`${hubUrl}/v1/privacy/erase`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ subjectId: rest[0], projectId })
        });
        console.log(await res.text());
      } else {
        console.log("Uso: brain privacy erase <subjectId> [projectId]");
      }
      break;
    }
    case "mcp": {
      if (sub === "serve") {
        const child = spawn("noema-mcp", [], { stdio: "inherit" });
        await new Promise<void>((resolve) => child.on("exit", () => resolve()));
      } else if (sub === "connect" && rest[0]) {
        const targetUrl = rest[0];
        const token = await resolveCliAuthToken();
        let mcpSessionId: string | null = null;
        const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const res = await fetch(targetUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${token}`,
              ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {})
            },
            body: trimmed
          });
          const respSessionId = res.headers.get("mcp-session-id");
          if (respSessionId) mcpSessionId = respSessionId;
          const text = await res.text();
          if (!text.trim()) continue;
          const ct = res.headers.get("content-type") ?? "";
          if (ct.includes("text/event-stream") || text.includes("\ndata:") || text.startsWith("event:")) {
            for (const sseLine of text.split(/\r?\n/)) {
              if (sseLine.startsWith("data:")) {
                const payload = sseLine.slice(5).trim();
                if (payload) process.stdout.write(`${payload}\n`);
              }
            }
          } else {
            process.stdout.write(`${text.trim()}\n`);
          }
        }
      } else {
        console.log("Uso: brain mcp <serve|connect <url>>");
      }
      break;
    }
    case "context": {
      if (sub === "explain" || sub === "build") {
        const { hubUrl, apiKey, projectId } = getHubConfig();
        const task = rest.join(" ") || "context";
        const res = await fetch(`${hubUrl}/v1/projects/${projectId}/context`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ task, explain: sub === "explain" })
        });
        console.log(await res.text());
      } else {
        console.log("Uso: brain context <build|explain> <task>");
      }
      break;
    }
    case "handoff": {
      const { hubUrl, apiKey, projectId } = getHubConfig();
      const ws = detectWorkspaceContext(process.cwd());
      if (sub === "create") {
        const flags = new Set(["--push", "--dirty", "--sync"]);
        const positional = rest.filter((arg) => !flags.has(arg));
        const taskId = positional[0] || `TASK-${Date.now()}`;
        const pushRemote = rest.includes("--push") || rest.includes("--sync");
        const workingTreeDirty = rest.includes("--dirty") || ws.modifiedFiles.length > 0;
        const result = await runHandoffCreate({
          hubUrl,
          apiKey,
          projectId,
          taskId,
          repoDir: process.cwd(),
          repoUrl: ws.repoUrl,
          branch: ws.branch,
          baseCommitSha: ws.baseCommitSha,
          modifiedFiles: ws.modifiedFiles,
          nextSteps: positional.slice(1),
          pushRemote,
          workingTreeDirty
        });
        console.log(result.body);
      } else if (sub === "checkout") {
        const taskId = rest[0];
        const res = await fetch(`${hubUrl}/v1/projects/${projectId}/handoffs/latest${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ""}`, {
          headers: { authorization: `Bearer ${apiKey}` }
        });
        const data = (await res.json()) as {
          handoff?: { handoffId?: string; branch?: string; baseCommitSha?: string; patchRef?: string; ephemeralBranch?: string };
        };
        let resumeBranch: string | undefined;
        let patchApplied = false;
        if (data.handoff?.ephemeralBranch || data.handoff?.branch) {
          const targetBranch = data.handoff.ephemeralBranch ?? data.handoff.branch!;
          try {
            execFileSync("git", ["checkout", targetBranch], { stdio: "inherit" });
            resumeBranch = targetBranch;
          } catch {
            if (data.handoff.handoffId && data.handoff.baseCommitSha) {
              const { prepareResumeBranch } = await import("@noema/agent-handoff");
              resumeBranch = prepareResumeBranch(process.cwd(), data.handoff.handoffId, data.handoff.baseCommitSha);
            }
          }
          if (data.handoff.patchRef?.startsWith("http") && process.env.NOEMA_HANDOFF_ENCRYPTION_KEY) {
            const patchRes = await fetch(data.handoff.patchRef);
            if (patchRes.ok) {
              const envelope = (await patchRes.json()) as Parameters<typeof import("@noema/agent-handoff")["decryptHandoffPatch"]>[0];
              const { decryptHandoffPatch } = await import("@noema/agent-handoff");
              const diffText = decryptHandoffPatch(envelope, process.env.NOEMA_HANDOFF_ENCRYPTION_KEY);
              execFileSync("git", ["apply", "--whitespace=nowarn", "-"], { input: diffText, stdio: ["pipe", "inherit", "inherit"] });
              patchApplied = true;
            }
          }
        }
        console.log(JSON.stringify({ ...data, resumeBranch, patchApplied }, null, 2));
      } else {
        console.log("Uso: brain handoff <create <taskId> [nextSteps...]|checkout [taskId]>");
      }
      break;
    }
    case "task": {
      if (sub === "enqueue") {
        const { hubUrl, apiKey, projectId } = getHubConfig();
        const instruction = rest.join(" ");
        const res = await fetch(`${hubUrl}/v1/projects/${projectId}/runner/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ instruction })
        });
        console.log(await res.text());
      } else if (sub === "list") {
        const { hubUrl, apiKey, projectId } = getHubConfig();
        const res = await fetch(`${hubUrl}/v1/projects/${projectId}/runner/tasks`, {
          headers: { authorization: `Bearer ${apiKey}` }
        });
        console.log(await res.text());
      } else {
        console.log("Uso: brain task <enqueue <instruction>|list>");
      }
      break;
    }
    case "ingest": {
      if (sub) {
        const { hubUrl, apiKey, projectId } = getHubConfig(rest[0]);
        const content = readFileSync(sub, "utf8");
        const res = await fetch(`${hubUrl}/v1/projects/${projectId}/ingest`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ filePath: sub.replace(/\\/g, "/"), content })
        });
        console.log(await res.text());
      } else {
        console.log("Uso: brain ingest <filePath> [projectId]");
      }
      break;
    }
    case "validate": {
      const res = runValidate(process.cwd());
      console.log(JSON.stringify(res, null, 2));
      if (!res.passed) process.exitCode = 1;
      break;
    }
    case "migrate": {
      execFileSync("npm", ["-w", "@noema/database", "run", "db:migrate"], { stdio: "inherit" });
      break;
    }
    case "export":
    case "brainpack": {
      const { hubUrl, apiKey, projectId } = getHubConfig(rest[1] || rest[0]);
      if (command === "export" || sub === "export") {
        const res = await fetch(`${hubUrl}/v1/projects/${projectId}/brainpack`, {
          headers: { authorization: `Bearer ${apiKey}` }
        });
        const json = await res.text();
        const sha256 = createHash("sha256").update(json).digest("hex");
        const outFile = (command === "export" ? sub : rest[0]) || `${projectId}.brainpack.json`;
        if (outFile.endsWith(".json")) {
          writeFileSync(outFile, json, "utf8");
          console.log(JSON.stringify({ exported: outFile, sha256 }));
        } else {
          console.log(json);
        }
      } else if (sub === "import" && rest[0]) {
        const payload = JSON.parse(readFileSync(rest[0], "utf8")) as { items?: unknown[] };
        const res = await fetch(`${hubUrl}/v1/projects/${projectId}/brainpack/import`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ items: payload.items ?? [] })
        });
        console.log(await res.text());
      } else {
        console.log("Uso: brain brainpack <export|import <file>> [projectId]");
      }
      break;
    }
    case "import": {
      if (sub) {
        const { hubUrl, apiKey, projectId } = getHubConfig(rest[0]);
        const payload = JSON.parse(readFileSync(sub, "utf8")) as { items?: unknown[] };
        const res = await fetch(`${hubUrl}/v1/projects/${projectId}/brainpack/import`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ items: payload.items ?? [] })
        });
        console.log(await res.text());
      } else {
        console.log("Uso: brain import <file.brainpack.json> [projectId]");
      }
      break;
    }
    case "hook": {
      const readOption = (key: string) => {
        const index = rest.indexOf(`--${key}`);
        if (index < 0) return undefined;
        const value = rest[index + 1];
        return value && !value.startsWith("--") ? value : undefined;
      };
      if (sub === "install") {
        const res = runHookInstall(process.cwd(), {
          harness: readOption("harness"),
          projectId: readOption("project")
        });
        console.log(JSON.stringify(res, null, 2));
      } else if (sub === "emit") {
        const { hubUrl, apiKey, projectId } = getHubConfig(readOption("project"));
        const event = (readOption("event") ?? "session_start") as "session_start" | "tool_use" | "session_end" | "pre_compact";
        const harness = readOption("harness") ?? "cli";
        const sessionId = readOption("session") ?? `sess-${Date.now()}`;
        const summary = readOption("summary");
        const filesRaw = readOption("files");
        const res = await runHookEmit({
          hubUrl,
          apiKey,
          projectId,
          harness,
          event,
          sessionId,
          summary,
          modifiedFiles: filesRaw ? filesRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined
        });
        console.log(res.body);
      } else {
        console.log("Uso: brain hook <install|emit> [--harness <ide>] [--event <session_start|tool_use|pre_compact|session_end>]");
      }
      break;
    }
    case "ui": {
      const webUrl = process.env.NOEMA_WEB_URL ?? "http://localhost:3000";
      if (sub === "--start" || rest.includes("--start")) {
        spawn("npm", ["-w", "@noema/web", "run", "start"], { stdio: "inherit" });
      } else {
        console.log(`Command Center disponível em ${webUrl} (use 'brain ui --start' para iniciar)`);
      }
      break;
    }
    default: {
      console.log("Noema / Brain CLI v0.1.0 — Project Brain OS 2.0\n");
      console.log("  brain init [projectId]         Gera .project-brain.json e rascunhos em .brain/");
      console.log("  brain doctor / env check       Diagnostica Node, hardware e .env.example");
      console.log("  brain scaffold <name> [opções]  Cria base guiada no padrão Noema");
      console.log("  brain adapters install <ide>   Instala adaptador MCP + instruções da IDE");
      console.log("  brain mcp <serve|connect url>  Servidor stdio ou bridge Streamable HTTP");
      console.log("  brain context <build|explain>  Monta Context Pack (com --explain)");
      console.log("  brain handoff <create|checkout>Cria ou retoma Agent Handoff");
      console.log("  brain ingest <file>            Ingere arquivo no Hub");
      console.log("  brain task enqueue [--local]   Enfileira tarefa no Hub ou Edge local");
      console.log("  brain task list --local        Consulta estado e draft local");
      console.log("  brain validate / migrate       Valida governança ou executa migrations");
      console.log("  brain export / import          Exporta ou importa pacote .brainpack");
      console.log("  brain ui [--start]             Exibe ou inicia Command Center (Next.js)");
      console.log("  brain privacy erase <id>       Exclusão LGPD por titular");
      console.log("  brain runner up --local        Executa Runner local até Ctrl-C");
      console.log("  brain sync [status|pull|push]  Gerencia Local Edge Brain (SQLite FTS5)");
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
