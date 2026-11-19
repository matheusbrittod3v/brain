<script setup lang="ts">
import type * as echarts from 'echarts'
import Isometric3DGraph from './Isometric3DGraph.vue'
import {
  KNOWLEDGE_LAYERS,
  computeKnowledgeQuality,
  inferKnowledgeFormat,
  inferKnowledgeLayer,
  type KnowledgeLayer
} from './knowledgeUtils'

export interface TopologyItem {
  id: string
  title: string
  type: string
  status: string
  content: string
  tags?: string[]
}

const props = defineProps<{
  items: TopologyItem[]
}>()

const emit = defineEmits<{
  selectLayer: [layer: KnowledgeLayer]
  inspectItem: [item: TopologyItem]
}>()

type ViewMode = '3d_stack' | '2d_force' | '2d_circular' | 'hierarchy_flow' | 'matrix' | 'mermaid'

const viewMode = ref<ViewMode>('3d_stack')
const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')
const searchQuery = ref('')
const selectedLayer = ref<'all' | KnowledgeLayer>('all')
const selectedNodeForDetail = ref<TopologyItem | null>(null)
const isDetailModalOpen = ref(false)
const copied = ref(false)

const viewModeOptions = [
  { value: '3d_stack', label: '3D Isométrico', icon: 'i-lucide-box' },
  { value: '2d_force', label: '2D Força Dinâmica', icon: 'i-lucide-share-2' },
  { value: '2d_circular', label: '2D Circular / Chord', icon: 'i-lucide-circle-dot' },
  { value: 'hierarchy_flow', label: 'Fluxo em Cascata', icon: 'i-lucide-git-merge' },
  { value: 'matrix', label: 'Matriz Intercamadas', icon: 'i-lucide-grid' },
  { value: 'mermaid', label: 'Código Mermaid', icon: 'i-lucide-code-2' }
]

const layerMetaMap = new Map(KNOWLEDGE_LAYERS.map(l => [l.id, l]))

const filteredItems = computed(() => {
  return props.items.filter((item) => {
    if (selectedLayer.value !== 'all' && inferKnowledgeLayer(item) !== selectedLayer.value) {
      return false
    }
    if (searchQuery.value.trim()) {
      const q = searchQuery.value.toLowerCase()
      const titleMatch = item.title.toLowerCase().includes(q)
      const typeMatch = item.type.toLowerCase().includes(q)
      const tagMatch = item.tags?.some(t => t.toLowerCase().includes(q)) ?? false
      return titleMatch || typeMatch || tagMatch
    }
    return true
  })
})

const layerStats = computed(() => {
  return KNOWLEDGE_LAYERS.map((meta) => {
    const matching = props.items.filter(i => inferKnowledgeLayer(i) === meta.id)
    const avgQuality = matching.length > 0
      ? Math.round(matching.reduce((acc, i) => acc + computeKnowledgeQuality(i).score, 0) / matching.length)
      : 0
    const diagramsCount = matching.filter((i) => {
      const fmt = inferKnowledgeFormat(i)
      return fmt === 'mermaid' || fmt === 'topology' || fmt === 'flow'
    }).length
    return {
      ...meta,
      count: matching.length,
      avgQuality,
      diagramsCount
    }
  })
})

// Build dynamic relationships across layers
interface InterLink {
  source: string
  target: string
  sourceName: string
  targetName: string
  sourceLayer: KnowledgeLayer
  targetLayer: KnowledgeLayer
  relation: string
}

const derivedLinks = computed<InterLink[]>(() => {
  const links: InterLink[] = []
  const items = filteredItems.value.slice(0, 70)
  const itemMap = new Map(items.map(i => [i.id, i]))

  for (let i = 0; i < items.length; i++) {
    const a = items[i]!
    const layerA = inferKnowledgeLayer(a)
    const tagsA = a.tags ?? []

    // 1. Tag or ID matching
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!
      const layerB = inferKnowledgeLayer(b)
      const tagsB = b.tags ?? []

      const sharedTag = tagsA.find(t => tagsB.includes(t))
      const mentionsB = a.content.toLowerCase().includes(b.title.toLowerCase().slice(0, 14)) ||
                        b.content.toLowerCase().includes(a.title.toLowerCase().slice(0, 14))

      if (sharedTag || mentionsB || (layerA !== layerB && (i + j) % 7 === 0)) {
        links.push({
          source: a.id,
          target: b.id,
          sourceName: a.title,
          targetName: b.title,
          sourceLayer: layerA,
          targetLayer: layerB,
          relation: sharedTag ? `tag:${sharedTag}` : mentionsB ? 'referência' : 'inter-camada'
        })
      }
    }

    // Always link to layer hub if isolated
    const hasAnyLink = links.some(l => l.source === a.id || l.target === a.id)
    if (!hasAnyLink) {
      links.push({
        source: `layer:${layerA}`,
        target: a.id,
        sourceName: layerMetaMap.get(layerA)?.label ?? layerA,
        targetName: a.title,
        sourceLayer: layerA,
        targetLayer: layerA,
        relation: 'pertence_a'
      })
    }
  }

  return links
})

// 2D Force-Directed Layout Option
const forceGraphOption = computed<echarts.EChartsOption>(() => {
  const nodes: Array<Record<string, unknown>> = []
  const links: Array<Record<string, unknown>> = []

  // Add 5 Layer hubs
  for (const meta of KNOWLEDGE_LAYERS) {
    if (selectedLayer.value !== 'all' && selectedLayer.value !== meta.id) continue
    nodes.push({
      id: `layer:${meta.id}`,
      name: meta.label,
      symbolSize: 38,
      category: meta.id,
      itemStyle: {
        color: meta.color,
        borderColor: isDark.value ? '#0f172a' : '#ffffff',
        borderWidth: 3,
        shadowBlur: 14,
        shadowColor: meta.color
      },
      label: { show: true, position: 'top', color: isDark.value ? '#f8fafc' : '#0f172a', fontWeight: 'bold', fontSize: 11 }
    })
  }

  // Add items
  for (const item of filteredItems.value.slice(0, 50)) {
    const layer = inferKnowledgeLayer(item)
    const meta = layerMetaMap.get(layer) ?? KNOWLEDGE_LAYERS[0]!
    nodes.push({
      id: item.id,
      name: item.title.slice(0, 24),
      symbolSize: 18,
      category: layer,
      itemStyle: {
        color: meta.color,
        opacity: 0.9,
        borderColor: isDark.value ? '#0f172a' : '#ffffff',
        borderWidth: 1.5
      },
      rawItem: item
    })

    links.push({
      source: `layer:${layer}`,
      target: item.id,
      lineStyle: { color: meta.color, opacity: 0.4, width: 1.5 }
    })
  }

  // Cross links
  for (const l of derivedLinks.value.slice(0, 35)) {
    if (l.source.startsWith('layer:')) continue
    const color = layerMetaMap.get(l.sourceLayer)?.color ?? '#94a3b8'
    links.push({
      source: l.source,
      target: l.target,
      lineStyle: {
        color,
        opacity: 0.5,
        width: 1.8,
        curveness: 0.15,
        type: l.sourceLayer !== l.targetLayer ? 'dashed' : 'solid'
      }
    })
  }

  return {
    tooltip: {
      trigger: 'item',
      formatter: (params: any) => {
        if (params.dataType === 'edge') {
          return `<div class="text-xs"><b>Conexão:</b> ${params.data.source} → ${params.data.target}</div>`
        }
        const item = params.data.rawItem
        if (!item) return `<div class="text-xs font-bold">${params.data.name}</div>`
        const layer = inferKnowledgeLayer(item)
        return `
          <div class="text-xs space-y-1 p-1">
            <div class="font-bold">${item.title}</div>
            <div class="opacity-80">Tipo: <span class="font-mono font-semibold">${item.type}</span></div>
            <div class="opacity-80">Camada: <span class="font-semibold" style="color: ${layerMetaMap.get(layer)?.color}">${layerMetaMap.get(layer)?.label}</span></div>
          </div>
        `
      }
    },
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        force: {
          repulsion: 260,
          edgeLength: [60, 140],
          gravity: 0.08
        },
        emphasis: {
          focus: 'adjacency',
          lineStyle: { width: 3.5, opacity: 0.9 }
        },
        label: { show: true, position: 'bottom', color: '#cbd5e1', fontSize: 10 },
        data: nodes,
        links
      }
    ]
  }
})

// 2D Circular / Chord Layout Option
const circularGraphOption = computed<echarts.EChartsOption>(() => {
  const nodes: Array<Record<string, unknown>> = []
  const links: Array<Record<string, unknown>> = []

  const items = filteredItems.value.slice(0, 48)
  for (const item of items) {
    const layer = inferKnowledgeLayer(item)
    const meta = layerMetaMap.get(layer) ?? KNOWLEDGE_LAYERS[0]!
    nodes.push({
      id: item.id,
      name: item.title.slice(0, 20),
      symbolSize: 16,
      itemStyle: { color: meta.color, borderColor: '#020617', borderWidth: 1.5 },
      rawItem: item
    })
  }

  for (const l of derivedLinks.value.slice(0, 40)) {
    if (l.source.startsWith('layer:')) continue
    const meta = layerMetaMap.get(l.sourceLayer)
    links.push({
      source: l.source,
      target: l.target,
      lineStyle: {
        color: meta?.color ?? '#6366f1',
        opacity: 0.55,
        width: 1.6,
        curveness: 0.35
      }
    })
  }

  return {
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'graph',
        layout: 'circular',
        circular: { rotateLabel: true },
        roam: true,
        data: nodes,
        links,
        label: { show: true, position: 'right', color: '#cbd5e1', fontSize: 9 },
        emphasis: { focus: 'adjacency', lineStyle: { width: 3 } }
      }
    ]
  }
})

// Hierarchy / Pipeline Flow Chart Option
const hierarchyFlowOption = computed<echarts.EChartsOption>(() => {
  const validLayers: KnowledgeLayer[] = ['architecture', 'business', 'code', 'product', 'operations']
  const itemsByLayer = new Map<KnowledgeLayer, TopologyItem[]>()
  for (const l of validLayers) {
    itemsByLayer.set(l, [])
  }
  for (const item of props.items) {
    const l = inferKnowledgeLayer(item)
    if (itemsByLayer.has(l)) {
      itemsByLayer.get(l)!.push(item)
    }
  }

  const nodes: Array<Record<string, unknown>> = []
  const links: Array<Record<string, unknown>> = []

  validLayers.forEach((layerId, layerIdx) => {
    const meta = layerMetaMap.get(layerId)!
    const list = (itemsByLayer.get(layerId) ?? []).slice(0, 6)

    list.forEach((item, itemIdx) => {
      const x = 80 + layerIdx * 190
      const y = 60 + itemIdx * 65
      nodes.push({
        id: item.id,
        name: item.title.slice(0, 20),
        x,
        y,
        symbolSize: 22,
        itemStyle: { color: meta.color, borderColor: '#020617', borderWidth: 2 },
        label: { show: true, position: 'bottom', color: '#e2e8f0', fontSize: 10 }
      })

      // Link to next layer
      if (layerIdx < validLayers.length - 1) {
        const nextLayerId = validLayers[layerIdx + 1]!
        const nextList = itemsByLayer.get(nextLayerId) ?? []
        if (nextList.length > 0) {
          const targetItem = nextList[itemIdx % nextList.length]!
          links.push({
            source: item.id,
            target: targetItem.id,
            lineStyle: {
              color: meta.color,
              opacity: 0.5,
              width: 2,
              curveness: 0.2
            }
          })
        }
      }
    })
  })

  return {
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'graph',
        layout: 'none',
        roam: true,
        data: nodes,
        links,
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: 8,
        label: { show: true },
        emphasis: { focus: 'adjacency' }
      }
    ]
  }
})

// Cross-layer Matrix data
const layerMatrixData = computed(() => {
  const activeLayers = KNOWLEDGE_LAYERS.slice(0, 5)
  const matrix: number[][] = activeLayers.map(() => activeLayers.map(() => 0))

  for (const l of derivedLinks.value) {
    const srcIdx = activeLayers.findIndex(al => al.id === l.sourceLayer)
    const tgtIdx = activeLayers.findIndex(al => al.id === l.targetLayer)
    if (srcIdx >= 0 && tgtIdx >= 0) {
      matrix[srcIdx]![tgtIdx]! += 1
    }
  }

  return {
    layers: activeLayers,
    matrix
  }
})

// Live Mermaid Generator
const generatedMermaidCode = computed(() => {
  const lines: string[] = ['flowchart TD']
  const validLayers: KnowledgeLayer[] = ['architecture', 'business', 'code', 'product', 'operations']

  for (const lId of validLayers) {
    const meta = layerMetaMap.get(lId)!
    const matching = props.items.filter(i => inferKnowledgeLayer(i) === lId).slice(0, 4)
    lines.push(`  subgraph ${lId}["${meta.label}"]`)
    for (const item of matching) {
      const safeId = item.id.replace(/[^A-Za-z0-9]/g, '_')
      const safeTitle = item.title.replace(/["\[\]]/g, '')
      lines.push(`    ${safeId}["${safeTitle}"]`)
    }
    lines.push('  end')
  }

  // Cross connections
  for (const link of derivedLinks.value.slice(0, 15)) {
    if (link.source.startsWith('layer:')) continue
    const src = link.source.replace(/[^A-Za-z0-9]/g, '_')
    const tgt = link.target.replace(/[^A-Za-z0-9]/g, '_')
    lines.push(`  ${src} -->|${link.relation}| ${tgt}`)
  }

  return lines.join('\n')
})

function copyMermaid() {
  navigator.clipboard.writeText(generatedMermaidCode.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

function exportTopologyJson() {
  const data = {
    generatedAt: new Date().toISOString(),
    totalNodes: props.items.length,
    layers: KNOWLEDGE_LAYERS,
    nodes: props.items.map(i => ({
      id: i.id,
      title: i.title,
      type: i.type,
      layer: inferKnowledgeLayer(i),
      format: inferKnowledgeFormat(i),
      tags: i.tags ?? []
    })),
    links: derivedLinks.value
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `brain-topology-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function handleNodeClick(item: any) {
  selectedNodeForDetail.value = item
  isDetailModalOpen.value = true
  emit('inspectItem', item)
}
</script>

<template>
  <div class="space-y-5">
    <!-- Top Layer KPI Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
      <button
        v-for="st in layerStats"
        :key="st.id"
        type="button"
        class="text-left p-3.5 rounded-xl border transition-all cursor-pointer space-y-1.5"
        :class="selectedLayer === st.id ? 'border-primary bg-primary/10 shadow-sm' : 'border-default bg-default hover:border-primary/40'"
        @click="selectedLayer = (selectedLayer === st.id ? 'all' : st.id); emit('selectLayer', st.id)"
      >
        <div class="flex items-center justify-between gap-1.5">
          <div class="flex items-center gap-2 min-w-0">
            <div class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-elevated">
              <UIcon :name="st.icon" class="size-4" :style="{ color: st.color }" />
            </div>
            <div class="font-semibold text-xs text-highlighted truncate">{{ st.label.split(' ')[0] }}</div>
          </div>
          <UBadge :color="st.avgQuality >= 70 ? 'success' : st.count > 0 ? 'warning' : 'neutral'" variant="subtle" size="xs">
            {{ st.count }}
          </UBadge>
        </div>
        <p class="text-[11px] text-muted line-clamp-1">{{ st.description }}</p>
      </button>
    </div>

    <!-- Main Multi-Layer Interactive Visualizer Card -->
    <UCard :ui="{ body: 'p-0 sm:p-0' }">
      <template #header>
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div class="space-y-0.5">
            <div class="flex items-center gap-2">
              <h3 class="font-semibold text-sm">Topologia Multicamada do Projeto</h3>
              <UBadge color="primary" variant="subtle" size="xs">{{ filteredItems.length }} nós visíveis</UBadge>
            </div>
            <p class="text-xs text-muted">
              Visualização interativa conectando Arquitetura, Negócio, Código, Produto e Operação.
            </p>
          </div>

          <!-- Controls bar -->
          <div class="flex flex-wrap items-center gap-2">
            <!-- View Mode Switcher -->
            <div class="flex items-center bg-elevated rounded-lg p-1 border border-default">
              <button
                v-for="mode in viewModeOptions"
                :key="mode.value"
                type="button"
                class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all"
                :class="viewMode === mode.value ? 'bg-primary text-white shadow-sm' : 'text-muted hover:text-highlighted'"
                :title="mode.label"
                @click="viewMode = mode.value as ViewMode"
              >
                <UIcon :name="mode.icon" class="size-3.5" />
                <span class="hidden xl:inline">{{ mode.label }}</span>
              </button>
            </div>

            <!-- Export Actions -->
            <div class="flex items-center gap-1.5">
              <UButton
                size="xs"
                variant="outline"
                icon="i-lucide-download"
                title="Exportar Topologia em JSON"
                @click="exportTopologyJson"
              >
                JSON
              </UButton>
              <UButton
                size="xs"
                variant="outline"
                :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
                :color="copied ? 'success' : 'neutral'"
                title="Copiar Código Mermaid"
                @click="copyMermaid"
              >
                {{ copied ? 'Copiado!' : 'Mermaid' }}
              </UButton>
            </div>
          </div>
        </div>
      </template>

      <!-- View Containers -->
      <div class="relative bg-elevated/30 min-h-[520px] rounded-b-xl overflow-hidden">
        <!-- 1. 3D Isometric Canvas View -->
        <div v-if="viewMode === '3d_stack'" class="w-full h-full min-h-[520px]">
          <Isometric3DGraph :items="props.items" @inspect-item="handleNodeClick" />
        </div>

        <!-- 2. 2D Force-Directed Physics View -->
        <div v-else-if="viewMode === '2d_force'" class="p-4">
          <div class="flex items-center justify-between mb-2 px-2 text-xs text-muted">
            <span>Física dinâmica com agrupamento radial por camada e repulsão intercamadas. Arraste os nós para reordenar.</span>
            <span class="text-sky-400 font-mono text-[11px]">{{ filteredItems.length }} nós / {{ derivedLinks.length }} arestas</span>
          </div>
          <EChartBox :option="forceGraphOption" height="500px" />
        </div>

        <!-- 3. 2D Circular / Chord View -->
        <div v-else-if="viewMode === '2d_circular'" class="p-4">
          <div class="flex items-center justify-between mb-2 px-2 text-xs text-muted">
            <span>Disposição circular com enlaces curvos destacando dependências cruzadas entre camadas.</span>
            <span class="text-amber-400 font-mono text-[11px]">Projeção Circular</span>
          </div>
          <EChartBox :option="circularGraphOption" height="500px" />
        </div>

        <!-- 4. Pipeline / Cascading Hierarchy View -->
        <div v-else-if="viewMode === 'hierarchy_flow'" class="p-4">
          <div class="flex items-center justify-between mb-2 px-2 text-xs text-muted">
            <span>Fluxo de desdobramento: Arquitetura → Negócio → Código → Produto → Operação.</span>
            <span class="text-emerald-400 font-mono text-[11px]">Pipeline Step Flow</span>
          </div>
          <EChartBox :option="hierarchyFlowOption" height="500px" />
        </div>

        <!-- 5. Inter-Layer Coupling Matrix View -->
        <div v-else-if="viewMode === 'matrix'" class="p-6 max-w-3xl mx-auto space-y-4">
          <div class="text-center space-y-1">
            <h4 class="font-semibold text-sm text-highlighted">Matriz de Acoplamento e Densidade Intercamadas</h4>
            <p class="text-xs text-muted">Mede a quantidade de regras, dependências e contratos conectando cada camada.</p>
          </div>

          <div class="overflow-x-auto rounded-xl border border-default bg-elevated/60 p-4">
            <table class="w-full text-xs text-left border-collapse">
              <thead>
                <tr class="border-b border-default text-muted">
                  <th class="p-2.5 font-medium">Origem \ Destino</th>
                  <th
                    v-for="col in layerMatrixData.layers"
                    :key="col.id"
                    class="p-2.5 font-medium text-center"
                    :style="{ color: col.color }"
                  >
                    {{ col.label.split(' ')[0] }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, rIdx) in layerMatrixData.layers"
                  :key="row.id"
                  class="border-b border-default/50 hover:bg-elevated/60"
                >
                  <td class="p-2.5 font-medium" :style="{ color: row.color }">
                    {{ row.label }}
                  </td>
                  <td
                    v-for="(col, cIdx) in layerMatrixData.layers"
                    :key="col.id"
                    class="p-2.5 text-center font-mono font-bold"
                  >
                    <span
                      class="inline-block px-2 py-0.5 rounded text-xs"
                      :class="layerMatrixData.matrix[rIdx]![cIdx]! > 0
                        ? 'bg-primary/20 text-primary border border-primary/30'
                        : 'text-muted'"
                    >
                      {{ layerMatrixData.matrix[rIdx]![cIdx] }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 6. Mermaid Code View -->
        <div v-else-if="viewMode === 'mermaid'" class="p-5 space-y-3">
          <div class="flex items-center justify-between">
            <div class="text-xs text-muted">
              Código Mermaid gerado em tempo real a partir das 5 camadas e dos itens ativos no Hub.
            </div>
            <UButton
              size="xs"
              variant="solid"
              color="primary"
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              @click="copyMermaid"
            >
              {{ copied ? 'Copiado!' : 'Copiar Diagrama' }}
            </UButton>
          </div>
          <pre class="p-4 rounded-xl bg-elevated border border-default text-default font-mono text-xs overflow-x-auto max-h-[460px] leading-relaxed select-all"><code>{{ generatedMermaidCode }}</code></pre>
        </div>
      </div>
    </UCard>

    <!-- Node Detail Drawer / Inspection Modal -->
    <UModal v-model:open="isDetailModalOpen">
      <template #content>
        <div v-if="selectedNodeForDetail" class="p-5 space-y-4">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <UBadge
                :color="layerMetaMap.get(inferKnowledgeLayer(selectedNodeForDetail))?.badgeColor ?? 'neutral'"
                variant="subtle"
                size="xs"
              >
                {{ layerMetaMap.get(inferKnowledgeLayer(selectedNodeForDetail))?.label }}
              </UBadge>
              <span class="text-xs font-mono text-muted">{{ selectedNodeForDetail.type }}</span>
            </div>
            <UButton size="xs" variant="ghost" icon="i-lucide-x" @click="isDetailModalOpen = false" />
          </div>

          <div>
            <h3 class="font-bold text-base text-highlighted">{{ selectedNodeForDetail.title }}</h3>
            <p class="text-xs text-muted font-mono mt-0.5">ID: {{ selectedNodeForDetail.id }}</p>
          </div>

          <div v-if="selectedNodeForDetail.tags && selectedNodeForDetail.tags.length > 0" class="flex flex-wrap gap-1.5">
            <UBadge v-for="t in selectedNodeForDetail.tags" :key="t" color="neutral" variant="outline" size="xs">
              {{ t }}
            </UBadge>
          </div>

          <div class="p-3 bg-elevated rounded-lg max-h-60 overflow-y-auto text-xs font-mono text-default whitespace-pre-wrap border border-default">
            {{ selectedNodeForDetail.content.slice(0, 1000) }}
            <span v-if="selectedNodeForDetail.content.length > 1000" class="text-muted">...</span>
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <UButton size="xs" variant="outline" @click="isDetailModalOpen = false">Fechar</UButton>
            <UButton size="xs" color="primary" @click="emit('inspectItem', selectedNodeForDetail); isDetailModalOpen = false">
              Abrir no Editor
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
