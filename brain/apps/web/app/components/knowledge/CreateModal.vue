<script setup lang="ts">
import {
  FORMAT_TEMPLATES,
  KNOWLEDGE_FORMAT_OPTIONS,
  KNOWLEDGE_LAYERS,
  type KnowledgeFormat,
  type KnowledgeLayer
} from './knowledgeUtils'

const props = defineProps<{
  open: boolean
  projectId: string
  typeOptions: string[]
  initialType?: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'created'): void
}>()

const { apiFetch, notify } = useBrainApi()

const layerSelectItems = KNOWLEDGE_LAYERS.map(l => ({ label: l.label, value: l.id }))
const formatSelectItems = KNOWLEDGE_FORMAT_OPTIONS.map(f => ({ label: f.label, value: f.value }))

const creating = ref(false)
const createForm = ref({
  id: '',
  title: '',
  type: 'doc',
  layer: 'architecture' as KnowledgeLayer,
  format: 'mermaid' as KnowledgeFormat,
  summary: '',
  content: '',
  accessPolicyId: 'internal-project',
  status: 'approved' as 'draft' | 'approved',
  globalOrg: false,
  tagsCsv: ''
})

function applyFormatTemplate(fmt: KnowledgeFormat) {
  createForm.value.format = fmt
  createForm.value.content = FORMAT_TEMPLATES[fmt] ?? ''
}

watch(
  () => [props.open, props.initialType] as const,
  ([isOpen, initType]) => {
    if (!isOpen) return
    const t = initType || 'doc'
    createForm.value.id = ''
    createForm.value.title = ''
    createForm.value.summary = ''
    createForm.value.type = t
    createForm.value.globalOrg = t === 'skill'
    createForm.value.tagsCsv = t === 'skill' ? 'skill, mcp' : ''
    if (t === 'skill') {
      createForm.value.layer = 'operations'
      createForm.value.format = 'markdown'
      createForm.value.content = '---\nname: nova-skill\ndescription: Descreva quando agentes devem ativar esta skill.\n---\n\n# Objetivo\n\n## Passos\n1. '
    } else if (t === 'spec') {
      createForm.value.layer = 'product'
      createForm.value.format = 'mermaid'
      createForm.value.content = '# Especificação Técnica\n\n```mermaid\nflowchart LR\n  A[Spec] --> B[Implementação]\n  B --> C[Testes]\n```\n\n## Tarefas\n- [ ] Definir contrato\n- [ ] Implementar endpoint'
    } else {
      createForm.value.layer = 'architecture'
      createForm.value.format = 'mermaid'
      createForm.value.content = FORMAT_TEMPLATES.mermaid
    }
  }
)

async function onCreateItem() {
  creating.value = true
  try {
    const rawTags = createForm.value.tagsCsv.split(',').map(s => s.trim()).filter(Boolean)
    const filteredTags = rawTags.filter(t => !t.startsWith('layer:') && !t.startsWith('format:'))
    const tags = [...new Set([...filteredTags, `layer:${createForm.value.layer}`, `format:${createForm.value.format}`])]
    await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/knowledge`, {
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
    emit('update:open', false)
    emit('created')
  } catch (err) {
    notify('Erro ao salvar item', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <UModal :open="open" title="Novo Conhecimento Estruturado" class="max-w-3xl" @update:open="val => emit('update:open', val)">
    <template #body>
      <UForm :state="createForm" class="space-y-4" @submit="onCreateItem">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <UFormField label="Camada de Conhecimento" required>
            <USelect v-model="createForm.layer" :items="layerSelectItems" class="w-full" />
          </UFormField>
          <UFormField label="Formato Visual / Diagrama" required>
            <USelect
              v-model="createForm.format"
              :items="formatSelectItems"
              class="w-full"
              @update:model-value="val => applyFormatTemplate(val as KnowledgeFormat)"
            />
          </UFormField>
        </div>

        <div class="flex flex-wrap items-center gap-1.5 p-2 rounded-lg bg-slate-900/60 border border-slate-800/80">
          <span class="text-[11px] text-slate-400 mr-1">Inserir Template:</span>
          <UButton
            v-for="f in KNOWLEDGE_FORMAT_OPTIONS"
            :key="f.value"
            size="xs"
            :variant="createForm.format === f.value ? 'soft' : 'ghost'"
            color="primary"
            @click="applyFormatTemplate(f.value)"
          >
            {{ f.label }}
          </UButton>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <UFormField label="Tipo Técnico" required>
            <USelect v-model="createForm.type" :items="typeOptions" class="w-full" />
          </UFormField>
          <UFormField label="Status">
            <USelect v-model="createForm.status" :items="['approved', 'draft']" class="w-full" />
          </UFormField>
          <UFormField label="Política CASL">
            <USelect
              v-model="createForm.accessPolicyId"
              :items="['public-org', 'internal-project', 'confidential-business', 'restricted-security']"
              class="w-full"
            />
          </UFormField>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <UFormField label="Título" required>
            <UInput v-model="createForm.title" placeholder="Ex: Topologia de Microsserviços" required class="w-full" />
          </UFormField>
          <UFormField label="ID (opcional)">
            <UInput v-model="createForm.id" placeholder="auto-gerado se vazio" class="w-full" />
          </UFormField>
        </div>

        <UFormField label="Resumo / Objetivo (opcional)">
          <UInput v-model="createForm.summary" placeholder="Resumo curto para agentes MCP" class="w-full" />
        </UFormField>

        <div v-if="createForm.type === 'skill'" class="p-3 rounded-xl border border-primary/30 bg-primary/5">
          <UCheckbox
            v-model="createForm.globalOrg"
            label="Skill Global da Organização (__org__) — compartilhada com todos os projetos via MCP"
          />
        </div>

        <UFormField label="Tags (vírgula)">
          <UInput v-model="createForm.tagsCsv" placeholder="ex: arquitetura, fluxos, seguranca" class="w-full" />
        </UFormField>

        <UFormField label="Conteúdo (Markdown, Mermaid, Fluxo JSON, YAML, Código)">
          <UiMarkdownEditor v-model="createForm.content" height="320px" />
        </UFormField>

        <div class="flex justify-end gap-2 pt-2">
          <UButton color="neutral" variant="ghost" @click="emit('update:open', false)">Cancelar</UButton>
          <UButton type="submit" :loading="creating" icon="i-lucide-save">Salvar no Hub</UButton>
        </div>
      </UForm>
    </template>
  </UModal>
</template>
