<script setup lang="ts">
import { z } from 'zod'

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
} = useBrainApi()

const workspace = ref<'projects' | 'inbox' | 'knowledge' | 'search' | 'agents' | 'impact' | 'operations' | 'access' | 'enterprise' | 'profile'>('projects')
const profileInitialTab = ref<'overview' | 'oauth' | 'tokens'>('overview')
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
    if (projectsList.value.length === 0) {
      projectId.value = ''
      overviewData.value = null
      proposalsList.value = []
      knowledgeItems.value = []
      runnerTasks.value = []
      finopsData.value = null
      auditLogs.value = []
      loadingData.value = false
      return
    }
    if (!projectsList.value.some(p => p.projectId === projectId.value)) {
      const firstProj = projectsList.value[0]
      if (firstProj) projectId.value = firstProj.projectId
    }
  } catch { /* ignore */ }

  if (!projectId.value) {
    loadingData.value = false
    return
  }

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
  if (import.meta.client) localStorage.setItem('brain.projectId', projectId.value)
  loadWorkspaceData()
})

const filteredKnowledge = computed(() => {
  if (knowledgeTypeFilter.value === 'all') return knowledgeItems.value
  return knowledgeItems.value.filter(k => k.type === knowledgeTypeFilter.value)
})

const knowledgeTypes = computed(() => ['all', ...new Set(knowledgeItems.value.map(k => k.type))])

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
  { id: 'enterprise', label: 'Visões Corporativas', icon: 'i-lucide-radar', permission: 'menu:enterprise' },
  { id: 'profile', label: 'Perfil & Conexões MCP', icon: 'i-lucide-user-cog', permission: 'menu:projects' }
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

const coreGroupIds = new Set<WorkspaceKey>(['projects', 'inbox', 'knowledge', 'search', 'agents', 'impact'])

const navMenuItems = computed(() => {
  const toMenuItem = (item: (typeof navItems.value)[number]) => ({
    label: item.label,
    icon: item.icon,
    badge: item.badge,
    active: workspace.value === item.id,
    onSelect: () => {
      workspace.value = item.id
    }
  })

  const core = navItems.value.filter(i => coreGroupIds.has(i.id))
  const gov = navItems.value.filter(i => !coreGroupIds.has(i.id))

  const groups: Array<Array<Record<string, unknown>>> = []
  if (core.length > 0) {
    groups.push([
      { label: 'Workspace', type: 'label' },
      ...core.map(toMenuItem)
    ])
  }
  if (gov.length > 0) {
    groups.push([
      { label: 'Governança', type: 'label' },
      ...gov.map(toMenuItem)
    ])
  }
  return groups
})

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
          profileInitialTab.value = 'oauth'
          workspace.value = 'profile'
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
      class="bg-elevated/30 border-r border-default/80"
    >
      <template #header="{ collapsed }">
        <div class="flex items-center gap-2.5 px-1.5 py-1 min-w-0">
          <div class="shrink-0 w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500/25 to-sky-500/20 border border-indigo-500/35 flex items-center justify-center shadow-xs">
            <UIcon name="i-lucide-brain-circuit" class="w-4.5 h-4.5 text-primary" />
          </div>
          <div v-if="!collapsed" class="flex items-center gap-2 min-w-0">
            <span class="font-bold text-base tracking-tight text-highlighted truncate">Brain</span>
            <UBadge color="primary" variant="soft" size="xs" class="font-mono">OS</UBadge>
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
        <div class="w-full flex items-center justify-between gap-2 px-1 pt-2 border-t border-default/60">
          <UButton
            size="sm"
            variant="ghost"
            color="neutral"
            block
            class="justify-start"
            @click="profileInitialTab = 'overview'; workspace = 'profile'"
          >
            <UAvatar :alt="currentUser.name || currentUser.email" size="2xs" />
            <div v-if="!collapsed" class="flex items-center justify-between flex-1 min-w-0 gap-1.5">
              <span class="truncate font-medium text-xs text-highlighted">{{ currentUser.name }}</span>
              <UBadge v-if="currentUser.roles[0]" color="neutral" variant="subtle" size="xs" class="shrink-0">
                {{ currentUser.roles[0] }}
              </UBadge>
            </div>
          </UButton>
        </div>
      </template>
    </UDashboardSidebar>

    <UDashboardPanel id="main-workspace" class="brain-workspace-bg">
      <template #header>
        <UDashboardNavbar class="border-b border-default/70 backdrop-blur-sm">
          <template #leading>
            <UDashboardSidebarCollapse />
            <div class="flex items-center gap-1.5 ml-1">
              <span class="hidden sm:inline text-xs font-medium text-muted">Projeto:</span>
              <USelect
                v-if="projectsList.length > 0"
                v-model="projectId"
                :items="projectsList.map(p => ({ label: `${p.projectId} — ${p.name}`, value: p.projectId }))"
                size="sm"
                class="w-48 sm:w-60"
              />
              <UBadge v-else color="neutral" variant="subtle" size="sm">
                Sem projeto vinculado
              </UBadge>
              <UButton v-if="hasPermission('projects:create')" size="xs" variant="soft" color="neutral" icon="i-lucide-folder-plus" title="Novo Projeto" @click="newProjectOpen = true" />
            </div>
          </template>

          <template #right>
            <UButton size="sm" variant="outline" icon="i-lucide-search" color="neutral" class="gap-2" @click="paletteOpen = true">
              <span class="hidden sm:inline text-muted">Buscar ou ir para...</span>
              <UKbd value="⌘K" size="sm" />
            </UButton>

            <UButton
              size="sm"
              variant="soft"
              color="primary"
              icon="i-lucide-bot"
              @click="profileInitialTab = 'oauth'; workspace = 'profile'"
            >
              <span class="hidden md:inline">OAuth2 IA &amp; MCP</span>
            </UButton>

            <UColorModeButton size="sm" />
          </template>
        </UDashboardNavbar>
      </template>

      <template #body>
        <div class="max-w-7xl w-full mx-auto space-y-4">
          <UAlert
            v-if="!loadingData && projectsList.length === 0 && workspace !== 'profile'"
            color="neutral"
            variant="subtle"
            icon="i-lucide-folder-x"
            title="Nenhum projeto vinculado"
            description="Você tem acesso ao sistema e às guias permitidas, mas nenhum projeto está vinculado à sua conta (os dados de projeto ficam ocultos)."
          />
          <Transition name="workspace-fade" mode="out-in">
            <!-- WORKSPACE: PROJECTS -->
            <ProjectsOverviewWorkspace
              v-if="workspace === 'projects'"
              key="projects"
              :project-id="projectId"
              :projects-list="projectsList"
              :overview-data="overviewData"
              :proposals-count="proposalsList.length"
              :runner-tasks="runnerTasks"
              :finops="finopsData"
              :audit-logs="auditLogs"
              :loading="loadingData"
              @new-project="newProjectOpen = true"
              @refresh="loadWorkspaceData"
              @navigate="(w) => workspace = w"
            />

        <!-- WORKSPACE: INBOX -->
        <InboxWorkspace
          v-else-if="workspace === 'inbox'"
          key="inbox"
          :proposals="proposalsList"
          :loading="loadingData"
          @refresh="loadWorkspaceData"
        />

        <!-- WORKSPACE: KNOWLEDGE HUB (SKILLS, SPECS & ITEMS) -->
        <KnowledgeHubWorkspace
          v-else-if="workspace === 'knowledge'"
          key="knowledge"
          :items="knowledgeItems"
          :loading="loadingData"
          @refresh="loadWorkspaceData"
        />

        <!-- WORKSPACE: AGENTS -->
        <AgentsRunnerWorkspace
          v-else-if="workspace === 'agents'"
          key="agents"
          :tasks="runnerTasks"
          :loading="loadingData"
          @refresh="loadWorkspaceData"
        />

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

        <!-- WORKSPACE: USER PROFILE & MCP -->
        <ProfileWorkspace v-else-if="workspace === 'profile'" key="profile" :initial-tab="profileInitialTab" />
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
