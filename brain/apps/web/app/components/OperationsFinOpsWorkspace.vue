<script setup lang="ts">
import { z } from 'zod'
import type * as echarts from 'echarts'

const props = defineProps<{
  finops: {
    estimatedLocalTokens: number
    actualProviderUsageAvailable?: boolean
    modelUsage: {
      calls: number
      providerCostUsd?: number | null
      byModel: Array<{
        model: string
        provider?: string
        calls?: number
        totalTokens: number | null
        promptTokens?: number | null
        completionTokens?: number | null
        inputTokens?: number | null
        outputTokens?: number | null
        providerCostUsd: number | null
      }>
    }
    infrastructureEstimate: {
      computeCostUsd?: number
      energyKwh?: number
      energyCostUsd?: number
      totalInfraAndEnergyUsd: number
    }
    departmentQuotas?: Array<{
      department: string
      monthlyTokenLimit: number
      monthlyUsdLimit: number
      usedTokens?: number
      usedUsd?: number
      withinQuota?: boolean
      downgradeModel?: string
      recommendedDowngradeModel?: string
    }>
    pgOperationalActive?: boolean
    pgTemporalActive?: boolean
  } | null
  auditLogs: Array<{
    id?: string
    createdAt?: string
    timestamp?: string
    actorId: string
    actorType?: string
    action: string
    targetType: string
    targetId: string
    accessPolicyId?: string
    metadata?: Record<string, unknown> | null
  }>
}>()

const emit = defineEmits<{
  refresh: []
}>()

const { projectId, apiFetch, notify } = useBrainApi()

const activeTab = ref('overview')
const tabs = computed(() => [
  { label: 'Visão Geral FinOps', value: 'overview', icon: 'i-lucide-activity' },
  { label: 'Consumo ao Vivo (9Router)', value: 'live-usage', icon: 'i-lucide-bar-chart-3', badge: liveUsage.value?.summary?.totalRequests ?? 0 },
  { label: 'Modelos & Provedores', value: 'models', icon: 'i-lucide-cpu', badge: props.finops?.modelUsage?.byModel?.length ?? 0 },
  { label: 'Governança & Cotas', value: 'quotas', icon: 'i-lucide-wallet', badge: props.finops?.departmentQuotas?.length ?? 0 },
  { label: 'Trilha de Auditoria', value: 'audit', icon: 'i-lucide-scroll-text', badge: props.auditLogs.length },
  { label: 'Simulador ROI', value: 'simulator', icon: 'i-lucide-calculator' }
])

const liveUsage = ref<{
  summary: {
    totalRequests: number
    successRequests: number
    failedRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    totalCachedTokens: number
    totalTokens: number
    totalCostUsd: number
    avgLatencyMs: number
    byProvider: Array<{ provider: string; requests: number; totalTokens: number; costUsd: number }>
    byModel: Array<{ provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }>
  }
  logs: Array<{
    id: string
    timestamp: string
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
    latencyMs: number
    status: 'ok' | 'error'
    error?: string
  }>
} | null>(null)
const loadingLiveUsage = ref(false)

async function loadLiveUsage() {
  if (!projectId.value) return
  loadingLiveUsage.value = true
  try {
    liveUsage.value = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/finops/usage-stats?limit=50`) as typeof liveUsage.value
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao carregar consumo ao vivo', 'error')
  } finally {
    loadingLiveUsage.value = false
  }
}

watch([projectId, activeTab], ([, tab]) => {
  if (tab === 'live-usage') loadLiveUsage()
}, { immediate: true })

const period = ref<'7d' | '30d' | '90d' | 'all'>('30d')
const chartMetric = ref<'tokens' | 'usd' | 'calls'>('tokens')
const providerFilter = ref('all')

const models = computed(() => props.finops?.modelUsage?.byModel ?? [])
const providerCost = computed(() => props.finops?.modelUsage?.providerCostUsd ?? 0)
const computeCost = computed(() => props.finops?.infrastructureEstimate?.computeCostUsd ?? 0)
const energyCost = computed(() => props.finops?.infrastructureEstimate?.energyCostUsd ?? 0)
const totalCost = computed(() => Number((providerCost.value + (props.finops?.infrastructureEstimate?.totalInfraAndEnergyUsd ?? 0)).toFixed(4)))

const filteredModels = computed(() => {
  if (providerFilter.value === 'all') return models.value
  return models.value.filter(m => (m.provider || m.model).toLowerCase().includes(providerFilter.value))
})

const totalTokens = computed(() => {
  const measured = models.value.reduce((acc, m) => acc + (m.totalTokens ?? 0), 0)
  return measured > 0 ? measured : (props.finops?.estimatedLocalTokens ?? 0)
})

const quotas = computed(() => props.finops?.departmentQuotas ?? [])

// ECharts: Bar Chart Option
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

// ECharts: Donut Cost Composition
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

// Quota Form with Zod
const quotaSchema = z.object({
  department: z.string().min(2, 'Departamento obrigatório'),
  monthlyTokenLimit: z.number().min(0, 'Mínimo 0'),
  monthlyUsdLimit: z.number().min(0, 'Mínimo 0'),
  downgradeModel: z.string().min(1)
})
const quotaState = reactive({
  department: 'engineering',
  monthlyTokenLimit: 1000000,
  monthlyUsdLimit: 100,
  downgradeModel: 'ollama:qwen2.5-coder:7b'
})
const savingQuota = ref(false)

const downgradeOptions = [
  'ollama:qwen2.5-coder:7b',
  'ollama:llama3.2',
  'deepseek-coder:6.7b',
  'gpt-4o-mini',
  'claude-3-5-haiku'
]

async function onSaveQuota() {
  savingQuota.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/finops/quotas`, {
      method: 'PUT',
      body: JSON.stringify(quotaState)
    })
    notify('Cota FinOps salva', `Departamento ${quotaState.department} atualizado.`)
    emit('refresh')
  } catch (err) {
    notify('Erro ao salvar cota', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingQuota.value = false
  }
}

// Audit Trail Filtering & Inspector
const auditSearch = ref('')
const actorFilter = ref<'all' | 'agent' | 'human'>('all')
const inspectedLog = ref<typeof props.auditLogs[number] | null>(null)

const filteredAuditLogs = computed(() => {
  return props.auditLogs.filter(log => {
    if (actorFilter.value === 'agent' && log.actorType !== 'agent' && !log.actorId.toLowerCase().includes('agent')) return false
    if (actorFilter.value === 'human' && (log.actorType === 'agent' || log.actorId.toLowerCase().includes('agent'))) return false
    if (auditSearch.value) {
      const q = auditSearch.value.toLowerCase()
      return `${log.actorId} ${log.action} ${log.targetType} ${log.targetId}`.toLowerCase().includes(q)
    }
    return true
  })
})

const auditColumns = [
  { accessorKey: 'createdAt', header: 'Quando' },
  { accessorKey: 'actorId', header: 'Ator' },
  { accessorKey: 'action', header: 'Ação' },
  { accessorKey: 'targetType', header: 'Alvo' },
  { accessorKey: 'targetId', header: 'ID' },
  { id: 'actions', header: '' }
]

const modelColumns = [
  { accessorKey: 'model', header: 'Modelo' },
  { accessorKey: 'calls', header: 'Chamadas' },
  { accessorKey: 'totalTokens', header: 'Tokens Totais' },
  { accessorKey: 'providerCostUsd', header: 'Custo ($ USD)' },
  { id: 'actions', header: '' }
]

// Simulator
const simLocalPct = ref(40)
const simCachePct = ref(30)
const simMonthlySavings = computed(() => {
  const base = providerCost.value > 0 ? providerCost.value : 12.5
  const local = base * (simLocalPct.value / 100) * 0.92
  const cache = (base - local) * (simCachePct.value / 100) * 0.65
  return (local + cache).toFixed(2)
})

function formatNumber(n: number) {
  return new Intl.NumberFormat('pt-BR', { notation: n >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n)
}
</script>

<template>
  <div>
    <UiPageHeader
      title="Operação, FinOps & Auditoria"
      description="Telemetria de tokens, custos de provedores LLM, cotas com downgrade automático e trilha RLS"
      icon="i-lucide-activity"
    >
      <template #actions>
        <UBadge :color="finops?.actualProviderUsageAvailable ? 'success' : 'warning'" variant="subtle" size="sm">
          {{ finops?.actualProviderUsageAvailable ? 'Telemetria Ativa' : 'Modo Estimativa Corpus' }}
        </UBadge>
        <UBadge v-if="finops?.pgOperationalActive" color="success" variant="outline" size="sm">RLS Operacional</UBadge>
        <UBadge v-if="finops?.pgTemporalActive" color="primary" variant="outline" size="sm">Temporal Workflows</UBadge>
        <USelect v-model="period" :items="['7d', '30d', '90d', 'all']" size="sm" class="w-24" />
        <UButton size="sm" variant="soft" icon="i-lucide-refresh-cw" @click="emit('refresh')">Atualizar</UButton>
      </template>
    </UiPageHeader>

    <div class="space-y-6">
      <UiSegmentedTabs v-model="activeTab" :items="tabs" />

      <!-- TAB: OVERVIEW -->
      <div v-if="activeTab === 'overview'" class="space-y-6">
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
            :value="formatNumber(totalTokens)"
            icon="i-lucide-coins"
            tone="info"
            hint="Corpus + Inferência"
          />
          <UiStatCard
            label="Chamadas de Modelo"
            :value="formatNumber(finops?.modelUsage?.calls ?? 0)"
            icon="i-lucide-cpu"
            tone="warning"
            hint="Últimos 30 dias"
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
                  <h3 class="font-semibold text-sm">Consumo por Modelo & Provedor</h3>
                  <p class="text-xs text-muted">Comparativo dinâmico de tokens, custo e chamadas</p>
                </div>
                <div class="flex gap-1.5">
                  <USelect v-model="chartMetric" :items="[{ label: 'Tokens', value: 'tokens' }, { label: 'USD ($)', value: 'usd' }, { label: 'Chamadas', value: 'calls' }]" size="xs" />
                  <USelect v-model="providerFilter" :items="['all', 'openai', 'anthropic', 'ollama']" size="xs" />
                </div>
              </div>
            </template>
            <UiEmptyState v-if="filteredModels.length === 0" compact icon="i-lucide-bar-chart-3" title="Sem execuções de modelo registradas" />
            <EChartBox v-else :option="barChartOption" height="250px" />
          </UCard>

          <UCard>
            <template #header>
              <div>
                <h3 class="font-semibold text-sm">Decomposição de Custos Operacionais</h3>
                <p class="text-xs text-muted">Inferência LLM vs Infraestrutura vs Energia</p>
              </div>
            </template>
            <UiEmptyState v-if="totalCost <= 0" compact icon="i-lucide-pie-chart" title="Sem custos acumulados no período" />
            <EChartBox v-else :option="donutChartOption" height="250px" />
          </UCard>
        </div>
      </div>

    <!-- TAB: MODELS -->
    <UCard v-else-if="activeTab === 'models'">
      <UTable :data="models" :columns="modelColumns">
        <template #model-cell="{ row }">
          <span class="font-mono text-xs font-semibold">{{ row.original.model }}</span>
        </template>
        <template #totalTokens-cell="{ row }">
          {{ formatNumber(row.original.totalTokens ?? 0) }}
        </template>
        <template #providerCostUsd-cell="{ row }">
          <span class="font-mono text-primary">${{ (row.original.providerCostUsd ?? 0).toFixed(4) }}</span>
        </template>
        <template #actions-cell="{ row }">
          <UButton
            size="xs"
            variant="ghost"
            @click="quotaState.downgradeModel = row.original.model; activeTab = 'quotas'; notify('Modelo selecionado como fallback')"
          >
            Usar como Fallback
          </UButton>
        </template>
      </UTable>
    </UCard>

    <!-- TAB: QUOTAS -->
    <div v-else-if="activeTab === 'quotas'" class="space-y-6">
      <div v-if="quotas.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <UCard v-for="q in quotas" :key="q.department" variant="subtle">
          <div class="space-y-3">
            <div class="flex items-center justify-between">
              <span class="font-semibold capitalize">{{ q.department }}</span>
              <UBadge :color="q.withinQuota ? 'success' : 'error'" variant="subtle" size="xs">
                {{ q.withinQuota ? 'Em Conformidade' : 'Downgrade Ativo' }}
              </UBadge>
            </div>

            <div>
              <div class="flex justify-between text-xs text-muted mb-1">
                <span>Tokens</span>
                <span>{{ formatNumber(q.usedTokens ?? 0) }} / {{ formatNumber(q.monthlyTokenLimit) }}</span>
              </div>
              <UProgress :model-value="Math.min(100, ((q.usedTokens ?? 0) / Math.max(1, q.monthlyTokenLimit)) * 100)" :color="q.withinQuota ? 'primary' : 'error'" size="sm" />
            </div>

            <div>
              <div class="flex justify-between text-xs text-muted mb-1">
                <span>Orçamento USD</span>
                <span>${{ (q.usedUsd ?? 0).toFixed(2) }} / ${{ q.monthlyUsdLimit.toFixed(2) }}</span>
              </div>
              <UProgress :model-value="Math.min(100, ((q.usedUsd ?? 0) / Math.max(1, q.monthlyUsdLimit)) * 100)" color="success" size="sm" />
            </div>

            <div class="text-xs text-muted flex justify-between pt-2 border-t border-default">
              <span>Fallback:</span>
              <code class="text-xs">{{ q.downgradeModel || q.recommendedDowngradeModel || 'ollama:qwen2.5-coder:7b' }}</code>
            </div>
          </div>
        </UCard>
      </div>

      <UCard>
        <template #header>
          <h3 class="font-semibold text-sm">Configurar Cota por Departamento (Validação Zod)</h3>
        </template>
        <UForm :schema="quotaSchema" :state="quotaState" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4" @submit="onSaveQuota">
          <UFormField label="Departamento" name="department">
            <UInput v-model="quotaState.department" placeholder="engineering" class="w-full" />
          </UFormField>
          <UFormField label="Limite Mensal de Tokens" name="monthlyTokenLimit">
            <UInput v-model.number="quotaState.monthlyTokenLimit" type="number" class="w-full" />
          </UFormField>
          <UFormField label="Limite Mensal (USD)" name="monthlyUsdLimit">
            <UInput v-model.number="quotaState.monthlyUsdLimit" type="number" step="0.01" class="w-full" />
          </UFormField>
          <UFormField label="Modelo de Downgrade" name="downgradeModel">
            <USelect v-model="quotaState.downgradeModel" :items="downgradeOptions" class="w-full" />
          </UFormField>
          <div class="sm:col-span-2 lg:col-span-4 flex justify-end">
            <UButton type="submit" :loading="savingQuota" icon="i-lucide-save">Salvar Cota</UButton>
          </div>
        </UForm>
      </UCard>
    </div>

    <!-- TAB: AUDIT TRAIL -->
    <UCard v-else-if="activeTab === 'audit'">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <UInput v-model="auditSearch" placeholder="Filtrar por ator, ação ou alvo..." icon="i-lucide-search" class="w-72" size="sm" />
          <div class="flex gap-1.5">
            <UButton size="xs" :variant="actorFilter === 'all' ? 'solid' : 'ghost'" @click="actorFilter = 'all'">Todos</UButton>
            <UButton size="xs" :variant="actorFilter === 'agent' ? 'solid' : 'ghost'" icon="i-lucide-bot" @click="actorFilter = 'agent'">Agentes</UButton>
            <UButton size="xs" :variant="actorFilter === 'human' ? 'solid' : 'ghost'" icon="i-lucide-user" @click="actorFilter = 'human'">Humanos</UButton>
          </div>
        </div>
      </template>

      <UTable :data="filteredAuditLogs" :columns="auditColumns">
        <template #createdAt-cell="{ row }">
          <span class="text-xs text-muted">{{ new Date(row.original.createdAt || row.original.timestamp || '').toLocaleString('pt-BR') }}</span>
        </template>
        <template #action-cell="{ row }">
          <UBadge :color="/delete|reject|revoke/i.test(row.original.action) ? 'error' : /create|approve/i.test(row.original.action) ? 'success' : 'primary'" variant="subtle" size="xs">
            {{ row.original.action }}
          </UBadge>
        </template>
        <template #actions-cell="{ row }">
          <UButton size="xs" variant="ghost" @click="inspectedLog = row.original">Inspecionar</UButton>
        </template>
      </UTable>
    </UCard>

    <!-- TAB: LIVE USAGE (9Router Style) -->
    <div v-else-if="activeTab === 'live-usage'" class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-sm font-semibold">Telemetria de Consumo de Tokens (9Router)</h3>
          <p class="text-xs text-muted">Contabilização em tempo real por provedor, modelo, latência e custo USD calculado por token.</p>
        </div>
        <UButton size="xs" variant="outline" icon="i-lucide-refresh-cw" :loading="loadingLiveUsage" @click="loadLiveUsage">
          Atualizar
        </UButton>
      </div>

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <UCard variant="subtle">
          <div class="text-xs text-muted">Requisições</div>
          <div class="text-2xl font-bold mt-1">{{ liveUsage?.summary?.totalRequests ?? 0 }}</div>
          <div class="text-[11px] text-muted mt-1">
            {{ liveUsage?.summary?.successRequests ?? 0 }} OK · {{ liveUsage?.summary?.failedRequests ?? 0 }} erro(s)
          </div>
        </UCard>
        <UCard variant="subtle">
          <div class="text-xs text-muted">Tokens Totais</div>
          <div class="text-2xl font-bold mt-1">{{ (liveUsage?.summary?.totalTokens ?? 0).toLocaleString() }}</div>
          <div class="text-[11px] text-muted mt-1">
            In: {{ (liveUsage?.summary?.totalInputTokens ?? 0).toLocaleString() }} · Out: {{ (liveUsage?.summary?.totalOutputTokens ?? 0).toLocaleString() }}
          </div>
        </UCard>
        <UCard variant="subtle">
          <div class="text-xs text-muted">Custo Estimado (USD)</div>
          <div class="text-2xl font-bold text-primary mt-1">${{ (liveUsage?.summary?.totalCostUsd ?? 0).toFixed(4) }}</div>
          <div class="text-[11px] text-muted mt-1">Tabela de preços por modelo</div>
        </UCard>
        <UCard variant="subtle">
          <div class="text-xs text-muted">Latência Média</div>
          <div class="text-2xl font-bold mt-1">{{ liveUsage?.summary?.avgLatencyMs ?? 0 }}ms</div>
          <div class="text-[11px] text-muted mt-1">Por chamada ao Runner</div>
        </UCard>
      </div>

      <UCard v-if="(liveUsage?.summary?.byModel?.length ?? 0) > 0">
        <template #header>
          <h4 class="text-sm font-semibold">Consumo por Provedor / Modelo</h4>
        </template>
        <div class="space-y-2">
          <div v-for="m in liveUsage?.summary?.byModel" :key="`${m.provider}/${m.model}`" class="flex items-center justify-between text-xs p-2 rounded border border-default">
            <div class="flex items-center gap-2">
              <code class="font-mono bg-elevated px-1.5 py-0.5 rounded">{{ m.provider }}/{{ m.model }}</code>
              <UBadge color="neutral" variant="subtle" size="xs">{{ m.requests }} req(s)</UBadge>
            </div>
            <div class="flex items-center gap-4 font-mono">
              <span>{{ m.totalTokens.toLocaleString() }} tok</span>
              <span class="text-primary">${{ m.costUsd.toFixed(4) }}</span>
            </div>
          </div>
        </div>
      </UCard>

      <UCard>
        <template #header>
          <h4 class="text-sm font-semibold">Histórico Recente de Requisições</h4>
        </template>
        <div v-if="(liveUsage?.logs?.length ?? 0) === 0" class="text-xs text-muted py-4 text-center">
          Nenhuma chamada registrada nesta sessão do Runner ainda.
        </div>
        <div v-else class="space-y-1.5 max-h-80 overflow-y-auto">
          <div v-for="log in liveUsage?.logs" :key="log.id" class="flex flex-wrap items-center justify-between gap-2 text-xs p-2 rounded border border-default">
            <div class="flex items-center gap-2 min-w-0">
              <UBadge :color="log.status === 'ok' ? 'success' : 'error'" variant="soft" size="xs">{{ log.status.toUpperCase() }}</UBadge>
              <code class="font-mono truncate">{{ log.provider }}/{{ log.model }}</code>
              <span class="text-muted text-[11px]">{{ new Date(log.timestamp).toLocaleTimeString() }}</span>
            </div>
            <div class="flex items-center gap-3 font-mono text-[11px]">
              <span>{{ log.inputTokens }}→{{ log.outputTokens }} ({{ log.totalTokens }})</span>
              <span>{{ log.latencyMs }}ms</span>
              <span class="text-primary">${{ log.costUsd.toFixed(4) }}</span>
            </div>
          </div>
        </div>
      </UCard>
    </div>

    <!-- TAB: SIMULATOR -->
    <UCard v-else-if="activeTab === 'simulator'">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div class="space-y-6">
          <div>
            <div class="flex justify-between text-sm font-medium mb-2">
              <span>Roteamento para Modelos Locais (Ollama / vLLM)</span>
              <span class="text-primary font-bold">{{ simLocalPct }}%</span>
            </div>
            <USlider v-model="simLocalPct" :min="0" :max="100" />
          </div>
          <div>
            <div class="flex justify-between text-sm font-medium mb-2">
              <span>Adoção de Prompt Caching</span>
              <span class="text-info font-bold">{{ simCachePct }}%</span>
            </div>
            <USlider v-model="simCachePct" :min="0" :max="80" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <UCard variant="subtle">
            <div class="text-xs text-muted">Economia Mensal Projetada</div>
            <div class="text-3xl font-bold text-success mt-1">${{ simMonthlySavings }}</div>
          </UCard>
          <UCard variant="subtle">
            <div class="text-xs text-muted">Economia Anual Projetada</div>
            <div class="text-3xl font-bold text-primary mt-1">${{ (Number(simMonthlySavings) * 12).toFixed(2) }}</div>
          </UCard>
        </div>
      </div>
    </UCard>

    <!-- Slideover: Audit JSON Inspector -->
    <USlideover :open="Boolean(inspectedLog)" title="Detalhes do Evento de Auditoria" @update:open="val => { if (!val) inspectedLog = null }">
      <template #body>
        <pre v-if="inspectedLog" class="text-xs font-mono bg-slate-950 p-4 rounded-lg border border-default overflow-auto">{{ JSON.stringify(inspectedLog, null, 2) }}</pre>
      </template>
    </USlideover>
    </div>
  </div>
</template>

