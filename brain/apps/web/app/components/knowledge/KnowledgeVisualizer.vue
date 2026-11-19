<script setup lang="ts">
import type * as echarts from 'echarts'
import { KNOWLEDGE_LAYERS, parseVisualGraphFromContent, type KnowledgeFormat } from './knowledgeUtils'

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

const props = defineProps<{
  content: string
  format?: KnowledgeFormat
}>()

const viewMode = ref<'visual' | 'source'>('visual')

const parsedGraph = computed(() => parseVisualGraphFromContent(props.content))

const flowSteps = computed(() => {
  if (parsedGraph.value) return []
  return props.content
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /^\d+\.\s+/.test(l) || /->|=>|→/.test(l))
    .map(l => l.replace(/^\d+\.\s+/, ''))
})

const hasVisual = computed(() => Boolean(parsedGraph.value) || flowSteps.value.length > 0)

const layerColorMap = new Map(KNOWLEDGE_LAYERS.map(l => [l.id, l.color]))

const chartOption = computed<echarts.EChartsOption>(() => {
  const g = parsedGraph.value
  if (!g) return {}
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
        layout: 'force',
        roam: true,
        draggable: true,
        force: { repulsion: 260, edgeLength: [90, 150] },
        emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
        label: { show: true, position: 'bottom', color: '#e2e8f0', fontSize: 11 },
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: [4, 8],
        data: g.nodes.map(n => ({
          id: n.id,
          name: n.label,
          symbolSize: 26,
          itemStyle: {
            color: (n.layer && layerColorMap.get(n.layer as any)) || '#6366f1',
            borderColor: isDark.value ? '#0f172a' : '#ffffff',
            borderWidth: 2
          }
        })),
        links: g.edges.map(e => ({
          source: e.from,
          target: e.to,
          lineStyle: { color: '#38bdf8', width: 2, curveness: 0.14 },
          label: e.label ? { show: true, formatter: e.label, fontSize: 10, color: '#cbd5e1' } : undefined
        }))
      }
    ]
  }
})
</script>

<template>
  <div class="space-y-3">
    <div v-if="hasVisual" class="flex items-center justify-between gap-2">
      <UBadge color="primary" variant="subtle" size="xs">
        {{ parsedGraph ? 'Diagrama / Topologia Interativa' : 'Fluxo Estruturado' }}
      </UBadge>
      <UiSegmentedTabs
        v-model="viewMode"
        :items="[
          { label: 'Visualização', value: 'visual', icon: 'i-lucide-eye' },
          { label: 'Fonte / Markdown', value: 'source', icon: 'i-lucide-code-2' }
        ]"
      />
    </div>

    <template v-if="hasVisual && viewMode === 'visual'">
      <div v-if="parsedGraph" class="rounded-xl border border-default bg-elevated/40 p-2">
        <EChartBox :option="chartOption" height="320px" />
      </div>

      <div v-else-if="flowSteps.length > 0" class="space-y-2">
        <div
          v-for="(step, idx) in flowSteps"
          :key="idx"
          class="flex items-start gap-3 p-2.5 rounded-lg border border-default bg-elevated/40 text-xs"
        >
          <span class="shrink-0 w-5 h-5 rounded-full bg-primary/20 text-primary font-bold flex items-center justify-center text-[11px]">
            {{ idx + 1 }}
          </span>
          <span class="text-highlighted leading-relaxed pt-0.5">{{ step }}</span>
        </div>
      </div>
    </template>

    <pre
      v-else
      class="text-xs font-mono whitespace-pre-wrap p-3.5 rounded-xl border border-default bg-elevated/40 max-h-96 overflow-y-auto leading-relaxed"
    >{{ content }}</pre>
  </div>
</template>

