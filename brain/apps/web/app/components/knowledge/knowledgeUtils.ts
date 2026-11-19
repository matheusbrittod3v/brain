export type KnowledgeLayer = 'architecture' | 'business' | 'code' | 'product' | 'operations' | 'general'
export type KnowledgeFormat = 'markdown' | 'mermaid' | 'topology' | 'flow' | 'code'

export interface KnowledgeLayerMeta {
  id: KnowledgeLayer
  label: string
  description: string
  icon: string
  color: string
  badgeColor: 'primary' | 'warning' | 'info' | 'success' | 'error' | 'neutral'
}

export const KNOWLEDGE_LAYERS: KnowledgeLayerMeta[] = [
  {
    id: 'architecture',
    label: 'Arquitetura & Topologia',
    description: 'C4, microserviços, mensageria, bancos de dados, redes e ADRs',
    icon: 'i-lucide-network',
    color: '#6366f1',
    badgeColor: 'primary'
  },
  {
    id: 'business',
    label: 'Negócio & Regras',
    description: 'Regras de negócio, fluxos de domínio, SLAs e políticas',
    icon: 'i-lucide-briefcase',
    color: '#f59e0b',
    badgeColor: 'warning'
  },
  {
    id: 'code',
    label: 'Código & Funções',
    description: 'Módulos, funções críticas, contratos API, schemas e testes',
    icon: 'i-lucide-code-2',
    color: '#38bdf8',
    badgeColor: 'info'
  },
  {
    id: 'product',
    label: 'Produto & Specs',
    description: 'Especificações, jornadas UX, requisitos e critérios de aceite',
    icon: 'i-lucide-file-code-2',
    color: '#10b981',
    badgeColor: 'success'
  },
  {
    id: 'operations',
    label: 'Operação & Infra',
    description: 'Runbooks, CI/CD, observabilidade, segurança e incidentes',
    icon: 'i-lucide-server',
    color: '#f43f5e',
    badgeColor: 'error'
  },
  {
    id: 'general',
    label: 'Geral & Notas',
    description: 'Referências textuais, atas, glossários e skills',
    icon: 'i-lucide-file-text',
    color: '#94a3b8',
    badgeColor: 'neutral'
  }
]

export const KNOWLEDGE_FORMAT_OPTIONS: Array<{ value: KnowledgeFormat; label: string; icon: string }> = [
  { value: 'markdown', label: 'Texto / Markdown', icon: 'i-lucide-file-text' },
  { value: 'mermaid', label: 'Diagrama / Fluxo (Mermaid)', icon: 'i-lucide-git-fork' },
  { value: 'topology', label: 'Topologia (Nós & Arestas JSON)', icon: 'i-lucide-network' },
  { value: 'flow', label: 'Fluxo Passo-a-Passo', icon: 'i-lucide-list-ordered' },
  { value: 'code', label: 'Código / Contrato API / Schema', icon: 'i-lucide-braces' }
]

export const FORMAT_TEMPLATES: Record<KnowledgeFormat, string> = {
  markdown: `# Contexto & Objetivo\n\nDescreva o propósito, regras principais e impactos.\n\n## Pontos-Chave\n- Item 1\n- Item 2`,
  mermaid: `\`\`\`mermaid\nflowchart LR\n  Cliente[Cliente Web] -->|HTTP / JWT| Gateway[API Gateway]\n  Gateway -->|RBAC + RLS| Core[Brain Core]\n  Core -->|HNSW + BM25| PG[(PostgreSQL)]\n  Core -->|Filas| Runner[Brain Runner]\n\`\`\``,
  topology: `\`\`\`topology\n{\n  "nodes": [\n    { "id": "web", "label": "Web App", "layer": "product" },\n    { "id": "api", "label": "API Server", "layer": "architecture" },\n    { "id": "db", "label": "PostgreSQL + pgvector", "layer": "code" },\n    { "id": "runner", "label": "Agent Runner", "layer": "operations" }\n  ],\n  "edges": [\n    { "from": "web", "to": "api", "label": "REST / SSE" },\n    { "from": "api", "to": "db", "label": "RLS + HNSW" },\n    { "from": "api", "to": "runner", "label": "Filas" }\n  ]\n}\n\`\`\``,
  flow: `1. Usuário envia requisição autenticada -> API valida JWT e escopo\n2. Guard CASL verifica permissão granular -> RLS isola tenant/projeto\n3. Motor híbrido busca contexto -> Agente executa em draft-only`,
  code: `\`\`\`typescript\nexport interface KnowledgeContract {\n  id: string\n  layer: 'architecture' | 'business' | 'code' | 'product' | 'operations'\n  qualityScore: number\n}\n\`\`\``
}

export function inferKnowledgeLayer(item: { type: string; tags?: string[] }): KnowledgeLayer {
  const tags = item.tags ?? []
  const tagged = tags.find(t => t.startsWith('layer:'))
  if (tagged) {
    const val = tagged.slice(6) as KnowledgeLayer
    if (KNOWLEDGE_LAYERS.some(l => l.id === val)) return val
  }
  const t = item.type.toLowerCase()
  if (['architecture_decision', 'diagram', 'topology', 'system_architecture', 'pending_decision', 'compatibility_matrix'].includes(t)) return 'architecture'
  if (['business_rule', 'domain_flow', 'glossary_term', 'acceptance_criteria'].includes(t)) return 'business'
  if (['code_symbol', 'api_contract', 'schema', 'test', 'data_model', 'implementation_pattern', 'code_vocabulary', 'mock_data_sample'].includes(t)) return 'code'
  if (['spec', 'requirement', 'ux_flow', 'product_capability', 'use_case', 'journey', 'limit_constraint'].includes(t)) return 'product'
  if (['runbook', 'pipeline', 'security_policy', 'risk_control', 'slo_target', 'incident_postmortem', 'role_responsibility', 'experiment_record', 'known_exception', 'external_dependency'].includes(t)) return 'operations'
  return 'general'
}

export function inferKnowledgeFormat(item: { content: string; tags?: string[] }): KnowledgeFormat {
  const tags = item.tags ?? []
  const tagged = tags.find(t => t.startsWith('format:'))
  if (tagged) {
    const val = tagged.slice(7) as KnowledgeFormat
    if (KNOWLEDGE_FORMAT_OPTIONS.some(f => f.value === val)) return val
  }
  const c = item.content || ''
  if (/```topology/i.test(c) || (/"nodes"\s*:/.test(c) && /"edges"\s*:/.test(c))) return 'topology'
  if (/```mermaid/i.test(c) || /^\s*(graph|flowchart|sequenceDiagram|classDiagram|erDiagram|stateDiagram)/m.test(c)) return 'mermaid'
  if (/```(ts|typescript|js|sql|json|yaml|py|go)/i.test(c)) return 'code'
  if (/^\s*\d+\.\s+.+/m.test(c) && /->|=>|→/.test(c)) return 'flow'
  return 'markdown'
}

export function computeKnowledgeQuality(item: { title: string; content: string; status: string; tags?: string[]; type: string }): {
  score: number
  grade: 'A' | 'B' | 'C' | 'D'
  suggestions: string[]
} {
  let score = 0
  const suggestions: string[] = []
  const content = item.content || ''

  if (item.title.trim().length >= 5 && content.trim().length >= 100) {
    score += 25
  } else if (content.trim().length >= 30) {
    score += 12
    suggestions.push('Detalhe mais o conteúdo (mín. 100 caracteres)')
  } else {
    suggestions.push('Conteúdo muito curto')
  }

  const tags = item.tags ?? []
  if (tags.some(t => t.startsWith('layer:')) || item.type !== 'document') score += 10
  else suggestions.push('Defina uma camada (Arquitetura, Negócio, Código...)')

  if (tags.some(t => t.startsWith('format:')) || /```/.test(content)) score += 10

  const hasDiagram = /```(mermaid|topology)/i.test(content) || /^\s*(graph|flowchart|sequenceDiagram)/m.test(content)
  if (hasDiagram || /^#{1,3}\s+/m.test(content)) {
    score += 25
  } else {
    suggestions.push('Adicione cabeçalhos ou um diagrama Mermaid/Topologia')
  }

  if (tags.length >= 2) score += 15
  else if (tags.length === 1) {
    score += 8
    suggestions.push('Adicione mais tags semânticas')
  } else {
    suggestions.push('Adicione tags para melhorar a busca')
  }

  if (item.status === 'approved') score += 15
  else suggestions.push('Aprovar oficialmente para elevar governança')

  const bounded = Math.min(100, score)
  const grade = bounded >= 85 ? 'A' : bounded >= 65 ? 'B' : bounded >= 40 ? 'C' : 'D'
  return { score: bounded, grade, suggestions }
}

export interface ParsedGraphData {
  nodes: Array<{ id: string; label: string; layer?: string }>
  edges: Array<{ from: string; to: string; label?: string }>
}

export function parseVisualGraphFromContent(content: string): ParsedGraphData | null {
  // 1. Topology JSON block
  const topoMatch = /```topology\s*\n([\s\S]*?)```/i.exec(content)
  const rawJson = topoMatch ? topoMatch[1] : (/"nodes"\s*:/.test(content) && /"edges"\s*:/.test(content) ? content : null)
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson.trim()) as {
        nodes?: Array<{ id: string; label?: string; name?: string; layer?: string }>
        edges?: Array<{ from?: string; source?: string; to?: string; target?: string; label?: string; relation?: string }>
      }
      if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
        return {
          nodes: parsed.nodes.map(n => ({ id: String(n.id), label: String(n.label || n.name || n.id), layer: n.layer })),
          edges: (parsed.edges ?? [])
            .map(e => ({ from: String(e.from || e.source || ''), to: String(e.to || e.target || ''), label: e.label || e.relation }))
            .filter(e => e.from && e.to)
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  // 2. Mermaid flowchart / graph / sequenceDiagram parser
  const mermaidMatch = /```mermaid\s*\n([\s\S]*?)```/i.exec(content)
  const mermaidSrc = mermaidMatch
    ? mermaidMatch[1]!
    : /^\s*(graph|flowchart|sequenceDiagram|classDiagram|erDiagram)\b/m.test(content)
      ? content
      : null
  if (!mermaidSrc) return null

  const nodeMap = new Map<string, { id: string; label: string }>()
  const edges: Array<{ from: string; to: string; label?: string }> = []

  const cleanNodeToken = (raw: string): { id: string; label: string } => {
    const trimmed = raw.trim()
    const bracketMatch = /^([A-Za-z0-9_-]+)\s*(?:\[\(?([^\])]+)\)?\]|\(([^)]+)\)|\{([^}]+)\})/.exec(trimmed)
    if (bracketMatch) {
      const id = bracketMatch[1]!
      const label = (bracketMatch[2] || bracketMatch[3] || bracketMatch[4] || id).trim()
      return { id, label }
    }
    const id = trimmed.replace(/[^A-Za-z0-9_-]/g, '') || trimmed
    return { id, label: trimmed }
  }

  for (const line of mermaidSrc.split(/\r?\n/)) {
    const l = line.trim()
    if (!l || l.startsWith('%%') || /^(graph|flowchart|sequenceDiagram|classDiagram|erDiagram|subgraph|end)\b/i.test(l)) {
      continue
    }
    const arrowMatch = /^(.+?)\s*(?:--+>|==+>|-\.+->|->>|-->>)\s*(?:\|([^|]+)\|)?\s*(.+?)(?::\s*(.+))?$/.exec(l)
    if (arrowMatch) {
      const left = cleanNodeToken(arrowMatch[1]!)
      const right = cleanNodeToken(arrowMatch[3]!)
      const edgeLabel = (arrowMatch[2] || arrowMatch[4] || '').trim() || undefined
      if (!nodeMap.has(left.id)) nodeMap.set(left.id, left)
      if (!nodeMap.has(right.id)) nodeMap.set(right.id, right)
      edges.push({ from: left.id, to: right.id, label: edgeLabel })
    }
  }

  if (nodeMap.size === 0) return null
  return { nodes: [...nodeMap.values()], edges }
}

export interface KnowledgeItemRow {
  id: string
  projectId?: string
  title: string
  type: string
  status: string
  accessPolicyId: string
  content: string
  summary?: string
  version?: number
  tags?: string[]
  updatedAt?: string
  scope?: 'project' | 'org'
}

export function qualityColor(score: number): 'success' | 'warning' | 'error' {
  if (score >= 80) return 'success'
  if (score >= 55) return 'warning'
  return 'error'
}

