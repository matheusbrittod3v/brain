<script setup lang="ts">
import CreateModal from './knowledge/CreateModal.vue'
import InspectorSlideover from './knowledge/InspectorSlideover.vue'
import KnowledgeLayersTopologyTab from './knowledge/LayersTopologyTab.vue'
import SkillsTab from './knowledge/SkillsTab.vue'
import SpecsTab from './knowledge/SpecsTab.vue'
import UploadModal from './knowledge/UploadModal.vue'
import {
  KNOWLEDGE_LAYERS,
  computeKnowledgeQuality,
  inferKnowledgeFormat,
  inferKnowledgeLayer,
  qualityColor,
  type KnowledgeItemRow,
  type KnowledgeLayer
} from './knowledge/knowledgeUtils'

const props = defineProps<{
  items: KnowledgeItemRow[]
  loading?: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

const { projectId, apiFetch, notify, hasPermission } = useBrainApi()

const activeSubTab = ref('all')
const searchQuery = ref('')
const typeFilter = ref('all')
const layerFilter = ref<'all' | KnowledgeLayer>('all')

const fetchedSkills = ref<KnowledgeItemRow[]>([])
const syncingBrain = ref(false)
const uploadOpen = ref(false)
const createOpen = ref(false)
const createInitialType = ref('doc')
const inspected = ref<KnowledgeItemRow | null>(null)
const inspectorTab = ref<'read' | 'edit' | 'versions' | 'relations'>('read')

const decisionsTimeline = ref<Array<{ id: string; title: string; status: string; version: number; date: string; rationale: string }>>([])
const loadingDecisions = ref(false)
async function loadDecisions() {
  if (!projectId.value) return
  loadingDecisions.value = true
  try {
    const res = await apiFetch<{ timeline: typeof decisionsTimeline.value }>(`/v1/projects/${encodeURIComponent(projectId.value)}/intelligence/decision-timeline`)
    decisionsTimeline.value = res.timeline ?? []
  } catch {
    decisionsTimeline.value = []
  } finally {
    loadingDecisions.value = false
  }
}

const docDriftSuggestions = ref<Array<{ documentId: string; title: string; reason: string; urgency: string; suggestedSection: string }>>([])
const loadingDrift = ref(false)
async function loadDrift() {
  if (!projectId.value) return
  loadingDrift.value = true
  try {
    const res = await apiFetch<{ suggestions: typeof docDriftSuggestions.value }>(
      `/v1/projects/${encodeURIComponent(projectId.value)}/intelligence/doc-drift-suggestions`,
      { method: 'POST', body: JSON.stringify({ changedFiles: ['apps/api/src/server.ts', 'packages/core/src/index.ts'] }) }
    )
    docDriftSuggestions.value = res.suggestions ?? []
  } catch {
    docDriftSuggestions.value = []
  } finally {
    loadingDrift.value = false
  }
}

watch(activeSubTab, (tab) => {
  if (tab === 'decisions' && decisionsTimeline.value.length === 0) loadDecisions()
  if (tab === 'drift' && docDriftSuggestions.value.length === 0) loadDrift()
})

async function loadSkills() {
  if (!projectId.value) {
    fetchedSkills.value = []
    return
  }
  try {
    const res = await apiFetch<{ skills: KnowledgeItemRow[] }>(`/v1/projects/${encodeURIComponent(projectId.value)}/skills`)
    fetchedSkills.value = res.skills ?? []
  } catch {
    fetchedSkills.value = props.items.filter(i => i.type === 'skill' && i.status !== 'deprecated')
  }
}

onMounted(loadSkills)
watch([projectId, () => props.items.length], loadSkills)

const skillsList = computed(() =>
  fetchedSkills.value.length > 0
    ? fetchedSkills.value
    : props.items.filter(i => i.type === 'skill' && i.status !== 'deprecated')
)
const specsList = computed(() => props.items.filter(i => (i.type === 'spec' || i.type === 'requirement') && i.status !== 'deprecated'))
const approvedCount = computed(() => props.items.filter(i => i.status === 'approved').length)

const subTabs = computed(() => [
  { label: 'Todo Conhecimento', value: 'all', icon: 'i-lucide-library', badge: props.items.length },
  { label: 'Topologia & Camadas', value: 'layers', icon: 'i-lucide-network', badge: KNOWLEDGE_LAYERS.length },
  { label: 'Skills MCP (Agentes)', value: 'skills', icon: 'i-lucide-sparkles', badge: skillsList.value.length },
  { label: 'Specs & Planejamento', value: 'specs', icon: 'i-lucide-file-code-2', badge: specsList.value.length },
  { label: 'Histórico de Decisões', value: 'decisions', icon: 'i-lucide-history' },
  { label: 'Sugestões de Docs', value: 'drift', icon: 'i-lucide-file-diff' }
])

const layerFilterItems = [
  { label: 'Todas as camadas', value: 'all' },
  ...KNOWLEDGE_LAYERS.map(l => ({ label: l.label, value: l.id }))
]

const typeOptions = computed(() => [
  'all',
  ...new Set([
    'skill', 'spec', 'business_rule', 'architecture_decision', 'diagram', 'topology',
    'api_contract', 'event_contract', 'runbook', 'document', 'requirement',
    'glossary_term', 'product_capability', 'data_model', 'use_case', 'journey',
    'risk_control', 'slo_target', 'incident_postmortem', 'pending_decision',
    ...props.items.map(i => i.type)
  ])
])

const createTypeOptions = computed(() => typeOptions.value.filter(t => t !== 'all'))

const filteredItems = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return props.items.filter((item) => {
    if (typeFilter.value !== 'all' && item.type !== typeFilter.value) return false
    if (layerFilter.value !== 'all' && inferKnowledgeLayer(item) !== layerFilter.value) return false
    if (!q) return true
    return `${item.id} ${item.title} ${item.type} ${(item.tags ?? []).join(' ')} ${item.content}`.toLowerCase().includes(q)
  })
})

function layerMeta(item: KnowledgeItemRow) {
  const id = inferKnowledgeLayer(item)
  return KNOWLEDGE_LAYERS.find(l => l.id === id) ?? KNOWLEDGE_LAYERS[5]!
}

async function syncBrainFolder() {
  syncingBrain.value = true
  try {
    const res = await apiFetch<{ syncedCount: number; message?: string }>(
      `/v1/projects/${encodeURIComponent(projectId.value)}/sync-brain`,
      { method: 'POST', body: JSON.stringify({}) }
    )
    if (res.syncedCount > 0) {
      notify('Pasta .brain/ sincronizada!', `${res.syncedCount} item(ns) importado(s) do repositório local.`)
    } else {
      notify('Sync .brain', res.message || 'Nenhum arquivo .md novo encontrado em .brain/.', 'warning')
    }
    emit('refresh')
    await loadSkills()
  } catch (err) {
    notify('Erro ao sincronizar .brain/', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    syncingBrain.value = false
  }
}

async function planSpecTasks(item: KnowledgeItemRow) {
  try {
    const res = await apiFetch<{ pendingCount: number; queuedTasks: Array<{ taskId: string }> }>(
      `/v1/projects/${encodeURIComponent(item.projectId || projectId.value)}/knowledge/${encodeURIComponent(item.id)}/plan-tasks`,
      { method: 'POST', body: JSON.stringify({ enqueueToRunner: true }) }
    )
    notify('Tarefas enviadas ao Brain Runner!', `${res.queuedTasks.length} tarefa(s) do checklist (- [ ]) enfileiradas.`)
    emit('refresh')
  } catch (err) {
    notify('Erro ao gerar plano', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function quickApprove(itemId: string) {
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/knowledge/${encodeURIComponent(itemId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' })
    })
    notify('Aprovado oficialmente!')
    emit('refresh')
    await loadSkills()
  } catch (err) {
    notify('Erro ao aprovar', err instanceof Error ? err.message : String(err), 'error')
  }
}

function openCreateModal(presetType = 'doc') {
  createInitialType.value = presetType
  createOpen.value = true
}

function openInspector(item: KnowledgeItemRow, tab: 'read' | 'edit' | 'versions' | 'relations' = 'read') {
  inspected.value = item
  inspectorTab.value = tab
}

async function handleRefresh() {
  emit('refresh')
  await loadSkills()
}
</script>

<template>
  <div>
    <UiPageHeader
      title="Hub de Conhecimento, Skills & Specs"
      description="Centralize skills MCP (.brain/skills), registre specs, importe documentos e gerencie vínculos de grafo"
      icon="i-lucide-brain"
    >
      <template #actions>
        <UButton
          v-if="hasPermission('knowledge:write')"
          size="sm"
          variant="soft"
          color="primary"
          icon="i-lucide-sparkles"
          @click="openCreateModal('skill')"
        >
          Nova Skill MCP
        </UButton>
        <UButton
          v-if="hasPermission('knowledge:write')"
          size="sm"
          variant="soft"
          color="info"
          icon="i-lucide-file-code-2"
          @click="openCreateModal('spec')"
        >
          Nova Spec
        </UButton>
        <UButton
          v-if="hasPermission('knowledge:write')"
          size="sm"
          variant="outline"
          color="neutral"
          icon="i-lucide-upload"
          @click="uploadOpen = true"
        >
          Importar Arquivo
        </UButton>
        <UButton
          v-if="hasPermission('knowledge:write')"
          size="sm"
          variant="ghost"
          color="neutral"
          icon="i-lucide-folder-sync"
          :loading="syncingBrain"
          @click="syncBrainFolder"
        >
          Sync .brain/
        </UButton>
      </template>
    </UiPageHeader>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <UiStatCard label="Total no Hub" :value="items.length" icon="i-lucide-database" tone="primary" :loading="loading" />
      <UiStatCard label="Skills MCP Ativas" :value="skillsList.length" icon="i-lucide-sparkles" tone="info" hint="Projeto + Global (__org__)" :loading="loading" />
      <UiStatCard label="Specs & Requisitos" :value="specsList.length" icon="i-lucide-file-code-2" tone="warning" :loading="loading" />
      <UiStatCard label="Oficiais Aprovados" :value="approvedCount" icon="i-lucide-check-circle-2" tone="success" :loading="loading" />
    </div>

    <div class="space-y-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <UiSegmentedTabs v-model="activeSubTab" :items="subTabs" />

        <div class="flex flex-wrap items-center gap-2">
          <UInput v-model="searchQuery" placeholder="Filtrar título, tag, conteúdo..." icon="i-lucide-search" size="sm" class="w-56" />
          <USelect v-if="activeSubTab === 'all'" v-model="layerFilter" :items="layerFilterItems" size="sm" class="w-44" />
          <USelect v-if="activeSubTab === 'all'" v-model="typeFilter" :items="typeOptions" size="sm" class="w-36" />
          <UButton size="sm" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="handleRefresh" />
        </div>
      </div>

      <KnowledgeLayersTopologyTab
        v-if="activeSubTab === 'layers'"
        :items="items"
        @select-layer="(l) => { layerFilter = l; activeSubTab = 'all' }"
        @inspect-item="(item) => openInspector(item, 'read')"
      />

      <UCard v-else-if="activeSubTab === 'all'">
        <UiEmptyState
          v-if="filteredItems.length === 0"
          icon="i-lucide-book-open"
          title="Nenhum item encontrado"
          description="Crie uma Skill, Spec, diagrama, topologia ou sincronize .brain/."
        />
        <UTable
          v-else
          :data="filteredItems"
          :columns="[
            { accessorKey: 'id', header: 'ID' },
            { accessorKey: 'title', header: 'Título' },
            { id: 'layer', header: 'Camada & Formato' },
            { id: 'quality', header: 'Qualidade' },
            { accessorKey: 'status', header: 'Status' },
            { id: 'actions', header: '' }
          ]"
        >
          <template #id-cell="{ row }">
            <span class="font-mono text-xs font-semibold">{{ row.original.id }}</span>
          </template>
          <template #layer-cell="{ row }">
            <div class="flex flex-wrap items-center gap-1">
              <UBadge :color="layerMeta(row.original).badgeColor" variant="subtle" size="xs">
                {{ layerMeta(row.original).label.split(' ')[0] }}
              </UBadge>
              <UBadge color="neutral" variant="outline" size="xs" class="font-mono">
                {{ inferKnowledgeFormat(row.original) }}
              </UBadge>
            </div>
          </template>
          <template #quality-cell="{ row }">
            <UBadge :color="qualityColor(computeKnowledgeQuality(row.original).score)" variant="soft" size="xs" class="font-mono">
              {{ computeKnowledgeQuality(row.original).grade }} · {{ computeKnowledgeQuality(row.original).score }}%
            </UBadge>
          </template>
          <template #status-cell="{ row }">
            <UBadge :color="row.original.status === 'approved' ? 'success' : 'warning'" variant="subtle" size="xs">
              {{ row.original.status }}
            </UBadge>
          </template>
          <template #actions-cell="{ row }">
            <div class="flex justify-end gap-1">
              <UButton size="xs" variant="soft" icon="i-lucide-eye" @click="openInspector(row.original, 'read')">Abrir</UButton>
              <UButton
                v-if="hasPermission('knowledge:write')"
                size="xs"
                variant="ghost"
                icon="i-lucide-pencil"
                @click="openInspector(row.original, 'edit')"
              >
                Editar
              </UButton>
            </div>
          </template>
        </UTable>
      </UCard>

      <SkillsTab
        v-else-if="activeSubTab === 'skills'"
        :skills-list="skillsList"
        :can-write="hasPermission('knowledge:write')"
        @create-skill="openCreateModal('skill')"
        @open="(item, tab) => openInspector(item, tab)"
      />

      <SpecsTab
        v-else-if="activeSubTab === 'specs'"
        :specs-list="specsList"
        :can-write="hasPermission('knowledge:write')"
        :can-execute="hasPermission('runner:execute')"
        :can-approve="hasPermission('knowledge:approve')"
        @create-spec="openCreateModal('spec')"
        @plan="planSpecTasks"
        @approve="quickApprove"
        @open="(item, tab) => openInspector(item, tab)"
      />

      <!-- Histórico de Decisões & Timeline ADR -->
      <UCard v-else-if="activeSubTab === 'decisions'">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-sm">Histórico de Decisões de Arquitetura &amp; Regras</h3>
            <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" :loading="loadingDecisions" @click="loadDecisions">Atualizar</UButton>
          </div>
        </template>
        <div v-if="loadingDecisions" class="p-8 text-center text-xs text-muted">Carregando linha do tempo...</div>
        <div v-else-if="!decisionsTimeline.length" class="p-8 text-center text-xs text-muted">Nenhuma decisão de arquitetura registrada.</div>
        <div v-else class="space-y-3">
          <div v-for="d in decisionsTimeline" :key="d.id" class="p-3.5 rounded-xl border border-default bg-elevated/40 space-y-1">
            <div class="flex items-center justify-between">
              <span class="font-mono text-xs font-bold text-primary">{{ d.id }}</span>
              <UBadge :color="d.status === 'approved' ? 'success' : 'warning'" variant="subtle" size="xs">{{ d.status }} · v{{ d.version }}</UBadge>
            </div>
            <div class="text-xs font-semibold text-highlighted">{{ d.title }}</div>
            <p class="text-[11px] text-muted">{{ d.rationale }}</p>
            <div class="text-[10px] text-muted pt-1">{{ new Date(d.date).toLocaleString('pt-BR') }}</div>
          </div>
        </div>
      </UCard>

      <!-- Sugestões de Documentação Desatualizada (Drift) -->
      <UCard v-else-if="activeSubTab === 'drift'">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-sm">Sugestões de Documentação (Drift após Mudanças no Código)</h3>
            <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" :loading="loadingDrift" @click="loadDrift">Reanalisar Drift</UButton>
          </div>
        </template>
        <div v-if="loadingDrift" class="p-8 text-center text-xs text-muted">Analisando defasagem entre código e docs...</div>
        <div v-else-if="!docDriftSuggestions.length" class="p-8 text-center text-xs text-muted">Documentação 100% alinhada com o código.</div>
        <div v-else class="space-y-3">
          <div v-for="s in docDriftSuggestions" :key="s.documentId" class="p-3.5 rounded-xl border border-default bg-elevated/40 space-y-1">
            <div class="flex items-center justify-between">
              <span class="font-mono text-xs font-bold">{{ s.documentId }}</span>
              <UBadge :color="s.urgency === 'high' ? 'error' : 'warning'" variant="subtle" size="xs">Urgência: {{ s.urgency }}</UBadge>
            </div>
            <div class="text-xs font-semibold text-highlighted">{{ s.title }}</div>
            <p class="text-[11px] text-muted">{{ s.reason }}</p>
            <p class="text-[11px] text-primary"><span class="font-bold">Sugestão:</span> {{ s.suggestedSection }}</p>
          </div>
        </div>
      </UCard>
    </div>

    <UploadModal
      v-model:open="uploadOpen"
      :project-id="projectId"
      @uploaded="handleRefresh"
    />

    <CreateModal
      v-model:open="createOpen"
      :project-id="projectId"
      :type-options="createTypeOptions"
      :initial-type="createInitialType"
      @created="handleRefresh"
    />

    <InspectorSlideover
      :item="inspected"
      :initial-tab="inspectorTab"
      :project-id="projectId"
      :all-items="items"
      :can-write="hasPermission('knowledge:write')"
      @close="inspected = null"
      @updated="(updatedItem) => { inspected = updatedItem; handleRefresh() }"
    />
  </div>
</template>
