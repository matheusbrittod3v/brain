import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const BLOCK_START = "<!-- BRAIN:MCP:START -->";
const BLOCK_END = "<!-- BRAIN:MCP:END -->";

export const BRAIN_MCP_SKILL_CONTENT = `---
name: brain-mcp-advisor
description: >-
  Orienta agentes (Codex, Claude, Cursor, Antigravity) a sempre consultar e
  atualizar o MCP Brain antes e depois de tarefas no projeto, reutilizando
  regras, topologias, contratos, memórias e decisões já prontas.
---

# Brain MCP Advisor

Sempre que o servidor MCP **Brain** estiver conectado, use-o proativamente como fonte primária de contexto e memória do projeto:

## 1. Centralização Obrigatória em \`.brain/\` (Sem pasta \`docs/\` e Workspace Universal)
- **NUNCA crie pasta \`docs/\`** (nem \`doc/\`, nem planos/skills/documentos fora do projeto ou soltos na raiz).
- Centralize **100% do conhecimento dentro de \`.brain/\`** na raiz do projeto (\`knowledgeRoot: ".brain/"\`).
- **Aceita todos os setores e formatos**: além de \`00-overview/\`..\`06-operations/\`, \`skills/\`, \`specs/\` e \`tests/\`, organize qualquer setor/domínio (\`marketing/\`, \`produto/\`, \`design/\`, \`dados/\`, \`juridico/\`, \`financeiro/\`, \`clientes/\`, \`infra/\`, \`pesquisa/\`) usando qualquer formato textual/estruturado (\`.md\`, \`.yaml\`, \`.yml\`, \`.json\`, \`.txt\`, \`.csv\`, \`.mmd\`/\`.mermaid\`, \`.sql\`, \`.toml\`, \`.html\`, \`.rst\`, \`.graphql\`, \`.proto\`).
- **Projeto novo**: ao iniciar qualquer projeto sem \`.project-brain.json\` e \`.brain/\`, crie ambos imediatamente na raiz do projeto e chame \`brain_resolve_workspace_project({ workspacePath, createIfMissing: true })\`.

## 2. Casos de Uso & Fluxo 360° (Com Exemplos de Tools)
1. **Descoberta & Contexto (antes de codar)**:
   - \`brain_resolve_workspace_project({ workspacePath })\` -> \`brain_context_build({ projectId, task })\`
   - \`brain_get_active_rules({ projectId })\`, \`brain_search({ projectId, query })\`, \`brain_memory_recall({ projectId, query })\`, \`brain_list_skills({ projectId })\`
   - Para bases globais (\`isShared=true\`): \`brain_list_shared_projects()\` e consulte pelo \`projectId\` global ou \`includeShared: true\` em \`brain_search\`.
   - Resources MCP: \`brain://projects/{projectId}/overview\`, \`brain://projects/{projectId}/rules\`, \`brain://projects/{projectId}/topology/{layer}\`.
2. **Arquitetura, Segurança & Impacto (durante mudanças)**:
   - \`brain_analyze_change_impact\`, \`brain_cross_service_blast_radius\`, \`brain_contradiction_detect\`, \`brain_validate_implementation\`.
   - \`brain_export_topology_diagram\` (Mermaid), \`brain_secret_scan\`, \`brain_check_file_leases\` / \`brain_acquire_lease\`.
3. **Governança, QA & Continuidade (ao finalizar)**:
   - \`brain_ingest_git_repo\` ou \`brain_ingest_document\` sempre que criar/alterar arquivos em \`.brain/\`.
   - \`brain_graph_relate\` para conectar arestas (\`VERIFIED_BY\`, \`IMPLEMENTS\`, \`GOVERNED_BY\`, \`DEPENDS_ON\`).
   - \`brain_record_test_result\` ao validar regras (\`BR-*\`), \`brain_record_learning\` para lições aprendidas e \`brain_create_handoff\` / \`brain_resume_handoff\` entre sessões.
`;

export const BRAIN_MCP_MANAGED_BLOCK = `${BLOCK_START}
## Brain MCP — Guia 360° Obrigatório

Quando o servidor MCP **brain** estiver disponível nesta sessão, **use-o proativamente**:

1. **Sem \`docs/\` — tudo em \`.brain/\` (multi-setor e multi-formato)**: NUNCA crie \`docs/\` nem grave documentos/skills fora do projeto. Use \`.brain/\` como workspace universal (\`.md\`, \`.yaml\`, \`.json\`, \`.txt\`, \`.csv\`, \`.mmd\`, \`.sql\`, etc.) para qualquer setor (engenharia, produto, marketing, design, dados, jurídico, infra). Em projeto novo, crie \`.project-brain.json\` e \`.brain/\` imediatamente.
2. **Antes de agir**: \`brain_resolve_workspace_project\` -> \`brain_context_build\`, \`brain_get_active_rules\`, \`brain_search\`, \`brain_memory_recall\`, \`brain_list_skills\` (e \`brain_list_shared_projects\` para consultar projetos globais \`isShared\`).
3. **Durante e antes de concluir**: \`brain_validate_implementation\`, \`brain_analyze_change_impact\`, \`brain_cross_service_blast_radius\`, \`brain_secret_scan\`.
4. **Ao finalizar**: \`brain_ingest_git_repo\` (se alterou \`.brain/\`), \`brain_graph_relate\`, \`brain_record_test_result\`, \`brain_record_learning\` e \`brain_create_handoff\`.
${BLOCK_END}`;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function upsertManagedMarkdown(filePath: string, heading: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(filePath, "utf8");
  } catch {
    existing = `${heading}\n\n`;
  }

  const startIdx = existing.indexOf(BLOCK_START);
  const endIdx = existing.indexOf(BLOCK_END);
  let next: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    next = `${existing.slice(0, startIdx)}${BRAIN_MCP_MANAGED_BLOCK}${existing.slice(endIdx + BLOCK_END.length)}`;
  } else {
    const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    next = `${existing}${sep}${BRAIN_MCP_MANAGED_BLOCK}\n`;
  }
  await writeFile(filePath, next, "utf8");
}

async function writeSkillFile(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, BRAIN_MCP_SKILL_CONTENT, "utf8");
}

export interface InstallAgentInstructionsResult {
  writtenFiles: string[];
}

/**
 * Installs the `brain-mcp-advisor` skill and updates agent instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Cursor rules)
 * so Codex, Claude Code, Cursor, and Antigravity automatically consult and update Brain via MCP.
 */
export async function installBrainAgentInstructions(options: {
  workspacePath?: string;
  includeGlobal?: boolean;
}): Promise<InstallAgentInstructionsResult> {
  const writtenFiles: string[] = [];
  const home = homedir();

  if (options.includeGlobal !== false) {
    const globalSkill = join(home, ".agents", "skills", "brain-mcp-advisor", "SKILL.md");
    await writeSkillFile(globalSkill);
    writtenFiles.push(globalSkill);

    if (await pathExists(join(home, ".codex"))) {
      const codexAgents = join(home, ".codex", "AGENTS.md");
      await upsertManagedMarkdown(codexAgents, "# Codex Global Agent Instructions");
      writtenFiles.push(codexAgents);
    }

    if (await pathExists(join(home, ".claude"))) {
      const claudeMd = join(home, ".claude", "CLAUDE.md");
      await upsertManagedMarkdown(claudeMd, "# Claude Code Global Instructions");
      writtenFiles.push(claudeMd);

      const claudeSkill = join(home, ".claude", "skills", "brain-mcp-advisor", "SKILL.md");
      await writeSkillFile(claudeSkill);
      writtenFiles.push(claudeSkill);
    }

    if (await pathExists(join(home, ".gemini", "config"))) {
      const geminiSkill = join(home, ".gemini", "config", "skills", "brain-mcp-advisor", "SKILL.md");
      await writeSkillFile(geminiSkill);
      writtenFiles.push(geminiSkill);
    }
  }

  if (options.workspacePath?.trim()) {
    const ws = options.workspacePath.trim();
    const wsSkill = join(ws, ".agents", "skills", "brain-mcp-advisor", "SKILL.md");
    await writeSkillFile(wsSkill);
    writtenFiles.push(wsSkill);

    const agentsMd = join(ws, "AGENTS.md");
    await upsertManagedMarkdown(agentsMd, "# Agent Instructions");
    writtenFiles.push(agentsMd);

    const claudeWsMd = join(ws, "CLAUDE.md");
    await upsertManagedMarkdown(claudeWsMd, "# Claude Code Project Instructions");
    writtenFiles.push(claudeWsMd);

    const cursorRule = join(ws, ".cursor", "rules", "brain-mcp.mdc");
    await mkdir(dirname(cursorRule), { recursive: true });
    await writeFile(
      cursorRule,
      `---\ndescription: Sempre consultar e atualizar o MCP Brain antes e depois de alterações.\nalwaysApply: true\n---\n\n${BRAIN_MCP_MANAGED_BLOCK}\n`,
      "utf8"
    );
    writtenFiles.push(cursorRule);
  }

  return { writtenFiles };
}
