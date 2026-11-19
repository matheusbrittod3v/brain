<script setup lang="ts">
import type * as echarts from 'echarts'

const props = defineProps<{
  projectId: string
  projectsList?: Array<{ projectId: string; name: string; description?: string }>
  overviewData: {
    totalItems?: number
    approvedCount?: number
    draftCount?: number
    alerts?: string[]
    health?: { healthScore?: number; untestedRuleIds?: string[]; staleItemIds?: string[] }
    summary?: {
      byType?: Record<string, number>
      byStatus?: Record<string, number>
      byPolicy?: Record<string, number>
      rulesCount?: number
      testsCount?: number
    }
  } | null
  proposalsCount?: number
  runnerTasks?: Array<{ taskId: string; status: string }>
  finops?: {
    modelUsage?: { calls?: number; providerCostUsd?: number | null }
    infrastructureEstimate?: { totalInfraAndEnergyUsd?: number }
  } | null
  auditLogs?: Array<{
    id?: string
    createdAt?: string
    timestamp?: string
    actorId: string
    action: string
    targetType: string
    targetId: string
  }>
  loading?: boolean
}>()

const emit = defineEmits<{
  newProject: []
  refresh: []
  navigate: [workspace: 'inbox' | 'knowledge' | 'search' | 'agents' | 'impact' | 'operations']
}>()

const currentProject = computed(() =>
  props.projectsList?.find(p => p.projectId === props.projectId)
)

const totalItems = computed(() => props.overviewData?.totalItems ?? 0)
const approvedCount = computed(() => props.overviewData?.approvedCount ?? 0)
const draftCount = computed(() => props.overviewData?.draftCount ?? 0)
const rulesCount = computed(() => props.overviewData?.summary?.rulesCount ?? 0)
const testsCount = computed(() => props.overviewData?.summary?.testsCount ?? 0)
const untestedCount = computed(() => props.overviewData?.health?.untestedRuleIds?.length ?? 0)
const staleCount = computed(() => props.overviewData?.health?.staleItemIds?.length ?? 0)

const approvalRate = computed(() =>
  totalItems.value > 0 ? Math.round((approvedCount.value / totalItems.value) * 100) : 0
)
const ruleCoverageRate = computed(() => {
  if (rulesCount.value <= 0) return 100
  const covered = Math.max(0, rulesCount.value - untestedCount.value)
  return Math.round((covered / rulesCount.value) * 100)
})

const activeRunnerCount = computed(() =>
  (props.runnerTasks ?? []).filter(t => t.status === 'queued' || t.status === 'running').length
)
const finopsTotalCost = computed(() => {
  const llm = props.finops?.modelUsage?.providerCostUsd ?? 0
  const infra = props.finops?.infrastructureEstimate?.totalInfraAndEnergyUsd ?? 0
  return Number((llm + infra).toFixed(4))
})

const typeChartOption = computed<echarts.EChartsOption>(() => {
  const entries = Object.entries(props.overviewData?.summary?.byType ?? {})
  return {
    tooltip: { trigger: 'item' },
    legend: { bottom: 0, textStyle: { color: '#94a3b8', fontSize: 11 } },
    series: [
      {
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['50%', '43%'],
        itemStyle: { borderRadius: 6, borderColor: '#0f172a', borderWidth: 2 },
        label: { show: false },
        data: entries.map(([name, value]) => ({ name, value }))
      }
    ]
  }
})

const policyChartOption = computed<echarts.EChartsOption>(() => {
  const entries = Object.entries(props.overviewData?.summary?.byPolicy ?? {})
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 120, right: 20, top: 14, bottom: 24 },
    xAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: 'rgba(148,163,184,0.1)' } },
      axisLabel: { color: '#94a3b8', fontSize: 11 }
    },
    yAxis: {
      type: 'category',
      data: entries.map(([name]) => name),
      axisLabel: { color: '#94a3b8', fontSize: 11 }
    },
    series: [
      {
        type: 'bar',
        data: entries.map(([, value]) => value),
        itemStyle: { borderRadius: [0, 6, 6, 0], color: '#38bdf8' }
      }
    ]
  }
})

const coverageChartOption = computed<echarts.EChartsOption>(() => ({
  tooltip: { trigger: 'axis' },
  grid: { left: 36, right: 16, top: 16, bottom: 28 },
  xAxis: {
    type: 'category',
    data: ['Aprovados', 'Rascunhos', 'Regras', 'Testes'],
    axisLabel: { color: '#94a3b8', fontSize: 11 }
  },
  yAxis: {
    type: 'value',
    splitLine: { lineStyle: { color: 'rgba(148,163,184,0.1)' } },
    axisLabel: { color: '#94a3b8', fontSize: 11 }
  },
  series: [
    {
      type: 'bar',
      data: [
        { value: approvedCount.value, itemStyle: { color: '#10b981', borderRadius: [6, 6, 0, 0] } },
        { value: draftCount.value, itemStyle: { color: '#f59e0b', borderRadius: [6, 6, 0, 0] } },
        { value: rulesCount.value, itemStyle: { color: '#6366f1', borderRadius: [6, 6, 0, 0] } },
        { value: testsCount.value, itemStyle: { color: '#38bdf8', borderRadius: [6, 6, 0, 0] } }
      ]
    }
  ]
}))

const recentLogs = computed(() => (props.auditLogs ?? []).slice(0, 5))
</script>

<template>
  <div class="space-y-5">
    <UiPageHeader
      :title="`Visão Geral — ${currentProject?.name || projectId}`"
      :description="currentProject?.description || 'Resumo executivo de conhecimento, saúde arquitetural, Runner e governança do projeto'"
      icon="i-lucide-folder-git-2"
    >
      <template #actions>
        <UButton size="sm" variant="soft" icon="i-lucide-folder-plus" @click="emit('newProject')">
          Novo Projeto
        </UButton>
        <UButton size="sm" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="emit('refresh')">
          Atualizar
        </UButton>
      </template>
    </UiPageHeader>

    <!-- KPIs Principais -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <UiStatCard
        label="Itens Indexados"
        :value="totalItems"
        icon="i-lucide-database"
        tone="primary"
        :hint="`${rulesCount} regras · ${testsCount} testes`"
        :loading="loading"
      />
      <UiStatCard
        label="Conhecimento Oficial"
        :value="approvedCount"
        icon="i-lucide-check-circle-2"
        tone="success"
        :hint="`${approvalRate}% aprovado · ${draftCount} rascunhos`"
        :loading="loading"
      />
      <UiStatCard
        label="Saúde Arquitetural"
        :value="`${overviewData?.health?.healthScore ?? 100}%`"
        icon="i-lucide-heart-pulse"
        tone="info"
        :hint="`${untestedCount} regras sem teste · ${staleCount} obsoletos`"
        :loading="loading"
      />
      <UiStatCard
        label="Operação &amp; FinOps"
        :value="`$${finopsTotalCost.toFixed(4)}`"
        icon="i-lucide-activity"
        tone="warning"
        :hint="`${activeRunnerCount} Runner ativas · ${proposalsCount ?? 0} propostas`"
        :loading="loading"
      />
    </div>

    <!-- Gráficos -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <UCard>
        <template #header>
          <h3 class="font-semibold text-sm">Composição por Tipo</h3>
        </template>
        <UiEmptyState
          v-if="!Object.keys(overviewData?.summary?.byType ?? {}).length"
          compact
          icon="i-lucide-pie-chart"
          title="Sem itens catalogados"
        />
        <EChartBox v-else :option="typeChartOption" height="220px" />
      </UCard>

      <UCard>
        <template #header>
          <h3 class="font-semibold text-sm">Políticas de Confidencialidade</h3>
        </template>
        <UiEmptyState
          v-if="!Object.keys(overviewData?.summary?.byPolicy ?? {}).length"
          compact
          icon="i-lucide-shield"
          title="Sem políticas registradas"
        />
        <EChartBox v-else :option="policyChartOption" height="220px" />
      </UCard>

      <UCard>
        <template #header>
          <h3 class="font-semibold text-sm">Status &amp; Cobertura</h3>
        </template>
        <UiEmptyState
          v-if="totalItems === 0 && rulesCount === 0"
          compact
          icon="i-lucide-bar-chart-3"
          title="Sem métricas ainda"
        />
        <EChartBox v-else :option="coverageChartOption" height="220px" />
      </UCard>
    </div>

    <!-- Saúde, Alertas & Atividade Recente -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-sm">Saúde, Cobertura &amp; Alertas</h3>
            <UBadge :color="overviewData?.alerts?.length ? 'warning' : 'success'" variant="subtle" size="xs">
              {{ overviewData?.alerts?.length ?? 0 }} alertas
            </UBadge>
          </div>
        </template>

        <div class="space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div class="flex justify-between text-xs text-muted mb-1">
                <span>Taxa de Aprovação</span>
                <span class="font-medium text-highlighted">{{ approvalRate }}%</span>
              </div>
              <UProgress :model-value="approvalRate" color="success" size="sm" />
            </div>
            <div>
              <div class="flex justify-between text-xs text-muted mb-1">
                <span>Cobertura de Regras</span>
                <span class="font-medium text-highlighted">{{ ruleCoverageRate }}%</span>
              </div>
              <UProgress :model-value="ruleCoverageRate" color="primary" size="sm" />
            </div>
          </div>

          <UiEmptyState
            v-if="!overviewData?.alerts?.length"
            compact
            icon="i-lucide-shield-check"
            title="Tudo saudável"
            description="Nenhum conflito ou regra sem cobertura detectado neste projeto."
          />
          <div v-else class="space-y-2 max-h-48 overflow-y-auto pr-1">
            <UAlert
              v-for="(alert, idx) in overviewData.alerts"
              :key="idx"
              color="warning"
              variant="subtle"
              icon="i-lucide-alert-triangle"
              :description="alert"
            />
          </div>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-sm">Atividade Recente &amp; Atalhos</h3>
            <UButton size="xs" variant="ghost" @click="emit('navigate', 'operations')">
              Ver auditoria
            </UButton>
          </div>
        </template>

        <div class="space-y-4">
          <div class="flex flex-wrap gap-1.5">
            <UButton size="xs" variant="soft" icon="i-lucide-inbox" @click="emit('navigate', 'inbox')">
              Caixa de Entrada ({{ proposalsCount ?? 0 }})
            </UButton>
            <UButton size="xs" variant="soft" icon="i-lucide-file-text" @click="emit('navigate', 'knowledge')">
              Conhecimento
            </UButton>
            <UButton size="xs" variant="soft" icon="i-lucide-bot" @click="emit('navigate', 'agents')">
              Brain Runner
            </UButton>
            <UButton size="xs" variant="soft" icon="i-lucide-network" @click="emit('navigate', 'search')">
              Busca &amp; Grafo
            </UButton>
          </div>

          <UiEmptyState
            v-if="recentLogs.length === 0"
            compact
            icon="i-lucide-scroll-text"
            title="Sem eventos recentes"
          />
          <div v-else class="space-y-1.5">
            <div
              v-for="(log, idx) in recentLogs"
              :key="log.id || idx"
              class="flex items-center justify-between gap-2 text-xs px-2.5 py-1.5 rounded-lg border border-default bg-elevated/30"
            >
              <div class="flex items-center gap-2 min-w-0">
                <UBadge color="primary" variant="subtle" size="xs">{{ log.action }}</UBadge>
                <span class="font-mono truncate text-highlighted">{{ log.targetType }}:{{ log.targetId }}</span>
              </div>
              <span class="text-[11px] text-muted shrink-0">{{ log.actorId }}</span>
            </div>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>
