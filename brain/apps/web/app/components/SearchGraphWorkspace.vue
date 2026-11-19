<script setup lang="ts">
import type * as echarts from 'echarts'
import IntentSearchModal from './daily/IntentSearchModal.vue'
import Search3DGraph, { type GraphNodeItem } from './Search3DGraph.vue'

const { projectId, apiFetch, notify, liveSyncTick } = useBrainApi()

const emit = defineEmits<{
  inspect: [item: { title: string; content: string; type?: string; status?: string }]
}>()

type GraphViewMode = '3d_orbit' | '2d_force' | '2d_circular' | 'hierarchy_dag' | 'matrix' | 'mermaid'

const query = ref('')
const rootId = ref('')
const relationFilter = ref<'all' | 'VERIFIED_BY' | 'IMPACTS' | 'DEPENDS_ON'>('all')
const typeFilter = ref('all')
const graphViewMode = ref<GraphViewMode>('3d_orbit')
const showEdgeLabels = ref(false)
const expandedGraph = ref(false)
const loading = ref(false)
const intentModalOpen = ref(false)
const mermaidCopied = ref(false)

interface SearchExplain {
  lexicalScore: number
  vectorScore: number
  rrfScore: number
  graphProximity: number
  authorityWeight: number
  recencyDecay: number
  matchReasons: Array<'textual' | 'semantic' | 'graph'>
}

interface SearchItem {
  id: string
  title: string
  type: string
  status: string
  content: string
  accessPolicyId?: string
  score?: number
  sharedFromProjectId?: string
  explain?: SearchExplain
}

interface BenchmarkSummary {
  totalQuestions: number
  hitRateAt1: number
  meanRecallAt5: number
  mrr: number
  avgLatencyMs: number
}

const searchHits = ref<SearchItem[]>([])
const graphNodes = ref<Array<{ id: string; title?: string; type?: string; status?: string; content?: string }>>([])
const graphEdges = ref<Array<{ from: string; to: string; relation: string }>>([])
const evaluatingBenchmark = ref(false)
const benchmarkSummary = ref<BenchmarkSummary | null>(null)
const staleItemsCount = ref(0)
const untestedRulesCount = ref(0)
const isDependencyMapMode = ref(false)

async function loadDependencyMap() {
  if (!projectId.value) return
  loading.value = true
  try {
    const res = await apiFetch<{
      nodes: Array<{ id: string; label: string; type: string; category: string }>
      edges: Array<{ from: string; to: string; relation: string }>
    }>(`/v1/projects/${encodeURIComponent(projectId.value)}/intelligence/dependency-map`)
    graphNodes.value = res.nodes.map(n => ({ id: n.id, title: n.label, type: n.type }))
    graphEdges.value = res.edges
    isDependencyMapMode.value = true
    notify('Mapa de Dependências Navegável', `${res.nodes.length} nós e ${res.edges.length} conexões`, 'success')
  } catch (err) {
    notify('Erro ao carregar dependências', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}

async function runBenchmarkEvaluation() {
  if (!projectId.value) return
  evaluatingBenchmark.value = true
  const pid = encodeURIComponent(projectId.value)
  try {
    const [bRes, eRes] = await Promise.all([
      apiFetch<{ staleItems?: unknown[]; untestedRules?: unknown[] }>(`/v1/projects/${pid}/search/benchmark`),
      apiFetch<{ summary: BenchmarkSummary }>(`/v1/projects/${pid}/search/evaluate`, { method: 'POST' })
    ])
    staleItemsCount.value = bRes.staleItems?.length ?? 0
    untestedRulesCount.value = bRes.untestedRules?.length ?? 0
    benchmarkSummary.value = eRes.summary
    notify('Benchmark de Busca Concluído', `Hit@1: ${Math.round(eRes.summary.hitRateAt1 * 100)}% • Recall@5: ${Math.round(eRes.summary.meanRecallAt5 * 100)}% • MRR: ${eRes.summary.mrr}`, 'success')
  } catch (err) {
    notify('Erro no benchmark', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    evaluatingBenchmark.value = false
  }
}

async function runSearchAndGraph() {
  if (!projectId.value) {
    searchHits.value = []
    graphNodes.value = []
    graphEdges.value = []
    return
  }
  loading.value = true
  const pid = encodeURIComponent(projectId.value)
  try {
    const [sRes, gRes] = await Promise.all([
      apiFetch<{ items?: SearchItem[] }>(`/v1/projects/${pid}/search`, {
        method: 'POST',
        body: JSON.stringify({ query: query.value.trim(), limit: 30 })
      }),
      apiFetch<{ nodes?: typeof graphNodes.value; edges?: typeof graphEdges.value }>(
        `/v1/projects/${pid}/graph${rootId.value ? `?rootId=${encodeURIComponent(rootId.value)}` : ''}`
      )
    ])
    searchHits.value = sRes.items ?? []
    graphNodes.value = gRes.nodes ?? []
    graphEdges.value = gRes.edges ?? []
  } catch (err) {
    notify('Erro na busca/grafo', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}

onMounted(runSearchAndGraph)
watch([projectId, liveSyncTick], runSearchAndGraph)

const relationOptions = [
  { label: 'Todas as relações', value: 'all' },
  { label: 'VERIFIED_BY', value: 'VERIFIED_BY' },
  { label: 'IMPACTS', value: 'IMPACTS' },
  { label: 'DEPENDS_ON', value: 'DEPENDS_ON' }
]

const typeOptions = computed(() => {
  const types = [...new Set([
    ...graphNodes.value.map(n => n.type).filter((t): t is string => Boolean(t)),
    ...searchHits.value.map(h => h.type).filter(Boolean)
  ])]
  return [
    { label: 'Todos os tipos', value: 'all' },
    ...types.map(t => ({ label: t, value: t }))
  ]
})

const filteredNodes = computed(() => {
  if (typeFilter.value === 'all') return graphNodes.value
  return graphNodes.value.filter(n => n.type === typeFilter.value || n.id === rootId.value)
})

const filteredSearchHits = computed(() => {
  if (typeFilter.value === 'all') return searchHits.value
  return searchHits.value.filter(h => h.type === typeFilter.value)
})

const filteredEdges = computed(() => {
  if (relationFilter.value === 'all') return graphEdges.value
  return graphEdges.value.filter(e => e.relation === relationFilter.value)
})

const nodeFocusItems = computed(() => [
  { label: 'Visão completa (sem foco)', value: '' },
  ...graphNodes.value.slice(0, 50).map(n => ({
    label: n.title ? `${n.id} — ${n.title.slice(0, 28)}` : n.id,
    value: n.id
  }))
])

const viewModeOptions = [
  { value: '3d_orbit', label: '3D Órbita', icon: 'i-lucide-box' },
  { value: '2d_force', label: '2D Físico', icon: 'i-lucide-sparkles' },
  { value: '2d_circular', label: '2D Radial', icon: 'i-lucide-circle-dashed' },
  { value: 'hierarchy_dag', label: 'Hierarquia DAG', icon: 'i-lucide-git-merge' },
  { value: 'matrix', label: 'Matriz', icon: 'i-lucide-grid' },
  { value: 'mermaid', label: 'Mermaid', icon: 'i-lucide-code-2' }
]

function handleNodeSelect(node: GraphNodeItem) {
  rootId.value = node.id
  const matchingHit = searchHits.value.find(h => h.id === node.id)
  emit('inspect', {
    title: node.title || node.id,
    content: matchingHit?.content || `ID: ${node.id}\nTipo: ${node.type || 'Nó'}\nStatus: ${node.status || 'ativo'}`,
    type: node.type,
    status: node.status
  })
}

// 2D ECharts Option Builder
function build2DGraphOption(layout: 'force' | 'circular' | 'none') {
  const degreeMap = new Map<string, number>()
  for (const e of filteredEdges.value) {
    degreeMap.set(e.from, (degreeMap.get(e.from) ?? 0) + 1)
    degreeMap.set(e.to, (degreeMap.get(e.to) ?? 0) + 1)
  }

  const nodes = filteredNodes.value.slice(0, 75).map((n, i) => {
    const deg = degreeMap.get(n.id) ?? 0
    const isRoot = n.id === rootId.value
    const level = isRoot ? 0 : 1 + (i % 4)
    return {
      id: n.id,
      name: n.title ? `${n.id}: ${n.title.slice(0, 20)}` : n.id,
      value: deg,
      x: layout === 'none' ? 80 + level * 210 : undefined,
      y: layout === 'none' ? 60 + (i % 6) * 65 : undefined,
      symbolSize: isRoot ? 32 : Math.min(28, 16 + deg * 2.2),
      itemStyle: {
        color: isRoot ? '#38bdf8' : n.status === 'approved' ? '#10b981' : n.status === 'draft' ? '#f59e0b' : '#6366f1',
        borderColor: isRoot ? '#e0f2fe' : '#0f172a',
        borderWidth: isRoot ? 3 : 1.5
      }
    }
  })

  const nodeIds = new Set(nodes.map(n => n.id))
  const links = filteredEdges.value.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to)).map(e => ({
    source: e.from,
    target: e.to,
    lineStyle: {
      color: e.relation === 'VERIFIED_BY' ? '#10b981' : e.relation === 'IMPACTS' ? '#f59e0b' : '#818cf8',
      width: 1.8,
      opacity: 0.75,
      curveness: layout === 'circular' ? 0.28 : layout === 'none' ? 0.15 : 0.16
    },
    label: { show: showEdgeLabels.value, formatter: e.relation, fontSize: 9, color: '#94a3b8' }
  }))

  return {
    tooltip: { trigger: 'item' },
    series: [{
      type: 'graph',
      layout,
      roam: true,
      draggable: layout !== 'none',
      circular: { rotateLabel: true },
      force: { repulsion: 300, gravity: 0.08, edgeLength: [80, 150] },
      emphasis: { focus: 'adjacency', lineStyle: { width: 3.2, opacity: 1 } },
      label: { show: true, position: 'bottom', color: '#cbd5e1', fontSize: 10, distance: 4 },
      edgeSymbol: ['none', 'arrow'],
      edgeSymbolSize: [4, 8],
      data: nodes,
      links
    }]
  } as echarts.EChartsOption
}

const forceOption = computed(() => build2DGraphOption('force'))
const circularOption = computed(() => build2DGraphOption('circular'))
const dagOption = computed(() => build2DGraphOption('none'))

// Adjacency Matrix Data
const matrixTypes = computed(() => {
  const types = [...new Set(filteredNodes.value.map(n => n.type || 'geral'))].slice(0, 6)
  const matrix: number[][] = types.map(() => types.map(() => 0))
  const nodeTypeMap = new Map(filteredNodes.value.map(n => [n.id, n.type || 'geral']))

  for (const e of filteredEdges.value) {
    const srcType = nodeTypeMap.get(e.from)
    const tgtType = nodeTypeMap.get(e.to)
    if (srcType && tgtType) {
      const sIdx = types.indexOf(srcType)
      const tIdx = types.indexOf(tgtType)
      if (sIdx >= 0 && tIdx >= 0) {
        matrix[sIdx]![tIdx]! += 1
      }
    }
  }

  return { types, matrix }
})

// Mermaid live generator
const generatedMermaid = computed(() => {
  const lines: string[] = ['flowchart LR']
  const nodes = filteredNodes.value.slice(0, 30)
  for (const n of nodes) {
    const sId = n.id.replace(/[^A-Za-z0-9]/g, '_')
    const sTitle = (n.title || n.id).replace(/["\[\]]/g, '')
    lines.push(`  ${sId}["${sTitle}"]`)
  }
  const nodeIds = new Set(nodes.map(n => n.id))
  for (const e of filteredEdges.value.slice(0, 35)) {
    if (nodeIds.has(e.from) && nodeIds.has(e.to)) {
      const sFrom = e.from.replace(/[^A-Za-z0-9]/g, '_')
      const sTo = e.to.replace(/[^A-Za-z0-9]/g, '_')
      lines.push(`  ${sFrom} -->|${e.relation}| ${sTo}`)
    }
  }
  return lines.join('\n')
})

function copyMermaid() {
  navigator.clipboard.writeText(generatedMermaid.value)
  mermaidCopied.value = true
  setTimeout(() => { mermaidCopied.value = false }, 2000)
}

function exportGraphJson() {
  const payload = {
    projectId: projectId.value,
    exportedAt: new Date().toISOString(),
    nodesCount: filteredNodes.value.length,
    edgesCount: filteredEdges.value.length,
    nodes: filteredNodes.value,
    edges: filteredEdges.value
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `brain-graph-${projectId.value || 'all'}.json`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="space-y-5">
    <UiPageHeader
      title="Busca Híbrida &amp; Grafo de Conhecimento"
      description="Combina busca vetorial HNSW, BM25 e navegação de relações em 2D e 3D interativo"
      icon="i-lucide-network"
    >
      <template #actions>
        <UInput
          v-model="query"
          placeholder="Buscar regras, ADRs, código..."
          icon="i-lucide-search"
          size="sm"
          class="w-56"
          @keyup.enter="runSearchAndGraph"
        />
        <USelect
          v-model="typeFilter"
          :items="typeOptions"
          size="sm"
          class="w-36"
        />
        <USelect
          v-model="relationFilter"
          :items="relationOptions"
          size="sm"
          class="w-40"
        />
        <UButton size="sm" variant="soft" color="warning" icon="i-lucide-sparkles" @click="intentModalOpen = true">
          Por Intenção / Exemplos
        </UButton>
        <UButton size="sm" variant="soft" color="primary" icon="i-lucide-share-2" @click="loadDependencyMap">
          Mapa de Dependências
        </UButton>
        <UButton size="sm" :loading="loading" icon="i-lucide-refresh-cw" @click="runSearchAndGraph">
          Atualizar
        </UButton>
      </template>
    </UiPageHeader>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <UiStatCard label="Nós Visíveis" :value="filteredNodes.length" icon="i-lucide-circle-dot" tone="primary" />
      <UiStatCard label="Arestas Filtradas" :value="filteredEdges.length" icon="i-lucide-git-branch" tone="info" />
      <UiStatCard label="Resultados da Busca" :value="filteredSearchHits.length" icon="i-lucide-search-check" tone="success" />
    </div>

    <!-- Topologia Multi-Visualizador (2D / 3D / DAG / Matriz / Mermaid) -->
    <UCard :ui="{ body: 'p-0 sm:p-0' }">
      <template #header>
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold text-sm">Topologia de Conhecimento</span>
            <UBadge v-if="rootId" color="info" variant="subtle" size="xs" class="font-mono">
              Foco: {{ rootId }}
            </UBadge>
            <div class="hidden sm:flex items-center gap-2.5 text-[11px] text-muted ml-2">
              <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-400" /> Aprovado</span>
              <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-amber-400" /> Rascunho</span>
              <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-indigo-400" /> Outro</span>
              <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-sky-400" /> Foco</span>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <!-- Focus Select -->
            <USelect
              v-model="rootId"
              :items="nodeFocusItems"
              size="xs"
              class="w-44 font-mono"
              @update:model-value="runSearchAndGraph"
            />

            <!-- View Modes -->
            <div class="flex items-center bg-elevated rounded-lg p-0.5 border border-default">
              <button
                v-for="mode in viewModeOptions"
                :key="mode.value"
                type="button"
                class="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-all"
                :class="graphViewMode === mode.value ? 'bg-primary text-white shadow-xs' : 'text-muted hover:text-highlighted'"
                :title="mode.label"
                @click="graphViewMode = mode.value as GraphViewMode"
              >
                <UIcon :name="mode.icon" class="size-3.5" />
                <span class="hidden md:inline">{{ mode.label }}</span>
              </button>
            </div>

            <!-- Labels Toggle -->
            <UButton
              size="xs"
              :variant="showEdgeLabels ? 'soft' : 'outline'"
              :color="showEdgeLabels ? 'primary' : 'neutral'"
              icon="i-lucide-tag"
              title="Mostrar rótulos das relações"
              @click="showEdgeLabels = !showEdgeLabels"
            >
              Rótulos
            </UButton>

            <!-- Export Actions -->
            <UButton
              size="xs"
              variant="outline"
              icon="i-lucide-download"
              title="Baixar JSON do Grafo"
              @click="exportGraphJson"
            >
              JSON
            </UButton>
            <UButton
              size="xs"
              variant="outline"
              :icon="mermaidCopied ? 'i-lucide-check' : 'i-lucide-copy'"
              :color="mermaidCopied ? 'success' : 'neutral'"
              title="Copiar Mermaid"
              @click="copyMermaid"
            >
              {{ mermaidCopied ? 'Copiado!' : 'Mermaid' }}
            </UButton>

            <!-- Expand Height -->
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              :icon="expandedGraph ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'"
              :title="expandedGraph ? 'Reduzir altura' : 'Expandir grafo'"
              @click="expandedGraph = !expandedGraph"
            />
          </div>
        </div>
      </template>

      <UiEmptyState
        v-if="filteredNodes.length === 0"
        icon="i-lucide-network"
        title="Nenhum nó indexado no grafo"
        description="Ingira regras de negócio, ADRs ou código-fonte neste projeto para visualizar a topologia."
      />
      <div v-else class="relative bg-slate-950/85 min-h-[420px] rounded-b-xl overflow-hidden">
        <!-- 1. 3D Orbit View -->
        <div v-if="graphViewMode === '3d_orbit'">
          <Search3DGraph
            :nodes="filteredNodes"
            :edges="filteredEdges"
            :root-id="rootId"
            @select-node="handleNodeSelect"
          />
        </div>

        <!-- 2. 2D Force View -->
        <div v-else-if="graphViewMode === '2d_force'" class="p-3">
          <EChartBox :option="forceOption" :height="expandedGraph ? '540px' : '420px'" />
        </div>

        <!-- 3. 2D Circular View -->
        <div v-else-if="graphViewMode === '2d_circular'" class="p-3">
          <EChartBox :option="circularOption" :height="expandedGraph ? '540px' : '420px'" />
        </div>

        <!-- 4. Directed DAG / Hierarchy View -->
        <div v-else-if="graphViewMode === 'hierarchy_dag'" class="p-3">
          <EChartBox :option="dagOption" :height="expandedGraph ? '540px' : '420px'" />
        </div>

        <!-- 5. Adjacency Matrix View -->
        <div v-else-if="graphViewMode === 'matrix'" class="p-6 max-w-2xl mx-auto space-y-3">
          <div class="text-center space-y-1">
            <h4 class="font-semibold text-sm text-highlighted">Matriz de Conexão entre Tipos de Nós</h4>
            <p class="text-xs text-muted">Intensidade de relacionamentos entre regras, ADRs, código e specs.</p>
          </div>
          <div class="overflow-x-auto rounded-xl border border-default bg-slate-900/60 p-4">
            <table class="w-full text-xs text-left border-collapse">
              <thead>
                <tr class="border-b border-default text-muted">
                  <th class="p-2 font-medium">Origem \ Destino</th>
                  <th v-for="t in matrixTypes.types" :key="t" class="p-2 font-medium text-center font-mono">
                    {{ t }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rIdx) in matrixTypes.types" :key="row" class="border-b border-default/50 hover:bg-slate-800/40">
                  <td class="p-2 font-medium font-mono text-sky-400">{{ row }}</td>
                  <td v-for="(col, cIdx) in matrixTypes.types" :key="col" class="p-2 text-center font-mono font-bold">
                    <span
                      class="inline-block px-2 py-0.5 rounded text-xs"
                      :class="matrixTypes.matrix[rIdx]![cIdx]! > 0 ? 'bg-primary/20 text-primary-light border border-primary/30' : 'text-slate-600'"
                    >
                      {{ matrixTypes.matrix[rIdx]![cIdx] }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 6. Mermaid Code View -->
        <div v-else-if="graphViewMode === 'mermaid'" class="p-5 space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-xs text-muted">Código Mermaid do grafo ativo</span>
            <UButton size="xs" variant="solid" color="primary" :icon="mermaidCopied ? 'i-lucide-check' : 'i-lucide-copy'" @click="copyMermaid">
              {{ mermaidCopied ? 'Copiado!' : 'Copiar Mermaid' }}
            </UButton>
          </div>
          <pre class="p-4 rounded-xl bg-slate-900 border border-slate-800 text-slate-300 font-mono text-xs overflow-x-auto max-h-[420px] select-all"><code>{{ generatedMermaid }}</code></pre>
        </div>
      </div>
    </UCard>

    <!-- Resultados da Busca Híbrida -->
    <UCard>
      <template #header>
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 class="font-semibold text-sm">Resultados da Busca Híbrida &amp; Explicabilidade</h3>
            <p class="text-xs text-muted">Veja por que cada resultado apareceu (BM25 Textual, Vetorial bge-m3 ou Grafo) e avalie a precisão com o Benchmark de Referência.</p>
          </div>
          <div class="flex items-center gap-2">
            <UButton
              size="xs"
              variant="outline"
              color="primary"
              icon="i-lucide-award"
              :loading="evaluatingBenchmark"
              @click="runBenchmarkEvaluation"
            >
              Benchmark de Perguntas
            </UButton>
          </div>
        </div>
      </template>

      <!-- Painel de Benchmark e Saúde de Busca -->
      <div v-if="benchmarkSummary" class="p-4 mb-4 rounded-xl bg-elevated/40 border border-default/70 space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-activity" class="size-4 text-primary" />
            <span class="font-semibold text-xs text-highlighted">Métricas de Qualidade da Busca (Benchmark de Referência)</span>
          </div>
          <UBadge color="primary" variant="subtle" size="xs">
            {{ benchmarkSummary?.totalQuestions ?? 0 }} perguntas de teste
          </UBadge>
        </div>

        <div v-if="benchmarkSummary" class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div v-for="b in [
            { label: 'Hit Rate @ 1', val: `${Math.round(benchmarkSummary.hitRateAt1 * 100)}%`, col: 'text-emerald-400' },
            { label: 'Mean Recall @ 5', val: `${Math.round(benchmarkSummary.meanRecallAt5 * 100)}%`, col: 'text-sky-400' },
            { label: 'MRR', val: benchmarkSummary.mrr, col: 'text-indigo-400' },
            { label: 'Latência Média', val: `${benchmarkSummary.avgLatencyMs}ms`, col: 'text-amber-400' }
          ]" :key="b.label" class="p-2 rounded-lg bg-default border border-default/80">
            <div class="text-[11px] text-muted">{{ b.label }}</div>
            <div class="text-base font-bold" :class="b.col">{{ b.val }}</div>
          </div>
        </div>

        <!-- Indicadores de Risco / Lacunas de Busca -->
        <div v-if="staleItemsCount > 0 || untestedRulesCount > 0" class="flex flex-wrap items-center gap-2 pt-1 text-xs">
          <UBadge v-if="staleItemsCount > 0" color="neutral" variant="subtle" size="xs" icon="i-lucide-clock">
            {{ staleItemsCount }} docs desatualizados (&gt;60d)
          </UBadge>
          <UBadge v-if="untestedRulesCount > 0" color="error" variant="subtle" size="xs" icon="i-lucide-flask-conical">
            {{ untestedRulesCount }} regras sem teste
          </UBadge>
        </div>
      </div>

      <UiEmptyState
        v-if="filteredSearchHits.length === 0"
        compact
        icon="i-lucide-search-x"
        title="Nenhum resultado na busca híbrida"
        description="Experimente buscar por outros termos ou alternar os filtros de tipo de conhecimento."
      />

      <div v-else class="divide-y divide-default">
        <div
          v-for="hit in filteredSearchHits"
          :key="hit.id"
          class="p-4 hover:bg-elevated/40 transition-colors flex items-start justify-between gap-4"
        >
          <div class="space-y-1.5 min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-bold text-sm text-highlighted truncate">{{ hit.title }}</span>
              <UBadge color="neutral" variant="subtle" size="xs" class="font-mono">{{ hit.type }}</UBadge>
              <UBadge :color="hit.status === 'approved' ? 'success' : 'warning'" variant="subtle" size="xs">
                {{ hit.status }}
              </UBadge>
              <UBadge v-if="hit.score" color="primary" variant="subtle" size="xs">
                Score: {{ hit.score.toFixed(3) }}
              </UBadge>
            </div>

            <p class="text-xs text-muted line-clamp-2">{{ hit.content }}</p>

            <!-- Explicabilidade de Busca -->
            <div v-if="hit.explain" class="flex flex-wrap items-center gap-1.5 pt-1 text-[11px]">
              <span class="text-muted font-medium">Origem do match:</span>
              <span
                v-for="reason in hit.explain.matchReasons"
                :key="reason"
                class="px-1.5 py-0.5 rounded text-[10px] font-mono"
                :class="
                  reason === 'textual' ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30' :
                  reason === 'semantic' ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30' :
                  'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30'
                "
              >
                {{ reason === 'textual' ? 'BM25 Textual' : reason === 'semantic' ? 'Semântico (bge-m3)' : 'Grafo/Adjacência' }}
              </span>
              <span class="text-muted ml-2 text-[10px]">
                Lex: {{ hit.explain.lexicalScore.toFixed(2) }} · Vet: {{ hit.explain.vectorScore.toFixed(2) }} · RRF: {{ hit.explain.rrfScore.toFixed(3) }}
              </span>
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <UButton
              size="xs"
              variant="soft"
              color="primary"
              icon="i-lucide-focus"
              title="Focar este nó no Grafo"
              @click="rootId = hit.id; runSearchAndGraph()"
            >
              Focar
            </UButton>
            <UButton
              size="xs"
              variant="outline"
              icon="i-lucide-eye"
              @click="emit('inspect', { title: hit.title, content: hit.content, type: hit.type, status: hit.status })"
            >
              Ver
            </UButton>
          </div>
        </div>
      </div>
    </UCard>

    <KnowledgeCodeFlowsTab :project-id="projectId" />

    <IntentSearchModal v-model:open="intentModalOpen" :project-id="projectId" />
  </div>
</template>
