import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadVscode(vscodeOverride) {
  if (vscodeOverride) return vscodeOverride;
  try {
    return require("vscode");
  } catch {
    return null;
  }
}

async function postNoemaJson(path, payload, fetchFn = fetch) {
  const apiUrl = process.env.NOEMA_API_URL || "http://localhost:3333";
  const apiKey = process.env.NOEMA_LOCAL_API_KEY;
  if (!apiKey) {
    throw new Error("NOEMA_LOCAL_API_KEY não configurada para a extensão VS Code.");
  }
  const res = await fetchFn(`${apiUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    throw new Error(`Noema API falhou (${res.status}) em ${path}`);
  }
  return res.json();
}

export async function buildContextPack(projectId, task, fetchFn = fetch) {
  return postNoemaJson(`/v1/projects/${encodeURIComponent(projectId)}/context`, { task }, fetchFn);
}

export async function createHandoff(projectId, handoff, fetchFn = fetch) {
  return postNoemaJson(`/v1/projects/${encodeURIComponent(projectId)}/handoffs`, handoff, fetchFn);
}

export function activate(context, vscodeOverride) {
  const vscode = loadVscode(vscodeOverride);
  const subscriptions = context?.subscriptions ?? [];

  if (vscode?.commands?.registerCommand) {
    const buildCmd = vscode.commands.registerCommand("noema.buildContextPack", async (args = {}) => {
      const projectId = args.projectId || process.env.NOEMA_PROJECT_ID || "default";
      const task = args.task || "Build context pack from VS Code";
      return buildContextPack(projectId, task);
    });

    const handoffCmd = vscode.commands.registerCommand("noema.createHandoff", async (args = {}) => {
      const projectId = args.projectId || process.env.NOEMA_PROJECT_ID || "default";
      const handoff = args.handoff || {
        targetAgent: args.targetAgent || "claude-code",
        summary: args.summary || "Handoff from VS Code"
      };
      return createHandoff(projectId, handoff);
    });

    subscriptions.push(buildCmd, handoffCmd);
  }

  return {
    gatewayUrl: process.env.NOEMA_API_URL || "http://localhost:3333/mcp",
    buildContextPack,
    createHandoff,
    context
  };
}
export function deactivate() {}
