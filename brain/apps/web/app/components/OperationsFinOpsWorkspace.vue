<script setup lang="ts">
import type { AuditLogItem, FinOpsData, LiveUsageData } from './operations/types'

const props = defineProps<{
  finops: FinOpsData | null
  auditLogs: AuditLogItem[]
}>()

const emit = defineEmits<{
  refresh: []
}>()

const { projectId, apiFetch, notify } = useBrainApi()

const activeTab = ref<'overview' | 'health-doctor' | 'live-usage' | 'quotas' | 'audit'>('overview')
const period = ref<'7d' | '30d' | '90d' | 'all'>('30d')
const selectedDowngradeModel = ref<string | undefined>(undefined)

const liveUsage = ref<LiveUsageData | null>(null)
const loadingLiveUsage = ref(false)

const periodOptions = [
  { label: 'Últimos 7 dias', value: '7d' },
  { label: 'Últimos 30 dias', value: '30d' },
  { label: 'Últimos 90 dias', value: '90d' },
  { label: 'Todo o período', value: 'all' }
]

const tabs = computed(() => [
  { label: 'Visão Geral & Modelos', value: 'overview', icon: 'i-lucide-activity' },
  { label: 'Saúde, Conectores & Doctor', value: 'health-doctor', icon: 'i-lucide-stethoscope' },
  { label: 'Consumo ao Vivo', value: 'live-usage', icon: 'i-lucide-bar-chart-3', badge: liveUsage.value?.summary?.totalRequests || undefined },
  { label: 'Cotas & Simulador ROI', value: 'quotas', icon: 'i-lucide-wallet', badge: props.finops?.departmentQuotas?.length || undefined },
  { label: 'Trilha de Auditoria', value: 'audit', icon: 'i-lucide-scroll-text', badge: props.auditLogs.length || undefined }
])

async function loadLiveUsage() {
  if (!projectId.value) return
  loadingLiveUsage.value = true
  try {
    liveUsage.value = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/finops/usage-stats?limit=50`) as LiveUsageData
  } catch (err) {
    notify('Erro ao carregar consumo ao vivo', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loadingLiveUsage.value = false
  }
}

watch([projectId, activeTab], ([, tab]) => {
  if (tab === 'live-usage') loadLiveUsage()
}, { immediate: true })

function handleUseAsFallback(model: string) {
  selectedDowngradeModel.value = model
  activeTab.value = 'quotas'
  notify('Modelo selecionado como fallback', model, 'primary')
}
</script>

<template>
  <div class="space-y-5">
    <UiPageHeader
      title="Operação, FinOps & Auditoria"
      description="Telemetria de tokens, custos de provedores LLM, cotas com downgrade automático e trilha RLS"
      icon="i-lucide-activity"
    >
      <template #actions>
        <UBadge :color="finops?.actualProviderUsageAvailable ? 'success' : 'warning'" variant="subtle" size="sm">
          {{ finops?.actualProviderUsageAvailable ? 'Telemetria Ativa' : 'Estimativa Corpus' }}
        </UBadge>
        <UBadge v-if="finops?.pgOperationalActive" color="success" variant="outline" size="sm">
          RLS Ativo
        </UBadge>
        <USelect v-model="period" :items="periodOptions" size="sm" class="w-40" />
        <UButton size="sm" variant="ghost" icon="i-lucide-refresh-cw" @click="emit('refresh')">
          Atualizar
        </UButton>
      </template>
    </UiPageHeader>

    <UiSegmentedTabs v-model="activeTab" :items="tabs" />

    <OperationsOverviewTab
      v-if="activeTab === 'overview'"
      :finops="finops"
      :period="period"
      @use-as-fallback="handleUseAsFallback"
    />

    <OperationsHealthConnectorsDoctorTab
      v-else-if="activeTab === 'health-doctor'"
    />

    <OperationsLiveUsageTab
      v-else-if="activeTab === 'live-usage'"
      :live-usage="liveUsage"
      :loading="loadingLiveUsage"
      @refresh="loadLiveUsage"
    />

    <OperationsQuotasTab
      v-else-if="activeTab === 'quotas'"
      :quotas="finops?.departmentQuotas ?? []"
      :provider-cost="finops?.modelUsage?.providerCostUsd ?? 0"
      :initial-downgrade-model="selectedDowngradeModel"
      @refresh="emit('refresh')"
    />

    <OperationsAuditTab
      v-else
      :audit-logs="auditLogs"
    />
  </div>
</template>
