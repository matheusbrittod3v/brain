<script setup lang="ts">
import type * as echarts from 'echarts'
import { formatCompactNumber, type FinOpsData } from './types'

const props = defineProps<{
  finops: FinOpsData | null
  period: '7d' | '30d' | '90d' | 'all'
}>()

const emit = defineEmits<{
  useAsFallback: [model: string]
}>()

const chartMetric = ref<'tokens' | 'usd' | 'calls'>('tokens')
const providerFilter = ref('all')

const models = computed(() => props.finops?.modelUsage?.byModel ?? [])
const providerCost = computed(() => props.finops?.modelUsage?.providerCostUsd ?? 0)
const computeCost = computed(() => props.finops?.infrastructureEstimate?.computeCostUsd ?? 0)
const energyCost = computed(() => props.finops?.infrastructureEstimate?.energyCostUsd ?? 0)
const totalCost = computed(() => Number((providerCost.value + (props.finops?.infrastructureEstimate?.totalInfraAndEnergyUsd ?? 0)).toFixed(4)))

const totalTokens = computed(() => {
  const measured = models.value.reduce((acc, m) => acc + (m.totalTokens ?? 0), 0)
  return measured > 0 ? measured : (props.finops?.estimatedLocalTokens ?? 0)
})

const providerFilterItems = computed(() => {
  const unique = [...new Set(models.value.map(m => m.provider).filter((p): p is string => Boolean(p)))]
  return [
    { label: 'Todos os provedores', value: 'all' },
    ...unique.map(p => ({ label: p, value: p.toLowerCase() }))
  ]
})

const filteredModels = computed(() => {
  if (providerFilter.value === 'all') return models.value
  return models.value.filter(m => (m.provider || m.model).toLowerCase().includes(providerFilter.value))
})

const barChartOption = computed<echarts.EChartsOption>(() => {
  const data = filteredModels.value.map(m => ({
    name: m.model.length > 22 ? `${m.model.slice(0, 20)}…` : m.model,
    value: chartMetric.value === 'usd'
      ? Number((m.providerCostUsd ?? 0).toFixed(4))
      : chartMetric.value === 'calls'
        ? (m.calls ?? 1)
        : (m.totalTokens ?? 0)
  }))

  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 48, right: 20, top: 20, bottom: 32 },
    xAxis: { type: 'category', data: data.map(d => d.name), axisLabel: { color: '#94a3b8', fontSize: 11 } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(148,163,184,0.1)' } }, axisLabel: { color: '#94a3b8', fontSize: 11 } },
    series: [
      {
        type: 'bar',
        data: data.map(d => d.value),
        itemStyle: { borderRadius: [6, 6, 0, 0], color: '#6366f1' }
      }
    ]
  }
})

const donutChartOption = computed<echarts.EChartsOption>(() => ({
  tooltip: { trigger: 'item', formatter: '{b}: ${c} ({d}%)' },
  legend: { bottom: 0, textStyle: { color: '#94a3b8', fontSize: 11 } },
  series: [
    {
      type: 'pie',
      radius: ['52%', '76%'],
      center: ['50%', '44%'],
      itemStyle: { borderRadius: 6, borderColor: '#0f172a', borderWidth: 2 },
      label: { show: false },
      data: [
        { value: Number(providerCost.value.toFixed(4)), name: 'Provedores LLM', itemStyle: { color: '#6366f1' } },
        { value: Number(computeCost.value.toFixed(4)), name: 'Infra Compute', itemStyle: { color: '#38bdf8' } },
        { value: Number(energyCost.value.toFixed(4)), name: 'Energia ESG', itemStyle: { color: '#10b981' } }
      ].filter(d => d.value > 0)
    }
  ]
}))

const modelColumns = [
  { accessorKey: 'model', header: 'Modelo' },
  { accessorKey: 'calls', header: 'Chamadas' },
  { accessorKey: 'totalTokens', header: 'Tokens Totais' },
  { accessorKey: 'providerCostUsd', header: 'Custo (USD)' },
  { id: 'actions', header: '' }
]
</script>

<template>
  <div class="space-y-5">
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <UiStatCard
        label="Custo Operacional Total"
        :value="`$${totalCost.toFixed(4)}`"
        icon="i-lucide-dollar-sign"
        tone="primary"
        :hint="`LLM + Infra + Energia (${period})`"
      />
      <UiStatCard
        label="Volume de Tokens"
        :value="formatCompactNumber(totalTokens)"
        icon="i-lucide-coins"
        tone="info"
        hint="Corpus + Inferência"
      />
      <UiStatCard
        label="Chamadas de Modelo"
        :value="formatCompactNumber(finops?.modelUsage?.calls ?? 0)"
        icon="i-lucide-cpu"
        tone="warning"
        hint="Acumulado do período"
      />
      <UiStatCard
        label="Energia & Pegada ESG"
        :value="`${(finops?.infrastructureEstimate?.energyKwh ?? 0).toFixed(3)} kWh`"
        icon="i-lucide-leaf"
        tone="success"
        :hint="`Custo: $${energyCost.toFixed(4)}`"
      />
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <UCard>
        <template #header>
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h3 class="font-semibold text-sm">Consumo por Modelo</h3>
              <p class="text-xs text-muted">Comparativo de tokens, custo e chamadas</p>
            </div>
            <div class="flex items-center gap-1.5">
              <USelect
                v-model="chartMetric"
                :items="[
                  { label: 'Tokens', value: 'tokens' },
                  { label: 'USD ($)', value: 'usd' },
                  { label: 'Chamadas', value: 'calls' }
                ]"
                size="xs"
                class="w-28"
              />
              <USelect
                v-model="providerFilter"
                :items="providerFilterItems"
                size="xs"
                class="w-40"
              />
            </div>
          </div>
        </template>
        <UiEmptyState v-if="filteredModels.length === 0" compact icon="i-lucide-bar-chart-3" title="Sem execuções de modelo registradas" />
        <EChartBox v-else :option="barChartOption" height="240px" />
      </UCard>

      <UCard>
        <template #header>
          <div>
            <h3 class="font-semibold text-sm">Decomposição de Custos</h3>
            <p class="text-xs text-muted">Inferência LLM vs Infraestrutura vs Energia</p>
          </div>
        </template>
        <UiEmptyState v-if="totalCost <= 0" compact icon="i-lucide-pie-chart" title="Sem custos acumulados no período" />
        <EChartBox v-else :option="donutChartOption" height="240px" />
      </UCard>
    </div>

    <!-- Tabela consolidada de Modelos & Provedores -->
    <UCard>
      <template #header>
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-semibold text-sm">Detalhamento por Modelo</h3>
            <p class="text-xs text-muted">Selecione qualquer modelo para usá-lo como fallback automático de cota.</p>
          </div>
          <UBadge color="neutral" variant="subtle" size="xs">{{ filteredModels.length }} modelos</UBadge>
        </div>
      </template>

      <UiEmptyState v-if="filteredModels.length === 0" compact icon="i-lucide-cpu" title="Nenhum modelo registrado no período" />
      <UTable v-else :data="filteredModels" :columns="modelColumns">
        <template #model-cell="{ row }">
          <div class="flex items-center gap-2">
            <span class="font-mono text-xs font-semibold">{{ row.original.model }}</span>
            <UBadge v-if="row.original.provider" color="neutral" variant="outline" size="xs">{{ row.original.provider }}</UBadge>
          </div>
        </template>
        <template #calls-cell="{ row }">
          <span class="text-xs tabular-nums">{{ row.original.calls ?? 1 }}</span>
        </template>
        <template #totalTokens-cell="{ row }">
          <span class="text-xs tabular-nums">{{ formatCompactNumber(row.original.totalTokens ?? 0) }}</span>
        </template>
        <template #providerCostUsd-cell="{ row }">
          <span class="font-mono text-xs text-primary">${{ (row.original.providerCostUsd ?? 0).toFixed(4) }}</span>
        </template>
        <template #actions-cell="{ row }">
          <UButton
            size="xs"
            variant="ghost"
            icon="i-lucide-arrow-down-right"
            @click="emit('useAsFallback', row.original.model)"
          >
            Usar como Fallback
          </UButton>
        </template>
      </UTable>
    </UCard>
  </div>
</template>

