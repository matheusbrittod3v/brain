<script setup lang="ts">
import { z } from 'zod'

interface KnowledgeItemRow {
  id: string
  projectId?: string
  title: string
  type: string
  status: string
  accessPolicyId: string
  content: string
  summary?: string
  version?: number
  tags?: string[]
  updatedAt?: string
  scope?: 'project' | 'org'
}

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

const fetchedSkills = ref<KnowledgeItemRow[]>([])
const syncingBrain = ref(false)

async function loadSkills() {
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
  { label: 'Skills MCP (Agentes)', value: 'skills', icon: 'i-lucide-sparkles', badge: skillsList.value.length },
  { label: 'Specs & Planejamento', value: 'specs', icon: 'i-lucide-file-code-2', badge: specsList.value.length }
])

const typeOptions = computed(() => [
  'all',
  ...new Set(['skill', 'spec', 'business_rule', 'architecture_decision', 'document', 'requirement', ...props.items.map(i => i.type)])
])

const filteredItems = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return props.items.filter((item) => {
    if (typeFilter.value !== 'all' && item.type !== typeFilter.value) return false
    if (!q) return true
    return `${item.id} ${item.title} ${item.type} ${(item.tags ?? []).join(' ')} ${item.content}`.toLowerCase().includes(q)
  })
})

async function syncBrainFolder() {
  syncingBrain.value = true
  try {
    const res = await apiFetch<{ syncedCount: number; message?: string }>(
      `/v1/projects/${encodeURIComponent(projectId.value)}/brain/sync`,
      { method: 'POST', body: JSON.stringify({}) }
    )
    if (res.syncedCount > 0) {
      notify('Pasta .brain sincronizada!', `${res.syncedCount} arquivo(s) importado(s).`)
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

// Upload Modal (File + URL)
const uploadOpen = ref(false)
const uploadMode = ref<'file' | 'url'>('file')
const uploading = ref(false)
const uploadPolicy = ref('internal-project')
const uploadMdType = ref<'document' | 'spec' | 'skill'>('document')
const uploadUrl = ref('')
const selectedFile = ref<File | null>(null)
const dragActive = ref(false)

function onFileSelected(file: File | null | undefined) {
  if (!file) return
  selectedFile.value = file
}

function handleDrop(e: DragEvent) {
  dragActive.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) onFileSelected(file)
}

async function onUrlImportSubmit() {
  if (!uploadUrl.value.trim()) return
  uploading.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/ingest-url`, {
      method: 'POST',
      body: JSON.stringify({
        url: uploadUrl.value.trim(),
        type: uploadMdType.value,
        accessPolicyId: uploadPolicy.value
      })
    })
    notify('URL importada!', 'Conteúdo extraído e indexado no Hub.')
    uploadUrl.value = ''
    uploadOpen.value = false
    emit('refresh')
    await loadSkills()
  } catch (err) {
    notify('Erro ao importar URL', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    uploading.value = false
  }
}

async function planSpecTasks(item: KnowledgeItemRow) {
  try {
    const res = await apiFetch<{ pendingCount: number; queuedTasks: Array<{ taskId: string }> }>(
      `/v1/projects/${encodeURIComponent(item.projectId || projectId.value)}/knowledge/${encodeURIComponent(item.id)}/plan-tasks`,
      { method: 'POST', body: JSON.stringify({ enqueueToRunner: true }) }
    )
    notify(
      'Tarefas enviadas ao Brain Runner!',
      `${res.queuedTasks.length} tarefa(s) do checklist (- [ ]) enfileiradas.`
    )
    emit('refresh')
  } catch (err) {
    notify('Erro ao gerar plano', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function onUploadSubmit() {
  if (!selectedFile.value) return
  uploading.value = true
  try {
    const file = selectedFile.value
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (ext === '.md' || ext === '.txt') {
      const content = await file.text()
      await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/knowledge`, {
        method: 'POST',
        body: JSON.stringify({
          title: file.name.replace(/\.(md|txt)$/i, ''),
          type: uploadMdType.value,
          content,
          accessPolicyId: uploadPolicy.value,
          tags: [uploadMdType.value, 'upload']
        })
      })
      notify('Arquivo Markdown importado!', `${file.name} salvo como ${uploadMdType.value}.`)
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      const contentBase64 = btoa(binary)
      await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/ingest-document`, {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          contentBase64,
          accessPolicyId: uploadPolicy.value
        })
      })
      notify('Documento processado!', `${file.name} extraído, escaneado e indexado.`)
    }
    selectedFile.value = null
    uploadOpen.value = false
    emit('refresh')
    await loadSkills()
  } catch (err) {
    notify('Erro no upload', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    uploading.value = false
  }
}

// Create Modal
const createOpen = ref(false)
const creating = ref(false)
const createSchema = z.object({
  title: z.string().min(2, 'Título obrigatório'),
  type: z.string().min(1),
  content: z.string().min(5, 'Conteúdo obrigatório'),
  accessPolicyId: z.string().min(1)
})
const createForm = ref({
  id: '',
  title: '',
  type: 'skill' as 'skill' | 'spec' | 'business_rule' | 'architecture_decision' | 'document' | 'requirement',
  summary: '',
  tagsCsv: 'skill, mcp',
  accessPolicyId: 'internal-project',
  status: 'approved' as 'draft' | 'approved',
  globalOrg: false,
  content: ''
})

function openCreateModal(presetType: 'skill' | 'spec' | 'business_rule' | 'architecture_decision' | 'document' | 'requirement') {
  createForm.value.id = ''
  createForm.value.title = ''
  createForm.value.type = presetType
  createForm.value.summary = ''
  createForm.value.accessPolicyId = 'internal-project'
  createForm.value.status = hasPermission('knowledge:approve') ? 'approved' : 'draft'
  createForm.value.globalOrg = false
  if (presetType === 'skill') {
    createForm.value.tagsCsv = 'skill, mcp, agent'
    createForm.value.content = `---\nname: nova-skill\ndescription: Descreva quando e como o agente deve usar esta skill.\n---\n\n## Objetivo\nExplique o fluxo que todo agente conectado ao Brain deve seguir.\n\n## Regras\n1. Valide os contratos antes de editar.\n2. Registre evidências e testes.`
  } else if (presetType === 'spec') {
    createForm.value.tagsCsv = 'spec, planning'
    createForm.value.content = `# Spec: Nome da Funcionalidade\n\n## Contexto & Problema\nDescreva o objetivo arquitetural.\n\n## Requisitos\n- [ ] Requisito 1\n- [ ] Requisito 2\n\n## Contratos & Critérios de Aceite\nDefina entradas, saídas e testes esperados.`
  } else {
    createForm.value.tagsCsv = ''
    createForm.value.content = ''
  }
  createOpen.value = true
}

async function onCreateItem() {
  creating.value = true
  try {
    const tags = createForm.value.tagsCsv.split(',').map(s => s.trim()).filter(Boolean)
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/knowledge`, {
      method: 'POST',
      body: JSON.stringify({
        ...(createForm.value.id.trim() ? { id: createForm.value.id.trim() } : {}),
        title: createForm.value.title.trim(),
        type: createForm.value.type,
        summary: createForm.value.summary.trim() || undefined,
        content: createForm.value.content,
        accessPolicyId: createForm.value.accessPolicyId,
        status: createForm.value.status,
        globalOrg: createForm.value.type === 'skill' ? createForm.value.globalOrg : false,
        tags
      })
    })
    notify('Item salvo no Hub!', `${createForm.value.title} (${createForm.value.type})`)
    createOpen.value = false
    emit('refresh')
    await loadSkills()
  } catch (err) {
    notify('Erro ao salvar item', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    creating.value = false
  }
}

// Inspector, Editor, Versions & Graph Relations Slideover
const inspected = ref<KnowledgeItemRow | null>(null)
const slideTab = ref<'read' | 'edit' | 'versions' | 'relations'>('read')
const savingEdit = ref(false)
const editForm = ref({
  title: '',
  type: '',
  accessPolicyId: 'internal-project',
  status: 'draft' as 'draft' | 'approved' | 'deprecated' | 'superseded',
  tagsCsv: '',
  content: ''
})

const versionsList = ref<KnowledgeItemRow[]>([])
const selectedVersionIdx = ref(0)
const relationsList = ref<Array<{ itemId: string; via: string; hops: number; isInferred?: boolean }>>([])
const newRelTarget = ref('')
const newRelType = ref<'IMPACTS' | 'DEPENDS_ON' | 'VERIFIED_BY' | 'IMPLEMENTS' | 'RELATES_TO'>('IMPACTS')
const savingRelation = ref(false)

async function loadItemDetails(item: KnowledgeItemRow) {
  const pid = encodeURIComponent(item.projectId || projectId.value)
  const id = encodeURIComponent(item.id)
  const [vRes, dRes] = await Promise.allSettled([
    apiFetch<{ versions: KnowledgeItemRow[] }>(`/v1/projects/${pid}/knowledge/${id}/versions`),
    apiFetch<{ relations: typeof relationsList.value }>(`/v1/projects/${pid}/knowledge/${id}`)
  ])
  if (vRes.status === 'fulfilled') {
    versionsList.value = [...(vRes.value.versions ?? [])].sort((a, b) => (b.version ?? 1) - (a.version ?? 1))
    selectedVersionIdx.value = 0
  } else {
    versionsList.value = [item]
  }
  if (dRes.status === 'fulfilled') {
    relationsList.value = dRes.value.relations ?? []
  } else {
    relationsList.value = []
  }
}

function openInspector(item: KnowledgeItemRow, tab: typeof slideTab.value = 'read') {
  inspected.value = item
  slideTab.value = tab
  editForm.value.title = item.title
  editForm.value.type = item.type
  editForm.value.accessPolicyId = item.accessPolicyId
  editForm.value.status = (item.status as 'draft' | 'approved' | 'deprecated' | 'superseded') || 'draft'
  editForm.value.tagsCsv = (item.tags ?? []).join(', ')
  editForm.value.content = item.content
  void loadItemDetails(item)
}

const versionDiffLines = computed(() => {
  const current = versionsList.value[selectedVersionIdx.value]
  if (!current) return []
  const prev = versionsList.value[selectedVersionIdx.value + 1]
  if (!prev) {
    return current.content.split('\n').map(line => ({ kind: 'same' as const, text: line }))
  }
  const prevSet = new Set(prev.content.split('\n'))
  const currLines = current.content.split('\n')
  const currSet = new Set(currLines)
  const out: Array<{ kind: 'add' | 'del' | 'same'; text: string }> = []
  for (const l of prev.content.split('\n')) {
    if (!currSet.has(l)) out.push({ kind: 'del', text: l })
  }
  for (const l of currLines) {
    out.push({ kind: prevSet.has(l) ? 'same' : 'add', text: l })
  }
  return out
})

async function restoreVersion(ver: KnowledgeItemRow) {
  if (!inspected.value) return
  editForm.value.content = ver.content
  editForm.value.title = ver.title
  await onSaveEdit()
}

async function onSaveEdit() {
  if (!inspected.value) return
  savingEdit.value = true
  try {
    const tags = editForm.value.tagsCsv.split(',').map(s => s.trim()).filter(Boolean)
    const targetPid = encodeURIComponent(inspected.value.projectId || projectId.value)
    const res = await apiFetch<{ item: KnowledgeItemRow }>(
      `/v1/projects/${targetPid}/knowledge/${encodeURIComponent(inspected.value.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          title: editForm.value.title.trim(),
          type: editForm.value.type,
          accessPolicyId: editForm.value.accessPolicyId,
          status: editForm.value.status,
          tags,
          content: editForm.value.content
        })
      }
    )
    inspected.value = res.item
    slideTab.value = 'read'
    notify('Conhecimento atualizado!', `Versão v${res.item.version ?? 1} salva no PostgreSQL.`)
    emit('refresh')
    await loadSkills()
    await loadItemDetails(res.item)
  } catch (err) {
    notify('Erro ao atualizar', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingEdit.value = false
  }
}

async function onAddRelation() {
  if (!inspected.value || !newRelTarget.value.trim()) return
  savingRelation.value = true
  try {
    const pid = encodeURIComponent(inspected.value.projectId || projectId.value)
    await apiFetch(`/v1/projects/${pid}/graph/relations`, {
      method: 'POST',
      body: JSON.stringify({
        fromItemId: inspected.value.id,
        toItemId: newRelTarget.value.trim(),
        relationType: newRelType.value
      })
    })
    notify('Vínculo criado no Grafo!', `${inspected.value.id} —[${newRelType.value}]→ ${newRelTarget.value}`)
    newRelTarget.value = ''
    await loadItemDetails(inspected.value)
  } catch (err) {
    notify('Erro ao vincular no grafo', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingRelation.value = false
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

        <div class="flex items-center gap-2">
          <UInput v-model="searchQuery" placeholder="Filtrar título, tag, conteúdo..." icon="i-lucide-search" size="sm" class="w-60" />
          <USelect v-if="activeSubTab === 'all'" v-model="typeFilter" :items="typeOptions" size="sm" class="w-40" />
          <UButton size="sm" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="emit('refresh'); loadSkills()" />
        </div>
      </div>

      <!-- SUB-TAB: ALL KNOWLEDGE -->
      <UCard v-if="activeSubTab === 'all'">
        <UiEmptyState
          v-if="filteredItems.length === 0"
          icon="i-lucide-book-open"
          title="Nenhum item encontrado"
          description="Crie uma Skill, Spec, importe PDF/DOCX/MD ou sincronize .brain/."
        />
        <UTable
          v-else
          :data="filteredItems"
          :columns="[
            { accessorKey: 'id', header: 'ID' },
            { accessorKey: 'title', header: 'Título' },
            { accessorKey: 'type', header: 'Tipo' },
            { accessorKey: 'version', header: 'Versão' },
            { accessorKey: 'status', header: 'Status' },
            { accessorKey: 'accessPolicyId', header: 'Política' },
            { id: 'actions', header: '' }
          ]"
        >
          <template #id-cell="{ row }">
            <span class="font-mono text-xs font-semibold">{{ row.original.id }}</span>
          </template>
          <template #type-cell="{ row }">
            <UBadge
              :color="row.original.type === 'skill' ? 'primary' : row.original.type === 'spec' ? 'info' : 'neutral'"
              variant="outline"
              size="xs"
            >
              {{ row.original.type }}
            </UBadge>
          </template>
          <template #version-cell="{ row }">
            <span class="font-mono text-xs text-muted">v{{ row.original.version ?? 1 }}</span>
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

      <!-- SUB-TAB: SKILLS MCP -->
      <div v-else-if="activeSubTab === 'skills'" class="space-y-4">
        <UAlert
          color="primary"
          variant="subtle"
          icon="i-lucide-bot"
          title="Skills Centralizadas via MCP (.brain/skills)"
          description="Qualquer agente conectado ao Brain (Cursor, Claude Code, NanoClaw, Brain Runner) descobre e carrega estas skills (do projeto e globais __org__) pelas tools brain_list_skills e brain_get_skill."
        />

        <UiEmptyState
          v-if="skillsList.length === 0"
          icon="i-lucide-sparkles"
          title="Nenhuma Skill cadastrada"
          description="Crie sua primeira Skill (estilo SKILL.md) para padronizar fluxos entre todos os seus agentes."
        >
          <UButton v-if="hasPermission('knowledge:write')" icon="i-lucide-sparkles" @click="openCreateModal('skill')">
            Criar Primeira Skill
          </UButton>
        </UiEmptyState>

        <div v-else v-auto-animate class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <UCard v-for="skill in skillsList" :key="`${skill.projectId}-${skill.id}`" variant="subtle">
            <div class="space-y-3">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <h3 class="font-semibold text-sm truncate">{{ skill.title }}</h3>
                    <UBadge v-if="skill.scope === 'org' || skill.projectId === '__org__'" color="info" variant="solid" size="xs">
                      Global (__org__)
                    </UBadge>
                    <UBadge :color="skill.status === 'approved' ? 'success' : 'warning'" variant="subtle" size="xs">
                      {{ skill.status }}
                    </UBadge>
                  </div>
                  <code class="text-[11px] text-muted">{{ skill.id }} · v{{ skill.version ?? 1 }}</code>
                </div>
                <div class="flex gap-1 shrink-0">
                  <UButton size="xs" variant="soft" icon="i-lucide-eye" @click="openInspector(skill, 'read')">Abrir</UButton>
                  <UButton
                    v-if="hasPermission('knowledge:write')"
                    size="xs"
                    variant="ghost"
                    icon="i-lucide-pencil"
                    @click="openInspector(skill, 'edit')"
                  />
                </div>
              </div>

              <p class="text-xs text-muted line-clamp-3 whitespace-pre-line">
                {{ skill.summary || skill.content }}
              </p>

              <div class="flex flex-wrap gap-1 pt-2 border-t border-default">
                <UBadge v-for="tag in (skill.tags ?? [])" :key="tag" color="primary" variant="outline" size="xs">
                  #{{ tag }}
                </UBadge>
              </div>
            </div>
          </UCard>
        </div>
      </div>

      <!-- SUB-TAB: SPECS & PLANNING -->
      <div v-else-if="activeSubTab === 'specs'" class="space-y-4">
        <UiEmptyState
          v-if="specsList.length === 0"
          icon="i-lucide-file-code-2"
          title="Nenhuma Spec registrada ainda"
          description="Registre especificações técnicas (.brain/specs) para alimentar o Brain Runner e a Análise de Impacto."
        >
          <UButton v-if="hasPermission('knowledge:write')" icon="i-lucide-file-code-2" @click="openCreateModal('spec')">
            Registrar Primeira Spec
          </UButton>
        </UiEmptyState>

        <div v-else v-auto-animate class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <UCard v-for="spec in specsList" :key="spec.id" variant="subtle">
            <div class="space-y-3">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <h3 class="font-semibold text-sm truncate">{{ spec.title }}</h3>
                    <UBadge :color="spec.status === 'approved' ? 'success' : 'warning'" variant="subtle" size="xs">
                      {{ spec.status }}
                    </UBadge>
                  </div>
                  <code class="text-[11px] text-muted">{{ spec.id }} · v{{ spec.version ?? 1 }}</code>
                </div>
                <div class="flex gap-1 shrink-0">
                  <UButton
                    v-if="hasPermission('runner:execute')"
                    size="xs"
                    color="primary"
                    variant="ghost"
                    icon="i-lucide-play"
                    title="Gerar tarefas (- [ ]) e enviar ao Runner"
                    @click="planSpecTasks(spec)"
                  />
                  <UButton
                    v-if="hasPermission('knowledge:approve') && spec.status !== 'approved'"
                    size="xs"
                    color="success"
                    variant="soft"
                    icon="i-lucide-check"
                    @click="quickApprove(spec.id)"
                  >
                    Aprovar
                  </UButton>
                  <UButton
                    size="xs"
                    variant="ghost"
                    icon="i-lucide-network"
                    title="Vínculos no Grafo"
                    @click="openInspector(spec, 'relations')"
                  />
                  <UButton
                    v-if="hasPermission('knowledge:write')"
                    size="xs"
                    variant="soft"
                    icon="i-lucide-pencil"
                    @click="openInspector(spec, 'edit')"
                  >
                    Editar
                  </UButton>
                </div>
              </div>

              <p class="text-xs text-muted line-clamp-3 whitespace-pre-line">{{ spec.content }}</p>

              <div class="flex flex-wrap gap-1 pt-2 border-t border-default">
                <UBadge v-for="tag in (spec.tags ?? [])" :key="tag" color="info" variant="outline" size="xs">
                  #{{ tag }}
                </UBadge>
              </div>
            </div>
          </UCard>
        </div>
      </div>
    </div>

    <!-- Modal: Upload Visual de Documento ou URL -->
    <UModal v-model:open="uploadOpen" title="Importar Arquivo ou URL para o Hub">
      <template #body>
        <div class="space-y-4">
          <UiSegmentedTabs
            v-model="uploadMode"
            :items="[
              { label: 'Arquivo (PDF/DOCX/MD)', value: 'file', icon: 'i-lucide-file-up' },
              { label: 'URL Externa', value: 'url', icon: 'i-lucide-globe' }
            ]"
          />

          <div v-if="uploadMode === 'file'" class="space-y-4">
            <div
              class="border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer"
              :class="dragActive ? 'border-primary bg-primary/10' : 'border-default hover:border-primary/50'"
              @dragover.prevent="dragActive = true"
              @dragleave.prevent="dragActive = false"
              @drop.prevent="handleDrop"
            >
              <UIcon name="i-lucide-file-up" class="w-8 h-8 text-primary mx-auto mb-2" />
              <div class="text-sm font-medium">
                {{ selectedFile ? selectedFile.name : 'Arraste PDF, DOCX, HTML, CSV ou Markdown aqui' }}
              </div>
              <p class="text-xs text-muted mt-1">Parser nativo TypeScript (unpdf, mammoth, turndown) + scan de segredos</p>
              <input
                type="file"
                accept=".pdf,.docx,.pptx,.xlsx,.html,.csv,.md,.txt"
                class="mt-3 text-xs"
                @change="(e: Event) => onFileSelected((e.target as HTMLInputElement).files?.[0])"
              >
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <UFormField label="Política de Acesso">
                <USelect
                  v-model="uploadPolicy"
                  :items="['public-org', 'internal-project', 'confidential-business', 'restricted-security']"
                  class="w-full"
                />
              </UFormField>
              <UFormField v-if="selectedFile && /\.(md|txt)$/i.test(selectedFile.name)" label="Importar Markdown como">
                <USelect
                  v-model="uploadMdType"
                  :items="[
                    { label: 'Documento', value: 'document' },
                    { label: 'Spec', value: 'spec' },
                    { label: 'Skill MCP', value: 'skill' }
                  ]"
                  class="w-full"
                />
              </UFormField>
            </div>

            <div class="flex justify-end gap-2">
              <UButton color="neutral" variant="ghost" @click="uploadOpen = false">Cancelar</UButton>
              <UButton :disabled="!selectedFile" :loading="uploading" icon="i-lucide-upload" @click="onUploadSubmit">
                Processar &amp; Salvar
              </UButton>
            </div>
          </div>

          <div v-else class="space-y-4">
            <UFormField label="URL da Documentação / Artigo">
              <UInput v-model="uploadUrl" placeholder="https://docs.exemplo.com/guia" icon="i-lucide-globe" class="w-full" />
            </UFormField>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <UFormField label="Salvar como">
                <USelect
                  v-model="uploadMdType"
                  :items="[
                    { label: 'Documento', value: 'document' },
                    { label: 'Spec', value: 'spec' },
                    { label: 'Skill MCP', value: 'skill' }
                  ]"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="Política de Acesso">
                <USelect
                  v-model="uploadPolicy"
                  :items="['public-org', 'internal-project', 'confidential-business', 'restricted-security']"
                  class="w-full"
                />
              </UFormField>
            </div>
            <div class="flex justify-end gap-2">
              <UButton color="neutral" variant="ghost" @click="uploadOpen = false">Cancelar</UButton>
              <UButton :disabled="!uploadUrl.trim()" :loading="uploading" icon="i-lucide-download" @click="onUrlImportSubmit">
                Extrair &amp; Salvar
              </UButton>
            </div>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Modal: Create Knowledge / Skill / Spec -->
    <UModal v-model:open="createOpen" title="Adicionar ao Hub de Conhecimento">
      <template #body>
        <UForm :schema="createSchema" :state="createForm" class="space-y-4" @submit="onCreateItem">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="Tipo" name="type">
              <USelect
                v-model="createForm.type"
                :items="[
                  { label: 'Skill MCP (SKILL.md)', value: 'skill' },
                  { label: 'Spec / Planejamento', value: 'spec' },
                  { label: 'Regra de Negócio', value: 'business_rule' },
                  { label: 'ADR (Decisão Arquitetural)', value: 'architecture_decision' },
                  { label: 'Requisito', value: 'requirement' },
                  { label: 'Documento', value: 'document' }
                ]"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Política de Acesso" name="accessPolicyId">
              <USelect
                v-model="createForm.accessPolicyId"
                :items="['public-org', 'internal-project', 'confidential-business', 'restricted-security']"
                class="w-full"
              />
            </UFormField>
          </div>

          <UFormField label="Título" name="title">
            <UInput v-model="createForm.title" placeholder="Ex.: Skill de Code Review Seguro" class="w-full" />
          </UFormField>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="ID Opcional (Slug)">
              <UInput v-model="createForm.id" placeholder="Gerado automaticamente se vazio" class="w-full font-mono" />
            </UFormField>
            <UFormField label="Tags (separadas por vírgula)">
              <UInput v-model="createForm.tagsCsv" placeholder="skill, mcp, security" class="w-full" />
            </UFormField>
          </div>

          <UCheckbox
            v-if="createForm.type === 'skill'"
            v-model="createForm.globalOrg"
            label="Compartilhar com toda a Organização (__org__) para todos os projetos e agentes"
          />

          <UFormField label="Conteúdo Markdown" name="content">
            <UiMarkdownEditor v-model="createForm.content" height="320px" />
          </UFormField>

          <div class="flex justify-end gap-2 pt-2">
            <UButton color="neutral" variant="ghost" @click="createOpen = false">Cancelar</UButton>
            <UButton type="submit" :loading="creating" icon="i-lucide-save">Salvar no Hub</UButton>
          </div>
        </UForm>
      </template>
    </UModal>

    <!-- Slideover: Read, Edit, Versions/Diff & Graph Relations -->
    <USlideover
      :open="Boolean(inspected)"
      :title="inspected?.title"
      @update:open="val => { if (!val) inspected = null }"
    >
      <template #body>
        <div v-if="inspected" class="space-y-4">
          <div class="flex flex-wrap items-center gap-1.5">
            <UBadge color="primary" variant="outline" size="xs">{{ inspected.type }}</UBadge>
            <UBadge :color="inspected.status === 'approved' ? 'success' : 'warning'" variant="subtle" size="xs">
              {{ inspected.status }}
            </UBadge>
            <UBadge color="neutral" variant="subtle" size="xs" class="font-mono">v{{ inspected.version ?? 1 }}</UBadge>
            <UBadge v-if="inspected.scope === 'org' || inspected.projectId === '__org__'" color="info" variant="solid" size="xs">
              Global (__org__)
            </UBadge>
          </div>

          <UiSegmentedTabs
            v-model="slideTab"
            :items="[
              { label: 'Leitura', value: 'read', icon: 'i-lucide-eye' },
              ...(hasPermission('knowledge:write') ? [{ label: 'Editar', value: 'edit', icon: 'i-lucide-pencil' }] : []),
              { label: 'Histórico', value: 'versions', icon: 'i-lucide-history', badge: versionsList.length },
              { label: 'Grafo', value: 'relations', icon: 'i-lucide-network', badge: relationsList.length }
            ]"
          />

          <!-- TAB: READ -->
          <div v-if="slideTab === 'read'" class="space-y-3">
            <div class="text-xs font-mono text-muted">{{ inspected.id }} · {{ inspected.accessPolicyId }}</div>
            <pre class="text-xs whitespace-pre-wrap leading-relaxed bg-elevated/60 p-4 rounded-xl border border-default">{{ inspected.content }}</pre>
          </div>

          <!-- TAB: EDIT -->
          <div v-else-if="slideTab === 'edit'" class="space-y-3">
            <UFormField label="Título">
              <UInput v-model="editForm.title" class="w-full" />
            </UFormField>
            <div class="grid grid-cols-2 gap-2">
              <UFormField label="Status">
                <USelect v-model="editForm.status" :items="['draft', 'approved', 'deprecated', 'superseded']" class="w-full" />
              </UFormField>
              <UFormField label="Política">
                <USelect
                  v-model="editForm.accessPolicyId"
                  :items="['public-org', 'internal-project', 'confidential-business', 'restricted-security']"
                  class="w-full"
                />
              </UFormField>
            </div>
            <UFormField label="Tags (vírgula)">
              <UInput v-model="editForm.tagsCsv" class="w-full" />
            </UFormField>
            <UFormField label="Conteúdo Markdown">
              <UiMarkdownEditor v-model="editForm.content" height="360px" />
            </UFormField>
            <div class="flex justify-end gap-2 pt-2">
              <UButton color="neutral" variant="ghost" @click="slideTab = 'read'">Cancelar</UButton>
              <UButton :loading="savingEdit" icon="i-lucide-save" @click="onSaveEdit">Salvar Nova Versão</UButton>
            </div>
          </div>

          <!-- TAB: VERSIONS & DIFF -->
          <div v-else-if="slideTab === 'versions'" class="space-y-3">
            <div class="flex flex-wrap gap-1.5">
              <UButton
                v-for="(v, idx) in versionsList"
                :key="v.version ?? idx"
                size="xs"
                :variant="selectedVersionIdx === idx ? 'solid' : 'outline'"
                :color="selectedVersionIdx === idx ? 'primary' : 'neutral'"
                @click="selectedVersionIdx = idx"
              >
                v{{ v.version ?? (versionsList.length - idx) }}
              </UButton>
            </div>

            <div v-if="versionsList[selectedVersionIdx]" class="space-y-2">
              <div class="flex items-center justify-between text-xs text-muted">
                <span>Diff vs versão anterior</span>
                <UButton
                  v-if="hasPermission('knowledge:write') && selectedVersionIdx > 0"
                  size="xs"
                  variant="soft"
                  icon="i-lucide-rotate-ccw"
                  @click="restoreVersion(versionsList[selectedVersionIdx]!)"
                >
                  Restaurar esta Versão
                </UButton>
              </div>
              <div class="rounded-xl border border-default bg-slate-950 p-3 font-mono text-[11px] max-h-96 overflow-auto space-y-0.5">
                <div
                  v-for="(line, i) in versionDiffLines"
                  :key="i"
                  class="px-1.5 rounded"
                  :class="
                    line.kind === 'add'
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : line.kind === 'del'
                        ? 'bg-rose-500/15 text-rose-300 line-through'
                        : 'text-slate-300'
                  "
                >
                  <span class="select-none mr-1.5 opacity-60">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ' }}</span>{{ line.text || ' ' }}
                </div>
              </div>
            </div>
          </div>

          <!-- TAB: GRAPH RELATIONS -->
          <div v-else-if="slideTab === 'relations'" class="space-y-4">
            <div v-if="hasPermission('knowledge:write')" class="p-3 rounded-xl border border-default bg-elevated/40 space-y-3">
              <div class="text-xs font-semibold">Vincular Item no Grafo</div>
              <USelect
                v-model="newRelType"
                :items="['IMPACTS', 'DEPENDS_ON', 'VERIFIED_BY', 'IMPLEMENTS', 'RELATES_TO']"
                size="sm"
                class="w-full"
              />
              <USelect
                v-model="newRelTarget"
                :items="items.filter(i => i.id !== inspected?.id).map(i => ({ label: `${i.id} — ${i.title}`, value: i.id }))"
                placeholder="Selecione o item conectado..."
                size="sm"
                class="w-full"
              />
              <UButton
                size="xs"
                block
                :disabled="!newRelTarget"
                :loading="savingRelation"
                icon="i-lucide-link"
                @click="onAddRelation"
              >
                Criar Vínculo no Grafo
              </UButton>
            </div>

            <UiEmptyState
              v-if="relationsList.length === 0"
              compact
              icon="i-lucide-network"
              title="Sem vínculos registrados"
              description="Vincule regras, ADRs, código ou testes para alimentar a Análise de Impacto."
            />
            <div v-else class="space-y-2">
              <div
                v-for="rel in relationsList"
                :key="`${rel.itemId}-${rel.via}`"
                class="flex items-center justify-between p-2.5 rounded-lg border border-default bg-elevated/30"
              >
                <span class="font-mono text-xs font-semibold">{{ rel.itemId }}</span>
                <UBadge color="primary" variant="subtle" size="xs">{{ rel.via }}</UBadge>
              </div>
            </div>
          </div>
        </div>
      </template>
    </USlideover>
  </div>
</template>
