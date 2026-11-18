<script setup lang="ts">
import type * as echarts from 'echarts'

const { projectId, apiFetch, notify } = useNoemaApi()

const emit = defineEmits<{
  inspect: [item: { title: string; content: string; type?: string; status?: string }]
}>()

const query = ref('')
const rootId = ref('')
const relationFilter = ref<'all' | 'VERIFIED_BY' | 'IMPACTS' | 'DEPENDS_ON'>('all')
const loading = ref(false)

interface SearchItem {
  id: string
  title: string
  type: string
  status: string
  content: string
  accessPolicyId?: string
  score?: number
}

const searchHits = ref<SearchItem[]>([])
const graphNodes = ref<Array<{ id: string; title?: string; type?: string; status?: string }>>([])
const graphEdges = ref<Array<{ from: string; to: string; relation: string }>>([])

async function runSearchAndGraph() {
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

const filteredEdges = computed(() => {
  if (relationFilter.value === 'all') return graphEdges.value
  return graphEdges.value.filter(e => e.relation === relationFilter.value)
})

const graphOption = computed<echarts.EChartsOption>(() => {
  const nodes = graphNodes.value.slice(0, 60).map(n => ({
    id: n.id,
    name: n.title ? `${n.id}: ${n.title.slice(0, 22)}` : n.id,
    symbolSize: n.id === rootId.value ? 28 : 18,
    itemStyle: {
      color: n.id === rootId.value
        ? '#38bdf8'
        : n.status === 'approved'
          ? '#10b981'
          : n.status === 'draft'
            ? '#f59e0b'
            : '#6366f1',
      borderColor: '#0f172a',
      borderWidth: 2
    }
  }))

  const nodeIds = new Set(nodes.map(n => n.id))
  const links = filteredEdges.value
    .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map(e => ({
      source: e.from,
      target: e.to,
      lineStyle: {
        color: e.relation === 'VERIFIED_BY' ? '#10b981' : e.relation === 'IMPACTS' ? '#f59e0b' : '#6366f1',
        width: 1.8,
        curveness: 0.16
      },
      label: { show: true, formatter: e.relation, fontSize: 9, color: '#94a3b8' }
    }))

  return {
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        force: { repulsion: 260, edgeLength: [80, 140] },
        label: { show: true, position: 'bottom', color: '#cbd5e1', fontSize: 10 },
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
  <div>
    <UiPageHeader
      title="Busca Híbrida & Grafo de Conhecimento"
      description="Combina busca vetorial HNSW, BM25 e navegação de relações com zoom e arrasto"
      icon="i-lucide-network"
    >
      <template #actions>
        <UInput
          v-model="query"
          placeholder="Buscar regras, ADRs, código..."
          icon="i-lucide-search"
          size="sm"
          class="w-64"
          @keyup.enter="runSearchAndGraph"
        />
        <USelect
          v-model="relationFilter"
          :items="['all', 'VERIFIED_BY', 'IMPACTS', 'DEPENDS_ON']"
          size="sm"
          class="w-36"
        />
        <UButton size="sm" :loading="loading" icon="i-lucide-refresh-cw" @click="runSearchAndGraph">
          Atualizar
        </UButton>
      </template>
    </UiPageHeader>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
      <UiStatCard label="Nós no Grafo" :value="graphNodes.length" icon="i-lucide-circle-dot" tone="primary" />
      <UiStatCard label="Arestas Filtradas" :value="filteredEdges.length" icon="i-lucide-git-branch" tone="info" />
      <UiStatCard label="Resultados da Busca" :value="searchHits.length" icon="i-lucide-search-check" tone="success" />
    </div>

    <div class="space-y-6">
      <UCard>
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-sm">Topologia de Conhecimento</span>
              <UBadge v-if="rootId" color="info" variant="subtle" size="xs" class="font-mono">
                Foco: {{ rootId }}
              </UBadge>
            </div>
            <div class="flex items-center gap-3 text-[11px] text-muted">
              <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-400" /> Aprovado</span>
              <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-amber-400" /> Rascunho</span>
              <span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-sky-400" /> Foco</span>
              <UButton v-if="rootId" size="xs" variant="ghost" @click="rootId = ''; runSearchAndGraph()">Limpar foco</UButton>
            </div>
          </div>
        </template>

        <UiEmptyState
          v-if="graphNodes.length === 0"
          icon="i-lucide-network"
          title="Nenhum nó indexado no grafo"
          description="Ingira regras de negócio, ADRs ou código-fonte neste projeto para visualizar a topologia."
        />
        <EChartBox v-else :option="graphOption" height="380px" />
      </UCard>

      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-sm">Resultados da Busca Híbrida</h3>
            <UBadge color="neutral" variant="subtle" size="xs">{{ searchHits.length }} itens</UBadge>
          </div>
        </template>

        <UiEmptyState
          v-if="searchHits.length === 0"
          compact
          icon="i-lucide-search-x"
          title="Nenhum resultado encontrado"
          description="Tente outro termo ou deixe a busca em branco para listar os itens recentes."
        />
        <UTable
          v-else
          :data="searchHits"
          :columns="[
            { accessorKey: 'id', header: 'ID' },
            { accessorKey: 'title', header: 'Título' },
            { accessorKey: 'type', header: 'Tipo' },
            { accessorKey: 'status', header: 'Status' },
            { accessorKey: 'score', header: 'Score' },
            { id: 'actions', header: '' }
          ]"
        >
          <template #id-cell="{ row }">
            <span class="font-mono text-xs font-semibold">{{ row.original.id }}</span>
          </template>
          <template #type-cell="{ row }">
            <UBadge color="neutral" variant="outline" size="xs">{{ row.original.type }}</UBadge>
          </template>
          <template #status-cell="{ row }">
            <UBadge :color="row.original.status === 'approved' ? 'success' : 'warning'" variant="subtle" size="xs">
              {{ row.original.status }}
            </UBadge>
          </template>
          <template #score-cell="{ row }">
            <span class="font-mono text-xs text-muted">
              {{ row.original.score !== undefined ? row.original.score.toFixed(3) : '—' }}
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
  </div>
</template>
