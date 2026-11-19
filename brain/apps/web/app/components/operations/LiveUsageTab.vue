<script setup lang="ts">
import type { LiveUsageData } from './types'

const props = defineProps<{
  liveUsage: LiveUsageData | null
  loading: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

const statusFilter = ref<'all' | 'ok' | 'error'>('all')
const searchQuery = ref('')

const filteredLogs = computed(() => {
  const logs = props.liveUsage?.logs ?? []
  const q = searchQuery.value.trim().toLowerCase()
  return logs.filter((l) => {
    if (statusFilter.value !== 'all' && l.status !== statusFilter.value) return false
    if (!q) return true
    return `${l.provider}/${l.model}`.toLowerCase().includes(q)
  })
})
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h3 class="text-sm font-semibold">Telemetria de Consumo ao Vivo</h3>
        <p class="text-xs text-muted">Contabilização em tempo real por provedor, modelo, latência e custo USD.</p>
      </div>
      <UButton size="xs" variant="outline" icon="i-lucide-refresh-cw" :loading="loading" @click="emit('refresh')">
        Atualizar
      </UButton>
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <UiStatCard
        label="Requisições"
        :value="liveUsage?.summary?.totalRequests ?? 0"
        icon="i-lucide-activity"
        tone="primary"
        :hint="`${liveUsage?.summary?.successRequests ?? 0} OK · ${liveUsage?.summary?.failedRequests ?? 0} erro(s)`"
        :loading="loading"
      />
      <UiStatCard
        label="Tokens Totais"
        :value="(liveUsage?.summary?.totalTokens ?? 0).toLocaleString('pt-BR')"
        icon="i-lucide-coins"
        tone="info"
        :hint="`In: ${(liveUsage?.summary?.totalInputTokens ?? 0).toLocaleString('pt-BR')} · Out: ${(liveUsage?.summary?.totalOutputTokens ?? 0).toLocaleString('pt-BR')}`"
        :loading="loading"
      />
      <UiStatCard
        label="Custo Estimado (USD)"
        :value="`$${(liveUsage?.summary?.totalCostUsd ?? 0).toFixed(4)}`"
        icon="i-lucide-dollar-sign"
        tone="success"
        hint="Tabela de preços por modelo"
        :loading="loading"
      />
      <UiStatCard
        label="Latência Média"
        :value="`${liveUsage?.summary?.avgLatencyMs ?? 0}ms`"
        icon="i-lucide-gauge"
        tone="warning"
        hint="Por chamada ao Runner"
        :loading="loading"
      />
    </div>

    <UCard v-if="(liveUsage?.summary?.byModel?.length ?? 0) > 0">
      <template #header>
        <h4 class="text-sm font-semibold">Consumo por Provedor / Modelo</h4>
      </template>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div
          v-for="m in liveUsage?.summary?.byModel"
          :key="`${m.provider}/${m.model}`"
          class="flex items-center justify-between text-xs p-2.5 rounded-lg border border-default bg-default"
        >
          <div class="flex items-center gap-2 min-w-0">
            <code class="font-mono bg-elevated px-1.5 py-0.5 rounded truncate">{{ m.provider }}/{{ m.model }}</code>
            <UBadge color="neutral" variant="subtle" size="xs">{{ m.requests }} req</UBadge>
          </div>
          <div class="flex items-center gap-3 font-mono shrink-0">
            <span>{{ m.totalTokens.toLocaleString('pt-BR') }} tok</span>
            <span class="text-primary">${{ m.costUsd.toFixed(4) }}</span>
          </div>
        </div>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h4 class="text-sm font-semibold">Histórico Recente de Requisições</h4>
          <div class="flex flex-wrap items-center gap-2">
            <UInput v-model="searchQuery" size="xs" icon="i-lucide-search" placeholder="Filtrar modelo..." class="w-44" />
            <UiSegmentedTabs
              v-model="statusFilter"
              :items="[
                { label: 'Todas', value: 'all' },
                { label: 'OK', value: 'ok' },
                { label: 'Erros', value: 'error' }
              ]"
            />
          </div>
        </div>
      </template>

      <UiEmptyState
        v-if="filteredLogs.length === 0"
        compact
        icon="i-lucide-activity"
        title="Nenhuma chamada registrada"
        description="As chamadas ao Chat ou Execuções do Runner aparecerão aqui em tempo real."
      />
      <div v-else class="space-y-1.5 max-h-80 overflow-y-auto pr-1">
        <div
          v-for="log in filteredLogs"
          :key="log.id"
          class="flex flex-wrap items-center justify-between gap-2 text-xs p-2.5 rounded-lg border border-default"
        >
          <div class="flex items-center gap-2 min-w-0">
            <UBadge :color="log.status === 'ok' ? 'success' : 'error'" variant="soft" size="xs">
              {{ log.status.toUpperCase() }}
            </UBadge>
            <code class="font-mono truncate">{{ log.provider }}/{{ log.model }}</code>
            <span class="text-muted text-[11px]">{{ new Date(log.timestamp).toLocaleTimeString('pt-BR') }}</span>
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
</template>

