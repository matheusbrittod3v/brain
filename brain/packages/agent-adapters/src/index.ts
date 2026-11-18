import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SupportedIde =
  | "antigravity"
  | "cursor"
  | "claude-code"
  | "codex"
  | "kiro"
  | "vscode"
  | "jetbrains";

export interface GeneratedAdapterFiles {
  ide: SupportedIde;
  files: Array<{ path: string; content: string }>;
}

const SHORT_INSTRUCTION = `# Brain — Project Brain OS 2.0

Use sempre o servidor MCP \`brain\` (catálogo extensível, atualmente 14 tools) antes de editar código crítico; documente cada nova tool e preserve paridade/testes:
1. \`brain_context_build\` para montar o Context Pack da tarefa.
2. \`brain_validate_implementation\` antes de concluir alterações em regras de negócio.
3. \`brain_create_handoff\` / \`brain_resume_handoff\` para continuidade cross-IDE.
`;

export function generateAdapterConfig(
  ide: SupportedIde,
  options: { mcpCommand?: string; mcpUrl?: string } = {}
): GeneratedAdapterFiles {
  const command = options.mcpCommand ?? "brain-mcp";
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        brain: options.mcpUrl
          ? { transport: "streamable-http", url: options.mcpUrl }
          : { command, args: [] }
      }
    },
    null,
    2
  );

  switch (ide) {
    case "claude-code":
      return {
        ide,
        files: [
          { path: ".mcp.json", content: mcpJson },
          { path: "CLAUDE.md", content: SHORT_INSTRUCTION }
        ]
      };
    case "cursor":
      return {
        ide,
        files: [
          { path: ".cursor/mcp.json", content: mcpJson },
          { path: ".cursor/rules/brain.mdc", content: SHORT_INSTRUCTION }
        ]
      };
    case "kiro":
      return {
        ide,
        files: [
          { path: ".kiro/settings/mcp.json", content: mcpJson },
          { path: ".kiro/steering/brain.md", content: SHORT_INSTRUCTION }
        ]
      };
    case "codex":
      return {
        ide,
        files: [
          { path: ".codex/mcp.json", content: mcpJson },
          { path: "AGENTS.md", content: SHORT_INSTRUCTION }
        ]
      };
    case "antigravity":
      return {
        ide,
        files: [
          { path: ".antigravity/mcp.json", content: mcpJson },
          { path: "AGENTS.md", content: SHORT_INSTRUCTION }
        ]
      };
    case "vscode":
      return {
        ide,
        files: [
          { path: ".vscode/mcp.json", content: mcpJson },
          { path: ".github/copilot-instructions.md", content: SHORT_INSTRUCTION }
        ]
      };
    case "jetbrains":
      return {
        ide,
        files: [
          { path: ".idea/brain-mcp.json", content: mcpJson },
          { path: "AGENTS.md", content: SHORT_INSTRUCTION }
        ]
      };
  }
}

export function installIdeAdapter(
  workspaceRoot: string,
  ide: SupportedIde,
  options: { mcpCommand?: string; mcpUrl?: string } = {}
): string[] {
  const generated = generateAdapterConfig(ide, options);
  const written: string[] = [];
  for (const file of generated.files) {
    const abs = join(workspaceRoot, file.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, "utf8");
    written.push(abs);
  }
  return written;
}

