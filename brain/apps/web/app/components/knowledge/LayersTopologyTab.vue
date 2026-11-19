<script setup lang="ts">
import type * as echarts from 'echarts'
import {
  KNOWLEDGE_LAYERS,
  computeKnowledgeQuality,
  inferKnowledgeFormat,
  inferKnowledgeLayer,
  type KnowledgeLayer
} from './knowledgeUtils'

const props = defineProps<{
  items: Array<{
    id: string
    title: string
    type: string
    status: string
    content: string
    tags?: string[]
  }>
}>()

const emit = defineEmits<{
  selectLayer: [layer: KnowledgeLayer]
  inspectItem: [item: any]
}>()

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

const multiLayerGraphOption = computed<echarts.EChartsOption>(() => {
  const layerMetaMap = new Map(KNOWLEDGE_LAYERS.map(l => [l.id, l]))
  const nodes: Array<Record<string, unknown>> = KNOWLEDGE_LAYERS.map(l => ({
    id: `layer:${l.id}`,
    name: l.label,
    symbolSize: 34,
    itemStyle: { color: l.color, borderColor: '#0f172a', borderWidth: 3 }
  }))
  const links: Array<Record<string, unknown>> = []

  for (const item of props.items.slice(0, 45)) {
    const layer = inferKnowledgeLayer(item)
    const meta = layerMetaMap.get(layer)!
    nodes.push({
      id: item.id,
      name: item.title.slice(0, 22),
      symbolSize: 16,
      itemStyle: { color: meta.color, opacity: 0.85, borderColor: '#0f172a', borderWidth: 1.5 }
    })
    links.push({
      source: `layer:${layer}`,
      target: item.id,
      lineStyle: { color: meta.color, opacity: 0.45, width: 1.5 }
    })
  }

  return {
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        force: { repulsion: 240, edgeLength: [60, 120] },
        emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
        label: { show: true, position: 'bottom', color: '#cbd5e1', fontSize: 10 },
        data: nodes,
        links
      }
    ]
  }
})
</script>

<template>
  <div class="space-y-5">
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      <button
        v-for="st in layerStats"
        :key="st.id"
        type="button"
        class="text-left p-4 rounded-xl border border-default bg-default hover:border-primary/50 transition-colors cursor-pointer space-y-2"
        @click="emit('selectLayer', st.id)"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center bg-elevated">
              <UIcon :name="st.icon" class="size-4" :style="{ color: st.color }" />
            </div>
            <div>
              <div class="font-semibold text-sm text-highlighted">{{ st.label }}</div>
              <div class="text-[11px] text-muted">{{ st.count }} itens · {{ st.diagramsCount }} visuais</div>
            </div>
          </div>
          <UBadge :color="st.avgQuality >= 70 ? 'success' : st.count > 0 ? 'warning' : 'neutral'" variant="subtle" size="xs">
            {{ st.count > 0 ? `Qualidade ${st.avgQuality}%` : 'Vazia' }}
          </UBadge>
        </div>
        <p class="text-xs text-muted line-clamp-2">{{ st.description }}</p>
      </button>
    </div>

    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-semibold text-sm">Topologia Multicamada do Projeto</h3>
            <p class="text-xs text-muted">Mapa visual conectando Arquitetura, Negócio, Código, Produto e Operação.</p>
          </div>
          <UBadge color="primary" variant="subtle" size="xs">{{ items.length }} nós</UBadge>
        </div>
      </template>

      <UiEmptyState
        v-if="items.length === 0"
        compact
        icon="i-lucide-network"
        title="Nenhum conhecimento cadastrado ainda"
        description="Alimente o Hub com diagramas, topologias, regras ou contratos de código."
      />
      <EChartBox v-else :option="multiLayerGraphOption" height="380px" />
    </UCard>
  </div>
</template>

