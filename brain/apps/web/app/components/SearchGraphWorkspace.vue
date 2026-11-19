<script setup lang="ts">
import type * as echarts from 'echarts'

const { projectId, apiFetch, notify } = useBrainApi()

const emit = defineEmits<{
  inspect: [item: { title: string; content: string; type?: string; status?: string }]
}>()

const query = ref('')
const rootId = ref('')
const relationFilter = ref<'all' | 'VERIFIED_BY' | 'IMPACTS' | 'DEPENDS_ON'>('all')
const typeFilter = ref('all')
const graphLayout = ref<'force' | 'circular'>('force')
const showEdgeLabels = ref(false)
const expandedGraph = ref(false)
const loading = ref(false)

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
const graphNodes = ref<Array<{ id: string; title?: string; type?: string; status?: string }>>([])
const graphEdges = ref<Array<{ from: string; to: string; relation: string }>>([])
const evaluatingBenchmark = ref(false)
const benchmarkSummary = ref<BenchmarkSummary | null>(null)
const zeroHitQueries = ref<Array<{ query: string; count: number }>>([])
const staleItemsCount = ref(0)
const untestedRulesCount = ref(0)

async function runBenchmarkEvaluation() {
  if (!projectId.value) return
  evaluatingBenchmark.value = true
  const pid = encodeURIComponent(projectId.value)
  try {
    const [bRes, eRes] = await Promise.all([
      apiFetch<{ zeroHitQueries?: Array<{ query: string; count: number }>; staleItems?: unknown[]; untestedRules?: unknown[] }>(`/v1/projects/${pid}/search/benchmark`),
      apiFetch<{ summary: BenchmarkSummary }>(`/v1/projects/${pid}/search/evaluate`, { method: 'POST' })
    ])
    zeroHitQueries.value = bRes.zeroHitQueries ?? []
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
watch(projectId, runSearchAndGraph)

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

const graphOption = computed<echarts.EChartsOption>(() => {
  const degreeMap = new Map<string, number>()
  for (const e of filteredEdges.value) {
    degreeMap.set(e.from, (degreeMap.get(e.from) ?? 0) + 1)
    degreeMap.set(e.to, (degreeMap.get(e.to) ?? 0) + 1)
  }

  const nodes = filteredNodes.value.slice(0, 70).map((n) => {
    const deg = degreeMap.get(n.id) ?? 0
    const isRoot = n.id === rootId.value
    return {
      id: n.id,
      name: n.title ? `${n.id}: ${n.title.slice(0, 22)}` : n.id,
      value: deg,
      symbolSize: isRoot ? 32 : Math.min(30, 16 + deg * 2.5),
      itemStyle: {
        color: isRoot
          ? '#38bdf8'
          : n.status === 'approved'
            ? '#10b981'
            : n.status === 'draft'
              ? '#f59e0b'
              : '#6366f1',
        borderColor: isRoot ? '#e0f2fe' : '#0f172a',
        borderWidth: isRoot ? 3 : 2,
        shadowBlur: isRoot ? 14 : 6,
        shadowColor: isRoot ? 'rgba(56, 189, 248, 0.55)' : 'rgba(15, 23, 42, 0.35)'
      }
    }
  })

  const nodeIds = new Set(nodes.map(n => n.id))
  const links = filteredEdges.value
    .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map(e => ({
      source: e.from,
      target: e.to,
      lineStyle: {
        color: e.relation === 'VERIFIED_BY' ? '#10b981' : e.relation === 'IMPACTS' ? '#f59e0b' : '#818cf8',
        width: 1.8,
        opacity: 0.78,
        curveness: graphLayout.value === 'circular' ? 0.24 : 0.16
      },
      label: {
        show: showEdgeLabels.value,
        formatter: e.relation,
        fontSize: 9,
        color: '#94a3b8'
      }
    }))

  return {
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(15, 23, 42, 0.94)',
      borderColor: 'rgba(148, 163, 184, 0.25)',
      textStyle: { color: '#f8fafc', fontSize: 12 }
    },
    series: [
      {
        type: 'graph',
        layout: graphLayout.value,
        roam: true,
        draggable: true,
        circular: { rotateLabel: true },
        force: {
          repulsion: 320,
          gravity: 0.08,
          edgeLength: [90, 160]
        },
        emphasis: {
          focus: 'adjacency',
          lineStyle: { width: 3.2, opacity: 1 }
        },
        label: {
          show: true,
          position: 'bottom',
          color: '#cbd5e1',
          fontSize: 10,
          distance: 4
        },
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: [4, 8],
        data: nodes,
        links
      }
    ]
  }
})
</script>

<template>
  <div class="space-y-5">
    <UiPageHeader
      title="Busca Híbrida &amp; Grafo de Conhecimento"
      description="Combina busca vetorial HNSW, BM25 e navegação de relações com zoom, arrasto e foco por adjacência"
      icon="i-lucide-network"
    >
      <template #actions>
        <UInput
          v-model="query"
          placeholder="Buscar regras, ADRs, código..."
          icon="i-lucide-search"
          size="sm"
          class="w-60"
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

    <!-- Topologia -->
    <UCard>
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
            <USelect
              v-model="rootId"
              :items="nodeFocusItems"
              size="xs"
              class="w-48 font-mono"
              @update:model-value="runSearchAndGraph"
            />
            <UiSegmentedTabs
              v-model="graphLayout"
              :items="[
                { label: 'Orgânico', value: 'force', icon: 'i-lucide-sparkles' },
                { label: 'Circular', value: 'circular', icon: 'i-lucide-circle-dashed' }
              ]"
            />
            <UButton
              size="xs"
              :variant="showEdgeLabels ? 'soft' : 'outline'"
              :color="showEdgeLabels ? 'primary' : 'neutral'"
              icon="i-lucide-tag"
              @click="showEdgeLabels = !showEdgeLabels"
            >
              Rótulos
            </UButton>
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
      <EChartBox v-else :option="graphOption" :height="expandedGraph ? '540px' : '380px'" />
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
            <UButton size="xs" color="primary" variant="soft" icon="i-lucide-flask-conical" :loading="evaluatingBenchmark" @click="runBenchmarkEvaluation">
              Avaliar Benchmark (8 Perguntas)
            </UButton>
            <UBadge color="neutral" variant="subtle" size="xs">{{ filteredSearchHits.length }} itens</UBadge>
          </div>
        </div>
        <div v-if="benchmarkSummary" class="grid grid-cols-2 sm:grid-cols-6 gap-2 mt-3 pt-3 border-t border-default text-xs">
          <div class="rounded-lg bg-elevated/50 p-2">
            <div class="text-[10px] text-muted">Hit@1 (Precisão Topo)</div>
            <div class="font-mono font-bold text-success">{{ Math.round(benchmarkSummary.hitRateAt1 * 100) }}%</div>
          </div>
          <div class="rounded-lg bg-elevated/50 p-2">
            <div class="text-[10px] text-muted">Recall@5</div>
            <div class="font-mono font-bold text-primary">{{ Math.round(benchmarkSummary.meanRecallAt5 * 100) }}%</div>
          </div>
          <div class="rounded-lg bg-elevated/50 p-2">
            <div class="text-[10px] text-muted">MRR</div>
            <div class="font-mono font-bold text-highlighted">{{ benchmarkSummary.mrr }}</div>
          </div>
          <div class="rounded-lg bg-elevated/50 p-2">
            <div class="text-[10px] text-muted">Latência Média</div>
            <div class="font-mono font-bold text-highlighted">{{ benchmarkSummary.avgLatencyMs }}ms</div>
          </div>
          <div class="rounded-lg bg-elevated/50 p-2">
            <div class="text-[10px] text-muted">Buscas Sem Resposta</div>
            <div class="font-mono font-bold text-highlighted">{{ zeroHitQueries.length }}</div>
          </div>
          <div class="rounded-lg bg-elevated/50 p-2">
            <div class="text-[10px] text-muted">Desatualizados / Sem Teste</div>
            <div class="font-mono font-bold text-highlighted">{{ staleItemsCount }} / {{ untestedRulesCount }}</div>
          </div>
        </div>
      </template>

      <UiEmptyState
        v-if="filteredSearchHits.length === 0"
        compact
        icon="i-lucide-search-x"
        title="Nenhum resultado encontrado"
        description="Tente outro termo ou deixe a busca em branco para listar os itens recentes."
      />
      <UTable
        v-else
        :data="filteredSearchHits"
        :columns="[
          { accessorKey: 'id', header: 'ID' },
          { accessorKey: 'title', header: 'Título' },
          { accessorKey: 'type', header: 'Tipo' },
          { accessorKey: 'explain', header: 'Por que apareceu?' },
          { accessorKey: 'score', header: 'Relevância' },
          { id: 'actions', header: '' }
        ]"
      >
        <template #id-cell="{ row }">
          <span class="font-mono text-xs font-semibold text-highlighted">{{ row.original.id }}</span>
        </template>
        <template #type-cell="{ row }">
          <UBadge color="neutral" variant="outline" size="xs">{{ row.original.type }}</UBadge>
        </template>
        <template #explain-cell="{ row }">
          <div class="flex flex-wrap items-center gap-1">
            <UBadge
              v-if="row.original.explain?.matchReasons?.includes('textual')"
              color="info"
              variant="subtle"
              size="xs"
            >
              BM25 {{ ((row.original.explain.lexicalScore ?? 0) * 100).toFixed(0) }}%
            </UBadge>
            <UBadge
              v-if="row.original.explain?.matchReasons?.includes('semantic')"
              color="primary"
              variant="subtle"
              size="xs"
            >
              Semântica {{ ((row.original.explain.vectorScore ?? 0) * 100).toFixed(0) }}%
            </UBadge>
            <UBadge
              v-if="row.original.explain?.matchReasons?.includes('graph') || (row.original.explain?.graphProximity ?? 0) > 0"
              color="success"
              variant="subtle"
              size="xs"
            >
              Grafo {{ ((row.original.explain?.graphProximity ?? 0) * 100).toFixed(0) }}%
            </UBadge>
            <UBadge v-if="row.original.sharedFromProjectId" color="warning" variant="subtle" size="xs">
              Global: {{ row.original.sharedFromProjectId }}
            </UBadge>
          </div>
        </template>
        <template #score-cell="{ row }">
          <span class="font-mono text-xs text-primary">
            {{ row.original.score !== undefined ? `${(row.original.score * 100).toFixed(1)}%` : '—' }}
          </span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UButton size="xs" variant="ghost" icon="i-lucide-crosshair" @click="rootId = row.original.id; runSearchAndGraph()">
              Focar
            </UButton>
            <UButton size="xs" variant="soft" icon="i-lucide-eye" @click="emit('inspect', row.original)">
              Ler
            </UButton>
          </div>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
