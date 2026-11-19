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

## 1. Antes de explorar ou editar código
1. **Identifique o projeto automaticamente**: chame \`brain_resolve_workspace_project\` (ou \`brain_list_projects\` se necessário) para obter o \`projectId\` sem depender de IDs manuais.
2. **Busque conhecimento pronto**:
   - \`brain_context_build\` para montar o Context Pack da tarefa.
   - \`brain_search\` / \`brain_get_layered_knowledge\` para consultar arquitetura, regras de negócio, fluxos, código e dados já documentados.
   - \`brain_get_active_rules\` para conhecer invariantes e ADRs que governam o módulo.
   - \`brain_export_topology_diagram\` ou \`brain://projects/{projectId}/topology/{layer}\` para visualizar dependências em Mermaid.
3. **Verifique continuidade e locks**:
   - \`brain_resume_handoff\` para recuperar decisões da sessão anterior.
   - \`brain_check_file_leases\` / \`brain_acquire_lease\` antes de edições concorrentes.

## 2. Durante e antes de concluir mudanças
- \`brain_validate_implementation\` para validar mudanças contra regras e ADRs.
- \`brain_analyze_change_impact\` e \`brain_cross_service_blast_radius\` para medir impacto.
- \`brain_secret_scan\` antes de gravar ou commitar trechos sensíveis.

## 3. Centralização Obrigatória em \`.brain/\` (Sem pasta \`docs/\` e nada fora do projeto)
- **NUNCA crie pasta \`docs/\`** (nem \`doc/\`, nem planos/skills/documentos fora do projeto ou soltos na raiz).
- Tudo que seria colocado em \`docs/\` ou em diretórios externos deve ser centralizado **dentro de \`.brain/\` na raiz do projeto** (\`.brain/00-overview/\`, \`.brain/01-business/\`, \`.brain/02-onboarding/\`, \`.brain/03-architecture/\`, \`.brain/04-engineering/\`, \`.brain/05-flows/\`, \`.brain/06-operations/\`, \`.brain/skills/\`).
- **Ao iniciar um projeto novo**: se \`.project-brain.json\` e \`.brain/\` ainda não existirem na pasta do projeto, crie-os imediatamente (ou chame \`brain_resolve_workspace_project\` com \`createIfMissing: true\`) antes de iniciar a implementação.

## 4. Após concluir a tarefa (manter o Brain vivo)
- \`brain_ingest_git_repo\` se criou/atualizou arquivos em \`.brain/\`.
- \`brain_record_test_result\` ao rodar testes vinculados a regras (\`ruleIds\`).
- \`brain_record_learning\` para registrar descobertas importantes (bugs, armadilhas, decisões).
- \`brain_create_handoff\` ao encerrar uma etapa longa para o próximo agente.
`;

export const BRAIN_MCP_MANAGED_BLOCK = `${BLOCK_START}
## Brain MCP — Uso Obrigatório & Conselheiro de Projeto

Quando o servidor MCP **brain** estiver disponível nesta sessão, **use-o sempre que possível** para economizar tokens, evitar retrabalho e manter o conhecimento atualizado:

1. **Sem pasta \`docs/\` — tudo em \`.brain/\`**: NUNCA crie \`docs/\` nem grave documentação, planos ou skills fora do projeto. Ao iniciar um projeto novo sem \`.brain/\`, crie \`.project-brain.json\` e a pasta \`.brain/\` na raiz do projeto imediatamente.
2. **Início da tarefa**: chame \`brain_resolve_workspace_project\` para detectar (ou criar) o \`projectId\`, depois consulte \`brain_context_build\`, \`brain_get_active_rules\` e \`brain_search\` para aproveitar regras, topologias, contratos e decisões já prontas.
3. **Antes de concluir**: valide contra invariantes com \`brain_validate_implementation\`, avalie impacto com \`brain_analyze_change_impact\` e verifique segredos com \`brain_secret_scan\`.
4. **Ao finalizar**: atualize o Brain com \`brain_ingest_git_repo\` (se alterou \`.brain/\`), \`brain_record_test_result\`, \`brain_record_learning\` e \`brain_create_handoff\`.
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
