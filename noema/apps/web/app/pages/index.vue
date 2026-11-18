<script setup lang="ts">
import { z } from 'zod'
import type * as echarts from 'echarts'

const {
  apiKey,
  projectId,
  currentUser,
  authModalOpen,
  authModalTab,
  apiFetch,
  notify,
  refreshAuthSession,
  hasPermission
} = useNoemaApi()

const workspace = ref<'projects' | 'inbox' | 'knowledge' | 'search' | 'agents' | 'impact' | 'operations' | 'access' | 'enterprise'>('projects')
const sidebarCollapsed = ref(false)
const paletteOpen = ref(false)
const newProjectOpen = ref(false)
const loadingData = ref(false)

// Data states
const projectsList = ref<Array<{ projectId: string; name: string; description?: string }>>([])
const overviewData = ref<{
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
} | null>(null)
const proposalsList = ref<Array<{
  id: string
  title?: string
  type?: string
  status: string
  version?: number
  accessPolicyId?: string
  content?: string
  assignedTo?: string
  dueAt?: string
  overdue?: boolean
}>>([])
const knowledgeItems = ref<Array<{ id: string; title: string; type: string; status: string; accessPolicyId: string; content: string }>>([])
const runnerTasks = ref<Array<{ taskId: string; instruction: string; status: string; priority: string; createdAt?: string }>>([])
const finopsData = ref<any>(null)
const auditLogs = ref<any[]>([])
const inspectedKnowledge = ref<{ title: string; content: string; type: string; status: string } | null>(null)

const searchQuery = ref('')
const knowledgeTypeFilter = ref('all')

// Load all workspace data
async function loadWorkspaceData() {
  await refreshAuthSession()
  if (!apiKey.value) return
  loadingData.value = true
  const pid = encodeURIComponent(projectId.value)

  try {
    const pRes = await apiFetch<{ projects: Array<{ projectId: string; name: string; description?: string }> }>('/v1/projects')
    projectsList.value = pRes.projects ?? []
    if (projectsList.value.length > 0 && !projectsList.value.some(p => p.projectId === projectId.value)) {
      const firstProj = projectsList.value[0]
      if (firstProj) projectId.value = firstProj.projectId
    }
  } catch { /* ignore */ }

  const activePid = encodeURIComponent(projectId.value)
  await Promise.allSettled([
    apiFetch(`/v1/projects/${activePid}/overview`).then((d: any) => { overviewData.value = d }),
    apiFetch(`/v1/projects/${activePid}/proposals`).then((d: any) => { proposalsList.value = d.proposals ?? [] }),
    apiFetch(`/v1/projects/${activePid}/search`, {
      method: 'POST',
      body: JSON.stringify({ query: searchQuery.value.trim(), limit: 50 })
    }).then((d: any) => {
      knowledgeItems.value = d.items ?? []
    }),
    apiFetch(`/v1/projects/${activePid}/runner/tasks`).then((d: any) => { runnerTasks.value = d.tasks ?? [] }),
    apiFetch(`/v1/projects/${activePid}/finops`).then((d: any) => { finopsData.value = d }),
    apiFetch(`/v1/audit-logs?projectId=${activePid}&limit=100`).then((d: any) => { auditLogs.value = d.logs ?? [] })
  ])
  loadingData.value = false
}

onMounted(loadWorkspaceData)

watch([projectId, apiKey], () => {
  if (import.meta.client) localStorage.setItem('noema.projectId', projectId.value)
  loadWorkspaceData()
})

const filteredKnowledge = computed(() => {
  if (knowledgeTypeFilter.value === 'all') return knowledgeItems.value
  return knowledgeItems.value.filter(k => k.type === knowledgeTypeFilter.value)
})

const knowledgeTypes = computed(() => ['all', ...new Set(knowledgeItems.value.map(k => k.type))])

const overviewTypeChartOption = computed<echarts.EChartsOption>(() => {
  const entries = Object.entries(overviewData.value?.summary?.byType ?? {})
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

// Navigation Items gated by menu:* permissions
type WorkspaceKey = typeof workspace.value
const allNavItems = computed<Array<{ id: WorkspaceKey; label: string; icon: string; permission: string; badge?: number }>>(() => [
  { id: 'projects', label: 'Projetos & Visão Geral', icon: 'i-lucide-folder-git-2', permission: 'menu:projects' },
  { id: 'inbox', label: 'Caixa de Entrada', icon: 'i-lucide-inbox', permission: 'menu:inbox', badge: proposalsList.value.length || undefined },
  { id: 'knowledge', label: 'Conhecimento', icon: 'i-lucide-file-text', permission: 'menu:knowledge' },
  { id: 'search', label: 'Busca & Grafo', icon: 'i-lucide-network', permission: 'menu:search' },
  { id: 'agents', label: 'Agentes & Runner', icon: 'i-lucide-bot', permission: 'menu:agents' },
  { id: 'impact', label: 'Análise de Impacto', icon: 'i-lucide-zap', permission: 'menu:impact' },
  { id: 'operations', label: 'Operação & FinOps', icon: 'i-lucide-activity', permission: 'menu:operations' },
  { id: 'access', label: 'Acesso & Políticas', icon: 'i-lucide-shield', permission: 'menu:access' },
  { id: 'enterprise', label: 'Visões Corporativas', icon: 'i-lucide-radar', permission: 'menu:enterprise' }
])

const navItems = computed(() => {
  const permitted = allNavItems.value.filter(item => hasPermission(item.permission))
  return permitted.length > 0 ? permitted : [allNavItems.value[0]!]
})

watch(navItems, (items) => {
  if (items.length > 0 && !items.some(i => i.id === workspace.value)) {
    workspace.value = items[0]!.id
  }
})

const navMenuItems = computed(() => [
  navItems.value.map(item => ({
    label: item.label,
    icon: item.icon,
    badge: item.badge,
    active: workspace.value === item.id,
    onSelect: () => {
      workspace.value = item.id
    }
  }))
])

const commandGroups = computed(() => [
  {
    id: 'navigation',
    label: 'Navegação',
    items: navItems.value.map(n => ({
      label: n.label,
      icon: n.icon,
      onSelect: () => {
        workspace.value = n.id
        paletteOpen.value = false
      }
    }))
  },
  {
    id: 'actions',
    label: 'Ações Rápidas',
    items: [
      {
        label: 'Conectar Agente / MCP (OAuth2)',
        icon: 'i-lucide-bot',
        onSelect: () => {
          authModalTab.value = 'oauth'
          authModalOpen.value = true
          paletteOpen.value = false
        }
      },
      {
        label: 'Criar Novo Projeto',
        icon: 'i-lucide-folder-plus',
        onSelect: () => {
          newProjectOpen.value = true
          paletteOpen.value = false
        }
      }
    ]
  }
])

// Create Project Zod Form
const projectSchema = z.object({
  projectId: z.string().min(2, 'Slug obrigatório').regex(/^[a-z0-9-]+$/, 'Apenas letras minúsculas, números e hífen'),
  name: z.string().min(2, 'Nome obrigatório'),
  description: z.string().optional()
})
const newProjectState = reactive({ projectId: '', name: '', description: '' })
const creatingProject = ref(false)

async function onCreateProject() {
  creatingProject.value = true
  try {
    await apiFetch('/v1/projects', { method: 'POST', body: JSON.stringify(newProjectState) })
    notify('Projeto criado!', newProjectState.name)
    projectId.value = newProjectState.projectId
    newProjectOpen.value = false
    newProjectState.projectId = ''
    newProjectState.name = ''
    newProjectState.description = ''
    await loadWorkspaceData()
  } catch (err) {
    notify('Erro ao criar projeto', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    creatingProject.value = false
  }
}

// Proposal Decision (canonical backend route /approvals/:proposalId/decision)
async function decideProposal(proposal: { id: string; version?: number }, decision: 'approve' | 'reject' | 'request_changes') {
  try {
    await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/approvals/${encodeURIComponent(proposal.id)}/decision`,
      {
        method: 'POST',
        body: JSON.stringify({
          decision,
          proposalVersion: proposal.version ?? 1,
          channel: 'web'
        })
      }
    )
    notify(decision === 'approve' ? 'Proposta aprovada' : decision === 'reject' ? 'Proposta rejeitada' : 'Revisão solicitada')
    await loadWorkspaceData()
  } catch (err) {
    notify('Erro na decisão', err instanceof Error ? err.message : String(err), 'error')
  }
}

// Runner Task Creation & Cancel
const runnerSchema = z.object({
  instruction: z.string().min(5, 'Descreva a tarefa (mín. 5 caracteres)'),
  priority: z.enum(['low', 'normal', 'high'])
})
const runnerState = reactive({ instruction: '', priority: 'normal' as 'low' | 'normal' | 'high' })
const dispatchingRunner = ref(false)

async function onDispatchRunner() {
  dispatchingRunner.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/tasks`, {
      method: 'POST',
      body: JSON.stringify(runnerState)
    })
    notify('Tarefa delegada ao Brain Runner!')
    runnerState.instruction = ''
    await loadWorkspaceData()
  } catch (err) {
    notify('Erro ao delegar tarefa', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    dispatchingRunner.value = false
  }
}

async function cancelTask(taskId: string) {
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST'
    })
    notify('Tarefa cancelada', taskId, 'warning')
    await loadWorkspaceData()
  } catch (err) {
    notify('Erro ao cancelar tarefa', err instanceof Error ? err.message : String(err), 'error')
  }
}

defineShortcuts({
  meta_k: () => {
    paletteOpen.value = !paletteOpen.value
  }
})
</script>

<template>
  <LandingAuthGate v-if="!apiKey || !currentUser" @authenticated="loadWorkspaceData" />
  <UDashboardGroup v-else unit="rem">
    <UDashboardSidebar
      v-model:collapsed="sidebarCollapsed"
      collapsible
      resizable
      :min-size="13"
      :max-size="20"
      :default-size="16"
      :collapsed-size="4.2"
      class="bg-elevated/40"
    >
      <template #header="{ collapsed }">
        <div class="flex items-center gap-2.5 px-1 py-1 min-w-0">
          <div class="shrink-0 w-8 h-8 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center">
            <UIcon name="i-lucide-brain-circuit" class="w-4.5 h-4.5 text-primary" />
          </div>
          <div v-if="!collapsed" class="flex items-center gap-2 min-w-0">
            <span class="font-bold text-base tracking-tight truncate">Noema</span>
            <UBadge color="primary" variant="subtle" size="xs">Brain OS</UBadge>
          </div>
        </div>
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          :collapsed="collapsed"
          :items="navMenuItems"
          orientation="vertical"
          tooltip
          popover
        />
      </template>

      <template #footer="{ collapsed }">
        <div class="w-full flex items-center justify-between gap-2 px-1">
          <UButton
            size="sm"
            variant="ghost"
            color="neutral"
            block
            class="justify-start"
            @click="authModalTab = 'login'; authModalOpen = true"
          >
            <UAvatar :alt="currentUser.name || currentUser.email" size="2xs" />
            <span v-if="!collapsed" class="truncate font-medium text-xs">{{ currentUser.name }}</span>
          </UButton>
        </div>
      </template>
    </UDashboardSidebar>

    <UDashboardPanel id="main-workspace">
      <template #header>
        <UDashboardNavbar>
          <template #leading>
            <UDashboardSidebarCollapse />
            <USelect
              v-model="projectId"
              :items="projectsList.length > 0 ? projectsList.map(p => ({ label: `${p.projectId} — ${p.name}`, value: p.projectId })) : [projectId]"
              size="sm"
              class="w-48 sm:w-56 ml-1"
            />
            <UButton v-if="hasPermission('projects:create')" size="xs" variant="ghost" icon="i-lucide-folder-plus" title="Novo Projeto" @click="newProjectOpen = true" />
          </template>

          <template #right>
            <UButton size="sm" variant="ghost" icon="i-lucide-search" color="neutral" @click="paletteOpen = true">
              <span class="hidden sm:inline">Buscar</span>
              <UKbd value="⌘K" size="sm" />
            </UButton>

            <UButton
              size="sm"
              variant="soft"
              color="primary"
              icon="i-lucide-bot"
              @click="authModalTab = 'oauth'; authModalOpen = true"
            >
              <span class="hidden md:inline">OAuth2 IA &amp; MCP</span>
            </UButton>

            <UColorModeButton size="sm" />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <div class="max-w-7xl w-full mx-auto">
          <Transition name="workspace-fade" mode="out-in">
            <!-- WORKSPACE: PROJECTS -->
            <div v-if="workspace === 'projects'" key="projects">
          <UiPageHeader
            :title="`Visão Geral — ${projectId}`"
            description="Resumo executivo de conhecimento indexado, saúde arquitetural e alertas do projeto"
            icon="i-lucide-folder-git-2"
          >
            <template #actions>
              <UButton size="sm" variant="soft" icon="i-lucide-folder-plus" @click="newProjectOpen = true">Novo Projeto</UButton>
              <UButton size="sm" variant="ghost" icon="i-lucide-refresh-cw" :loading="loadingData" @click="loadWorkspaceData">Atualizar</UButton>
            </template>
          </UiPageHeader>

          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <UiStatCard label="Itens Indexados" :value="overviewData?.totalItems ?? 0" icon="i-lucide-database" tone="primary" :loading="loadingData" />
            <UiStatCard label="Aprovados" :value="overviewData?.approvedCount ?? 0" icon="i-lucide-check-circle-2" tone="success" :loading="loadingData" />
            <UiStatCard label="Rascunhos" :value="overviewData?.draftCount ?? 0" icon="i-lucide-file-edit" tone="warning" :loading="loadingData" />
            <UiStatCard label="Saúde Arquitetural" :value="`${overviewData?.health?.healthScore ?? 100}%`" icon="i-lucide-heart-pulse" tone="info" :loading="loadingData" />
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <UCard>
              <template #header>
                <h3 class="font-semibold text-sm">Composição por Tipo de Conhecimento</h3>
              </template>
              <UiEmptyState
                v-if="!Object.keys(overviewData?.summary?.byType ?? {}).length"
                compact
                icon="i-lucide-pie-chart"
                title="Sem itens catalogados ainda"
                description="Conecte um repositório Git ou faça ingestão de documentos para popular este projeto."
              />
              <EChartBox v-else :option="overviewTypeChartOption" height="240px" />
            </UCard>

            <UCard>
              <template #header>
                <div class="flex items-center justify-between">
                  <h3 class="font-semibold text-sm">Alertas &amp; Governança</h3>
                  <UBadge :color="overviewData?.alerts?.length ? 'warning' : 'success'" variant="subtle" size="xs">
                    {{ overviewData?.alerts?.length ?? 0 }} alertas
                  </UBadge>
                </div>
              </template>
              <UiEmptyState
                v-if="!overviewData?.alerts?.length"
                compact
                icon="i-lucide-shield-check"
                title="Tudo saudável"
                description="Nenhum conflito ou regra sem cobertura detectado neste projeto."
              />
              <div v-else class="space-y-2">
                <UAlert
                  v-for="(alert, idx) in overviewData.alerts"
                  :key="idx"
                  color="warning"
                  variant="subtle"
                  icon="i-lucide-alert-triangle"
                  :description="alert"
                />
              </div>
            </UCard>
          </div>
        </div>

        <!-- WORKSPACE: INBOX -->
        <div v-else-if="workspace === 'inbox'">
          <UiPageHeader
            title="Caixa de Entrada &amp; Aprovações"
            description="Revise, inspecione e aprove ou rejeite propostas de conhecimento pendentes"
            icon="i-lucide-inbox"
          >
            <template #actions>
              <UButton size="sm" variant="ghost" icon="i-lucide-refresh-cw" :loading="loadingData" @click="loadWorkspaceData">Atualizar</UButton>
            </template>
          </UiPageHeader>

          <UCard>
            <UiEmptyState
              v-if="proposalsList.length === 0"
              icon="i-lucide-check-check"
              title="Nenhuma proposta pendente"
              description="Todas as propostas de alteração e conhecimento foram revisadas."
            />
            <div v-else class="divide-y divide-default">
              <div v-for="p in proposalsList" :key="p.id" class="py-3.5 flex flex-wrap items-center justify-between gap-4">
                <div class="min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-semibold text-sm">{{ p.title || p.id }}</span>
                    <UBadge color="neutral" variant="outline" size="xs" class="font-mono">{{ p.id }}</UBadge>
                    <UBadge v-if="p.overdue" color="error" variant="subtle" size="xs">SLA Vencido</UBadge>
                  </div>
                  <div class="text-xs text-muted mt-1">
                    Versão v{{ p.version ?? 1 }} · Política: {{ p.accessPolicyId || 'internal-project' }}
                    <span v-if="p.assignedTo"> · Responsável: {{ p.assignedTo }}</span>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <UButton
                    v-if="p.content"
                    size="xs"
                    variant="ghost"
                    icon="i-lucide-eye"
                    @click="inspectedKnowledge = { title: p.title || p.id, content: p.content, type: p.type || 'proposal', status: p.status }"
                  >
                    Ler
                  </UButton>
                  <UButton v-if="hasPermission('proposals:decide')" size="xs" color="success" variant="soft" icon="i-lucide-check" @click="decideProposal(p, 'approve')">
                    Aprovar
                  </UButton>
                  <UButton v-if="hasPermission('proposals:decide')" size="xs" color="error" variant="ghost" icon="i-lucide-x" @click="decideProposal(p, 'reject')">
                    Rejeitar
                  </UButton>
                </div>
              </div>
            </div>
          </UCard>
        </div>

        <!-- WORKSPACE: KNOWLEDGE -->
        <div v-else-if="workspace === 'knowledge'">
          <UiPageHeader
            title="Base de Conhecimento"
            description="Regras de negócio, ADRs, especificações e artefatos indexados neste projeto"
            icon="i-lucide-file-text"
          >
            <template #actions>
              <UInput v-model="searchQuery" placeholder="Busca híbrida..." icon="i-lucide-search" size="sm" class="w-56" @keyup.enter="loadWorkspaceData" />
              <USelect v-model="knowledgeTypeFilter" :items="knowledgeTypes" size="sm" class="w-36" />
              <UButton size="sm" variant="soft" icon="i-lucide-refresh-cw" :loading="loadingData" @click="loadWorkspaceData">Buscar</UButton>
            </template>
          </UiPageHeader>

          <UCard>
            <UiEmptyState
              v-if="filteredKnowledge.length === 0"
              icon="i-lucide-book-open"
              title="Nenhum item encontrado"
              description="Ajuste o filtro ou execute uma ingestão no projeto."
            />
            <UTable
              v-else
              :data="filteredKnowledge"
              :columns="[
                { accessorKey: 'id', header: 'ID' },
                { accessorKey: 'title', header: 'Título' },
                { accessorKey: 'type', header: 'Tipo' },
                { accessorKey: 'status', header: 'Status' },
                { accessorKey: 'accessPolicyId', header: 'Política' },
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
              <template #accessPolicyId-cell="{ row }">
                <span class="font-mono text-xs text-muted">{{ row.original.accessPolicyId }}</span>
              </template>
              <template #actions-cell="{ row }">
                <UButton size="xs" variant="soft" icon="i-lucide-eye" @click="inspectedKnowledge = row.original">Ler</UButton>
              </template>
            </UTable>
          </UCard>
        </div>

        <!-- WORKSPACE: AGENTS -->
        <div v-else-if="workspace === 'agents'">
          <UiPageHeader
            title="Agentes &amp; Brain Runner"
            description="Delegue tarefas assíncronas ao Brain Runner e acompanhe a fila de execução"
            icon="i-lucide-bot"
          >
            <template #actions>
              <UButton size="sm" variant="ghost" icon="i-lucide-refresh-cw" :loading="loadingData" @click="loadWorkspaceData">Atualizar</UButton>
            </template>
          </UiPageHeader>

          <div class="space-y-6">
            <UCard v-if="hasPermission('runner:execute')">
              <template #header>
                <h2 class="font-semibold text-sm">Delegar Tarefa ao Brain Runner</h2>
              </template>
              <UForm :schema="runnerSchema" :state="runnerState" class="space-y-4" @submit="onDispatchRunner">
                <UFormField label="Instrução para o Agente" name="instruction">
                  <UTextarea v-model="runnerState.instruction" placeholder="Ex.: Analise o impacto da regra BR-010..." class="w-full" />
                </UFormField>
                <div class="flex items-center justify-between">
                  <USelect v-model="runnerState.priority" :items="['low', 'normal', 'high']" size="sm" class="w-32" />
                  <UButton type="submit" :loading="dispatchingRunner" icon="i-lucide-play">Executar</UButton>
                </div>
              </UForm>
            </UCard>

            <UCard>
              <template #header>
                <div class="flex items-center justify-between">
                  <h2 class="font-semibold text-sm">Execuções Recentes</h2>
                  <UBadge color="neutral" variant="subtle" size="xs">{{ runnerTasks.length }} tarefas</UBadge>
                </div>
              </template>
              <UiEmptyState v-if="runnerTasks.length === 0" compact icon="i-lucide-bot" title="Nenhuma execução registrada" />
              <UTable
                v-else
                :data="runnerTasks"
                :columns="[
                  { accessorKey: 'taskId', header: 'ID' },
                  { accessorKey: 'instruction', header: 'Instrução' },
                  { accessorKey: 'status', header: 'Status' },
                  { accessorKey: 'priority', header: 'Prioridade' },
                  { id: 'actions', header: '' }
                ]"
              >
                <template #taskId-cell="{ row }">
                  <span class="font-mono text-xs">{{ row.original.taskId }}</span>
                </template>
                <template #status-cell="{ row }">
                  <UBadge
                    :color="row.original.status === 'completed' ? 'success' : row.original.status === 'failed' || row.original.status === 'cancelled' ? 'error' : 'warning'"
                    variant="subtle"
                    size="xs"
                  >
                    {{ row.original.status }}
                  </UBadge>
                </template>
                <template #priority-cell="{ row }">
                  <UBadge :color="row.original.priority === 'high' ? 'error' : 'neutral'" variant="outline" size="xs">
                    {{ row.original.priority }}
                  </UBadge>
                </template>
                <template #actions-cell="{ row }">
                  <UButton
                    v-if="hasPermission('runner:cancel') && (row.original.status === 'queued' || row.original.status === 'running')"
                    size="xs"
                    color="error"
                    variant="ghost"
                    icon="i-lucide-square"
                    @click="cancelTask(row.original.taskId)"
                  >
                    Cancelar
                  </UButton>
                </template>
              </UTable>
            </UCard>
          </div>
        </div>

        <!-- WORKSPACE: SEARCH & GRAPH -->
        <SearchGraphWorkspace
          v-else-if="workspace === 'search'"
          @inspect="(item) => inspectedKnowledge = { title: item.title, content: item.content, type: item.type || 'doc', status: item.status || 'approved' }"
        />

        <!-- WORKSPACE: IMPACT ANALYSIS -->
        <ImpactWorkspace
          v-else-if="workspace === 'impact'"
          :knowledge-items="knowledgeItems"
        />

        <!-- WORKSPACE: OPERATIONS & FINOPS -->
        <OperationsFinOpsWorkspace
          v-else-if="workspace === 'operations'"
          :finops="finopsData"
          :audit-logs="auditLogs"
          @refresh="loadWorkspaceData"
        />

        <!-- WORKSPACE: ACCESS & POLICIES -->
        <AccessWorkspace v-else-if="workspace === 'access'" />

        <!-- WORKSPACE: ENTERPRISE VIEWS -->
        <EnterpriseWorkspace v-else-if="workspace === 'enterprise'" key="enterprise" />
          </Transition>
        </div>
      </template>
    </UDashboardPanel>

    <!-- Command Palette (CMD+K) -->
    <UModal v-model:open="paletteOpen">
      <template #content>
        <UCommandPalette :groups="commandGroups" placeholder="Navegar ou executar comando..." />
      </template>
    </UModal>

    <!-- Create Project Modal -->
    <UModal v-model:open="newProjectOpen" title="Novo Projeto">
      <template #body>
        <UForm :schema="projectSchema" :state="newProjectState" class="space-y-4" @submit="onCreateProject">
          <UFormField label="Nome do Projeto" name="name">
            <UInput v-model="newProjectState.name" placeholder="Meu Projeto" class="w-full" />
          </UFormField>
          <UFormField label="Slug (ID)" name="projectId">
            <UInput v-model="newProjectState.projectId" placeholder="meu-projeto" class="w-full font-mono" />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="newProjectOpen = false">Cancelar</UButton>
            <UButton type="submit" :loading="creatingProject">Criar</UButton>
          </div>
        </UForm>
      </template>
    </UModal>

    <!-- Knowledge Inspector Slideover -->
    <USlideover :open="Boolean(inspectedKnowledge)" :title="inspectedKnowledge?.title" @update:open="val => { if (!val) inspectedKnowledge = null }">
      <template #body>
        <div v-if="inspectedKnowledge" class="space-y-3">
          <div class="flex gap-2">
            <UBadge color="neutral" variant="outline" size="xs">{{ inspectedKnowledge.type }}</UBadge>
            <UBadge :color="inspectedKnowledge.status === 'approved' ? 'success' : 'warning'" variant="subtle" size="xs">
              {{ inspectedKnowledge.status }}
            </UBadge>
          </div>
          <pre class="text-xs whitespace-pre-wrap leading-relaxed bg-elevated/60 p-4 rounded-xl border border-default">{{ inspectedKnowledge.content }}</pre>
        </div>
      </template>
    </USlideover>
  </UDashboardGroup>
</template>
