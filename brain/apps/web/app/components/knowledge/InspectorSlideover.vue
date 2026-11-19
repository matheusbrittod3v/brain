<script setup lang="ts">
import KnowledgeVisualizer from './KnowledgeVisualizer.vue'
import {
  computeKnowledgeQuality,
  inferKnowledgeFormat,
  qualityColor,
  type KnowledgeItemRow
} from './knowledgeUtils'

const props = defineProps<{
  item: KnowledgeItemRow | null
  initialTab: 'read' | 'edit' | 'versions' | 'relations'
  projectId: string
  allItems: KnowledgeItemRow[]
  canWrite: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'updated', item: KnowledgeItemRow): void
}>()

const { apiFetch, notify } = useBrainApi()

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
  const pid = encodeURIComponent(item.projectId || props.projectId)
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
  relationsList.value = dRes.status === 'fulfilled' ? (dRes.value.relations ?? []) : []
}

watch(
  () => [props.item, props.initialTab] as const,
  ([item, tab]) => {
    if (!item) return
    slideTab.value = tab
    editForm.value.title = item.title
    editForm.value.type = item.type
    editForm.value.accessPolicyId = item.accessPolicyId
    editForm.value.status = (item.status as 'draft' | 'approved' | 'deprecated' | 'superseded') || 'draft'
    editForm.value.tagsCsv = (item.tags ?? []).join(', ')
    editForm.value.content = item.content
    void loadItemDetails(item)
  },
  { immediate: true }
)

const versionDiffLines = computed(() => {
  const current = versionsList.value[selectedVersionIdx.value]
  if (!current) return []
  const prev = versionsList.value[selectedVersionIdx.value + 1]
  if (!prev) {
    return current.content.split('\n').map((line: string) => ({ kind: 'same' as const, text: line }))
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

async function onSaveEdit() {
  if (!props.item) return
  savingEdit.value = true
  try {
    const tags = editForm.value.tagsCsv.split(',').map(s => s.trim()).filter(Boolean)
    const targetPid = encodeURIComponent(props.item.projectId || props.projectId)
    const res = await apiFetch<{ item: KnowledgeItemRow }>(
      `/v1/projects/${targetPid}/knowledge/${encodeURIComponent(props.item.id)}`,
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
    slideTab.value = 'read'
    notify('Conhecimento atualizado!', `Versão v${res.item.version ?? 1} salva no PostgreSQL.`)
    emit('updated', res.item)
    await loadItemDetails(res.item)
  } catch (err) {
    notify('Erro ao atualizar', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingEdit.value = false
  }
}

async function restoreVersion(ver: KnowledgeItemRow) {
  if (!props.item) return
  editForm.value.content = ver.content
  editForm.value.title = ver.title
  await onSaveEdit()
}

async function onAddRelation() {
  if (!props.item || !newRelTarget.value.trim()) return
  savingRelation.value = true
  try {
    const pid = encodeURIComponent(props.item.projectId || props.projectId)
    await apiFetch(`/v1/projects/${pid}/graph/relations`, {
      method: 'POST',
      body: JSON.stringify({
        fromItemId: props.item.id,
        toItemId: newRelTarget.value.trim(),
        relationType: newRelType.value
      })
    })
    notify('Vínculo criado no Grafo!', `${props.item.id} —[${newRelType.value}]→ ${newRelTarget.value}`)
    newRelTarget.value = ''
    await loadItemDetails(props.item)
  } catch (err) {
    notify('Erro ao vincular no grafo', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingRelation.value = false
  }
}

const slideTabs = computed(() => [
  { label: 'Leitura', value: 'read', icon: 'i-lucide-eye' },
  ...(props.canWrite ? [{ label: 'Editar', value: 'edit', icon: 'i-lucide-pencil' }] : []),
  { label: 'Histórico', value: 'versions', icon: 'i-lucide-history', badge: versionsList.value.length },
  { label: 'Grafo', value: 'relations', icon: 'i-lucide-network', badge: relationsList.value.length }
])

const targetRelationOptions = computed(() =>
  props.allItems
    .filter(i => i.id !== props.item?.id)
    .map(i => ({ label: `${i.id} — ${i.title}`, value: i.id }))
)
</script>

<template>
  <USlideover
    :open="Boolean(item)"
    :title="item?.title"
    @update:open="val => { if (!val) emit('close') }"
  >
    <template #body>
      <div v-if="item" class="space-y-4">
        <div class="flex flex-wrap items-center gap-1.5">
          <UBadge color="primary" variant="outline" size="xs">{{ item.type }}</UBadge>
          <UBadge :color="item.status === 'approved' ? 'success' : 'warning'" variant="subtle" size="xs">
            {{ item.status }}
          </UBadge>
          <UBadge color="neutral" variant="subtle" size="xs" class="font-mono">v{{ item.version ?? 1 }}</UBadge>
          <UBadge v-if="item.scope === 'org' || item.projectId === '__org__'" color="info" variant="solid" size="xs">
            Global (__org__)
          </UBadge>
        </div>

        <UiSegmentedTabs v-model="slideTab" :items="slideTabs" />

        <div v-if="slideTab === 'read'" class="space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="text-xs font-mono text-muted">{{ item.id }} · {{ item.accessPolicyId }}</div>
            <UBadge :color="qualityColor(computeKnowledgeQuality(item).score)" variant="soft" size="xs">
              Qualidade {{ computeKnowledgeQuality(item).grade }} ({{ computeKnowledgeQuality(item).score }}%)
            </UBadge>
          </div>
          <div v-if="computeKnowledgeQuality(item).suggestions.length > 0" class="flex flex-wrap gap-1.5 text-[11px] text-amber-400">
            <span v-for="sug in computeKnowledgeQuality(item).suggestions" :key="sug" class="px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
              💡 {{ sug }}
            </span>
          </div>
          <KnowledgeVisualizer :content="item.content" :format="inferKnowledgeFormat(item)" />
        </div>

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
                v-if="canWrite && selectedVersionIdx > 0"
                size="xs"
                variant="soft"
                icon="i-lucide-rotate-ccw"
                @click="restoreVersion(versionsList[selectedVersionIdx]!)"
              >
                Restaurar esta Versão
              </UButton>
            </div>
            <div class="rounded-xl border border-default bg-elevated p-3 font-mono text-[11px] max-h-96 overflow-auto space-y-0.5">
              <div
                v-for="(line, i) in versionDiffLines"
                :key="i"
                class="px-1.5 rounded"
                :class="
                  line.kind === 'add'
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : line.kind === 'del'
                      ? 'bg-rose-500/15 text-rose-300 line-through'
                      : 'text-default'
                "
              >
                <span class="select-none mr-1.5 opacity-60">{{ line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ' }}</span>{{ line.text || ' ' }}
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="slideTab === 'relations'" class="space-y-4">
          <div v-if="canWrite" class="p-3 rounded-xl border border-default bg-elevated/40 space-y-3">
            <div class="text-xs font-semibold">Vincular Item no Grafo</div>
            <USelect
              v-model="newRelType"
              :items="['IMPACTS', 'DEPENDS_ON', 'VERIFIED_BY', 'IMPLEMENTS', 'RELATES_TO']"
              size="sm"
              class="w-full"
            />
            <USelect
              v-model="newRelTarget"
              :items="targetRelationOptions"
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
</template>
