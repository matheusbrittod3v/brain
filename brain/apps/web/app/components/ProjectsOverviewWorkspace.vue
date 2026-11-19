<script setup lang="ts">
import type * as echarts from 'echarts'
import DailyChangesModal from './daily/DailyChangesModal.vue'
import InteractiveTourModal from './daily/InteractiveTourModal.vue'

const props = defineProps<{
  projectId: string
  projectsList?: Array<{ projectId: string; name: string; description?: string; isShared?: boolean }>
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

const { apiFetch, notify, hasPermission, liveSyncTick, triggerLiveRefresh } = useBrainApi()

const currentProject = computed(() =>
  props.projectsList?.find(p => p.projectId === props.projectId)
)

const togglingShare = ref(false)
const sharedCatalog = ref<Array<{
  projectId: string
  name: string
  description?: string
  isShared: boolean
  counts?: { total: number; skills: number; rules: number; specs: number }
}>>([])

const isCurrentShared = computed(() =>
  Boolean(currentProject.value?.isShared || sharedCatalog.value.some(s => s.projectId === props.projectId))
)

async function loadSharedProjects() {
  if (!hasPermission('projects:shared:read')) {
    sharedCatalog.value = []
    return
  }
  try {
    const res = await apiFetch<{ projects?: typeof sharedCatalog.value }>('/v1/projects/shared')
    sharedCatalog.value = res.projects ?? []
  } catch {
    sharedCatalog.value = []
  }
}

async function toggleProjectShared() {
  if (!props.projectId) return
  togglingShare.value = true
  try {
    const nextShared = !isCurrentShared.value
    await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/share`, {
      method: 'PUT',
      body: JSON.stringify({ isShared: nextShared })
    })
    notify(
      nextShared ? 'Projeto marcado como compartilhável!' : 'Compartilhamento global desativado',
      nextShared
        ? `Skills, regras e dados de '${props.projectId}' agora são reutilizáveis entre projetos e agentes MCP.`
        : `O projeto '${props.projectId}' voltou ao escopo isolado.`,
      'success'
    )
    await loadSharedProjects()
    emit('refresh')
  } catch (err) {
    notify('Erro ao atualizar compartilhamento', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    togglingShare.value = false
  }
}

onMounted(loadSharedProjects)
watch([() => props.projectId, liveSyncTick], loadSharedProjects)

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

const onboardingOpen = ref(false)
const loadingOnboarding = ref(false)
const onboardingGuide = ref<any>(null)
const dailyChangesOpen = ref(false)
const interactiveTourOpen = ref(false)
const editProjectOpen = ref(false)
const savingProject = ref(false)
const editForm = reactive({
  name: '',
  description: '',
  knowledgeRoot: '.brain/',
  isShared: false
})
const deleteProjectOpen = ref(false)
const deletingProject = ref(false)
const deleteConfirmSlug = ref('')

function openEditProject() {
  editForm.name = currentProject.value?.name || props.projectId
  editForm.description = currentProject.value?.description || ''
  editForm.knowledgeRoot = '.brain/'
  editForm.isShared = isCurrentShared.value
  editProjectOpen.value = true
}

async function saveProjectEdit() {
  if (!props.projectId || !editForm.name.trim()) return
  savingProject.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: editForm.name.trim(),
        description: editForm.description.trim(),
        knowledgeRoot: editForm.knowledgeRoot.trim() || '.brain/',
        ...(hasPermission('projects:share') ? { isShared: editForm.isShared } : {})
      })
    })
    notify('Projeto atualizado', editForm.name.trim(), 'success')
    editProjectOpen.value = false
    triggerLiveRefresh()
    emit('refresh')
  } catch (err) {
    notify('Erro ao editar projeto', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingProject.value = false
  }
}

async function confirmDeleteProject() {
  if (!props.projectId || deleteConfirmSlug.value.trim() !== props.projectId) return
  deletingProject.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}`, { method: 'DELETE' })
    notify('Projeto excluído', props.projectId, 'warning')
    deleteProjectOpen.value = false
    deleteConfirmSlug.value = ''
    triggerLiveRefresh()
    emit('refresh')
  } catch (err) {
    notify('Erro ao excluir projeto', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    deletingProject.value = false
  }
}

async function openOnboarding() {
  onboardingOpen.value = true
  if (!onboardingGuide.value) {
    loadingOnboarding.value = true
    try {
      onboardingGuide.value = await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/intelligence/onboarding-guide`)
    } catch (err) {
      notify('Erro ao carregar onboarding', err instanceof Error ? err.message : String(err), 'error')
    } finally {
      loadingOnboarding.value = false
    }
  }
}
</script>

<template>
  <div class="space-y-5">
    <UiPageHeader
      :title="`Visão Geral — ${currentProject?.name || projectId}`"
      :description="currentProject?.description || 'Resumo executivo de conhecimento, saúde arquitetural, Runner e governança do projeto'"
      icon="i-lucide-folder-git-2"
    >
      <template #actions>
        <UButton
          v-if="projectId && hasPermission('projects:edit')"
          size="sm"
          variant="soft"
          color="neutral"
          icon="i-lucide-pencil"
          @click="openEditProject"
        >
          Editar
        </UButton>
        <UButton
          v-if="projectId && hasPermission('projects:delete')"
          size="sm"
          variant="soft"
          color="error"
          icon="i-lucide-trash-2"
          @click="deleteConfirmSlug = ''; deleteProjectOpen = true"
        >
          Excluir
        </UButton>
        <UButton
          v-if="projectId && hasPermission('projects:share')"
          size="sm"
          :color="isCurrentShared ? 'success' : 'neutral'"
          :variant="isCurrentShared ? 'soft' : 'outline'"
          :icon="isCurrentShared ? 'i-lucide-globe' : 'i-lucide-share-2'"
          :loading="togglingShare"
          @click="toggleProjectShared"
        >
          {{ isCurrentShared ? 'Compartilhável Global (Ativo)' : 'Tornar Compartilhável (Global MCP)' }}
        </UButton>
        <UButton
          size="sm"
          variant="soft"
          color="warning"
          icon="i-lucide-history"
          @click="dailyChangesOpen = true"
        >
          O Que Mudou?
        </UButton>
        <UButton
          size="sm"
          variant="soft"
          color="neutral"
          icon="i-lucide-compass"
          @click="interactiveTourOpen = true"
        >
          Tour Interativo
        </UButton>
        <UButton
          size="sm"
          variant="soft"
          color="primary"
          icon="i-lucide-book-open"
          :loading="loadingOnboarding"
          @click="openOnboarding"
        >
          Guia de Onboarding
        </UButton>
        <UButton size="sm" variant="soft" icon="i-lucide-folder-plus" @click="emit('newProject')">
          Novo Projeto
        </UButton>
        <UButton size="sm" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="emit('refresh')">
          Atualizar
        </UButton>
      </template>
    </UiPageHeader>

    <UCard v-if="sharedCatalog.length > 0" class="border border-default">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-globe" class="size-4 text-success" />
          <h3 class="text-sm font-semibold text-highlighted">Projetos Compartilháveis &amp; Reutilizáveis (Global MCP)</h3>
          <UBadge color="success" variant="subtle" size="xs">{{ sharedCatalog.length }}</UBadge>
        </div>
        <span class="text-xs text-muted">
          Skills, regras e especificações abaixo ficam disponíveis globalmente entre projetos e agentes MCP.
        </span>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <div
          v-for="sp in sharedCatalog"
          :key="sp.projectId"
          class="rounded-xl border border-default bg-elevated/40 p-3 flex flex-col justify-between gap-2"
        >
          <div>
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-mono font-semibold text-highlighted">{{ sp.projectId }}</span>
              <UBadge color="success" variant="subtle" size="xs">Global MCP</UBadge>
            </div>
            <div class="text-xs font-medium text-default mt-0.5">{{ sp.name }}</div>
            <p v-if="sp.description" class="text-[11px] text-muted mt-0.5 line-clamp-2">{{ sp.description }}</p>
          </div>
          <div class="flex items-center gap-2 flex-wrap pt-2 border-t border-default/60 text-[11px] text-muted">
            <UBadge color="primary" variant="subtle" size="xs">{{ sp.counts?.skills ?? 0 }} skills</UBadge>
            <UBadge color="neutral" variant="subtle" size="xs">{{ sp.counts?.rules ?? 0 }} regras</UBadge>
            <UBadge color="neutral" variant="subtle" size="xs">{{ sp.counts?.specs ?? 0 }} specs/ADRs</UBadge>
          </div>
        </div>
      </div>
    </UCard>

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

    <!-- Modal de Onboarding de Projeto -->
    <UModal v-model:open="onboardingOpen" :title="onboardingGuide?.title || 'Guia de Onboarding do Projeto'" class="max-w-2xl">
      <template #body>
        <div v-if="loadingOnboarding" class="p-8 text-center text-xs text-muted">Gerando guia de onboarding...</div>
        <div v-else-if="onboardingGuide" class="space-y-4 max-h-[70vh] overflow-y-auto">
          <div v-for="(sec, idx) in onboardingGuide.sections" :key="idx" class="p-4 rounded-xl border border-default bg-elevated/40 space-y-2">
            <h4 class="font-semibold text-xs text-primary">{{ sec.title }}</h4>
            <p v-if="sec.content" class="text-xs text-highlighted whitespace-pre-wrap">{{ sec.content }}</p>
            <ul v-if="sec.items" class="space-y-1">
              <li v-for="it in sec.items" :key="it.id" class="text-xs flex items-center justify-between">
                <span>{{ it.title || it.id }}</span>
                <UBadge v-if="it.status" color="neutral" variant="outline" size="xs">{{ it.status }}</UBadge>
              </li>
            </ul>
            <ol v-if="sec.steps" class="list-decimal pl-4 space-y-1">
              <li v-for="(st, sIdx) in sec.steps" :key="sIdx" class="text-xs text-highlighted">{{ st }}</li>
            </ol>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Modais de Mudanças Diárias e Tour Interativo -->
    <DailyChangesModal v-model:open="dailyChangesOpen" :project-id="projectId" />
    <InteractiveTourModal v-model:open="interactiveTourOpen" :project-id="projectId" />

    <UModal v-model:open="editProjectOpen" :title="`Editar Projeto — ${projectId}`">
      <template #body>
        <div class="space-y-3">
          <UFormField label="Nome do Projeto">
            <UInput v-model="editForm.name" class="w-full" />
          </UFormField>
          <UFormField label="Descrição">
            <UTextarea v-model="editForm.description" :rows="2" class="w-full" />
          </UFormField>
          <UFormField label="Pasta de Conhecimento">
            <UInput v-model="editForm.knowledgeRoot" class="w-full font-mono text-xs" />
          </UFormField>
          <label v-if="hasPermission('projects:share')" class="flex items-center gap-2 text-xs text-highlighted cursor-pointer">
            <input v-model="editForm.isShared" type="checkbox" class="rounded border-default" />
            Compartilhável Global (consultável por outros projetos e agentes MCP)
          </label>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="ghost" @click="editProjectOpen = false">Cancelar</UButton>
          <UButton color="primary" :loading="savingProject" @click="saveProjectEdit">Salvar</UButton>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="deleteProjectOpen" :title="`Excluir Projeto — ${projectId}`">
      <template #body>
        <div class="space-y-3 text-xs">
          <UAlert
            color="error"
            variant="subtle"
            icon="i-lucide-alert-triangle"
            title="Ação permanente"
            :description="`Digite '${projectId}' abaixo para confirmar a exclusão do projeto.`"
          />
          <UInput v-model="deleteConfirmSlug" :placeholder="projectId" class="w-full font-mono" />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="ghost" @click="deleteProjectOpen = false">Cancelar</UButton>
          <UButton
            color="error"
            :disabled="deleteConfirmSlug.trim() !== projectId"
            :loading="deletingProject"
            @click="confirmDeleteProject"
          >
            Excluir Definitivamente
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
