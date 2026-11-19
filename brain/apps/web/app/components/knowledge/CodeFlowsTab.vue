<script setup lang="ts">
interface CodeFlowStep {
  order: number
  layer: string
  componentOrClass?: string
  fnName: string
  filePath?: string
  inputs?: string
  outputs?: string
  sideEffects?: string
}

interface CodeFlowItem {
  id: string
  title: string
  summary: string
  entrypoint: string
  layers: string[]
  steps: CodeFlowStep[]
  mermaidDiagram: string
  relatedIds: string[]
}

const props = defineProps<{
  projectId: string
}>()

const { apiFetch, notify, liveSyncTick } = useBrainApi()
const flows = ref<CodeFlowItem[]>([])
const loading = ref(false)
const selectedFlowId = ref<string | null>(null)
const modalOpen = ref(false)
const saving = ref(false)
const copied = ref(false)

const form = reactive({
  title: '',
  entrypoint: '',
  description: '',
  relatedRuleIds: '',
  steps: [
    { layer: 'frontend', componentOrClass: '', fnName: '', filePath: '', inputs: '', outputs: '', sideEffects: '' },
    { layer: 'api', componentOrClass: '', fnName: '', filePath: '', inputs: '', outputs: '', sideEffects: '' },
    { layer: 'service', componentOrClass: '', fnName: '', filePath: '', inputs: '', outputs: '', sideEffects: '' },
    { layer: 'database', componentOrClass: '', fnName: '', filePath: '', inputs: '', outputs: '', sideEffects: '' }
  ]
})

const selectedFlow = computed(() => flows.value.find(f => f.id === selectedFlowId.value) ?? flows.value[0] ?? null)

async function loadFlows() {
  if (!props.projectId) return
  loading.value = true
  try {
    const res = await apiFetch<{ flows?: CodeFlowItem[] }>(`/v1/projects/${encodeURIComponent(props.projectId)}/code-flows`)
    flows.value = res.flows ?? []
    if (!selectedFlowId.value && flows.value.length > 0) selectedFlowId.value = flows.value[0]!.id
  } catch {
    flows.value = []
  } finally {
    loading.value = false
  }
}

onMounted(loadFlows)
watch([() => props.projectId, liveSyncTick], loadFlows)

function addStep() {
  form.steps.push({ layer: 'domain', componentOrClass: '', fnName: '', filePath: '', inputs: '', outputs: '', sideEffects: '' })
}

function removeStep(idx: number) {
  if (form.steps.length > 1) form.steps.splice(idx, 1)
}

async function submitFlow() {
  const validSteps = form.steps.filter(s => s.fnName.trim() && s.layer.trim())
  if (!form.title.trim() || !form.entrypoint.trim() || validSteps.length === 0) {
    notify('Campos obrigatórios', 'Informe título, entrypoint e ao menos 1 etapa com camada e função.', 'warning')
    return
  }
  saving.value = true
  try {
    const res = await apiFetch<{ flowId: string }>(`/v1/projects/${encodeURIComponent(props.projectId)}/code-flows`, {
      method: 'POST',
      body: JSON.stringify({
        title: form.title.trim(),
        entrypoint: form.entrypoint.trim(),
        description: form.description.trim() || form.title.trim(),
        relatedRuleIds: form.relatedRuleIds.split(',').map(s => s.trim()).filter(Boolean),
        steps: validSteps.map((s, idx) => ({ order: idx + 1, ...s }))
      })
    })
    notify('Fluxo registrado', `${res.flowId} salvo com diagrama Mermaid.`, 'success')
    modalOpen.value = false
    form.title = ''
    form.entrypoint = ''
    form.description = ''
    form.relatedRuleIds = ''
    await loadFlows()
    selectedFlowId.value = res.flowId
  } catch (err) {
    notify('Erro ao salvar fluxo', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    saving.value = false
  }
}

async function copyMermaid(code: string) {
  await navigator.clipboard.writeText(code).catch(() => {})
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 class="font-semibold text-sm flex items-center gap-2">
            <UIcon name="i-lucide-workflow" class="size-4 text-primary" />
            Fluxos de Funções &amp; Ciclo de Vida do Sistema ({{ flows.length }})
          </h3>
          <p class="text-xs text-muted">Documente e visualize o ciclo de vida completo de funções, classes e chamadas entre camadas (UI → API → Domínio → Banco) com diagrama Mermaid.</p>
        </div>
        <div class="flex items-center gap-2">
          <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="loadFlows" />
          <UButton size="xs" color="primary" icon="i-lucide-plus" @click="modalOpen = true">
            Registrar Fluxo
          </UButton>
        </div>
      </div>
    </template>

    <UiEmptyState
      v-if="flows.length === 0"
      compact
      icon="i-lucide-workflow"
      title="Nenhum fluxo de função registrado"
      description="Registre aqui ou via MCP (brain_register_code_flow) o passo a passo de execução entre classes, funções e camadas."
    />

    <div v-else class="grid grid-cols-1 lg:grid-cols-12 gap-4">
      <div class="lg:col-span-4 space-y-2 max-h-[420px] overflow-y-auto pr-1">
        <button
          v-for="f in flows"
          :key="f.id"
          type="button"
          class="w-full text-left p-3 rounded-lg border transition-colors"
          :class="selectedFlow?.id === f.id ? 'border-primary bg-primary/10' : 'border-default bg-elevated/30 hover:bg-elevated/60'"
          @click="selectedFlowId = f.id"
        >
          <div class="font-semibold text-xs text-highlighted truncate">{{ f.title }}</div>
          <div class="text-[11px] font-mono text-muted truncate mt-0.5">{{ f.entrypoint || f.id }}</div>
          <div class="flex flex-wrap gap-1 mt-1.5">
            <UBadge v-for="l in f.layers" :key="l" size="xs" variant="subtle" color="info">{{ l }}</UBadge>
            <UBadge size="xs" variant="outline" color="neutral">{{ f.steps.length }} etapas</UBadge>
          </div>
        </button>
      </div>

      <div v-if="selectedFlow" class="lg:col-span-8 space-y-4">
        <div class="p-3.5 rounded-lg border border-default bg-elevated/30 space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div class="font-semibold text-sm text-highlighted">{{ selectedFlow.title }}</div>
              <div class="text-xs font-mono text-primary">{{ selectedFlow.entrypoint }}</div>
            </div>
            <div class="flex flex-wrap gap-1">
              <UBadge v-for="rid in selectedFlow.relatedIds" :key="rid" size="xs" variant="subtle" color="warning">{{ rid }}</UBadge>
            </div>
          </div>

          <div class="space-y-2 pt-2">
            <div
              v-for="step in selectedFlow.steps"
              :key="step.order"
              class="p-2.5 rounded-md border border-default/70 bg-default flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
            >
              <div class="space-y-0.5">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <UBadge size="xs" color="primary" variant="solid">{{ step.order }}</UBadge>
                  <UBadge size="xs" color="info" variant="subtle">{{ step.layer }}</UBadge>
                  <span class="font-mono font-semibold text-highlighted">
                    {{ step.componentOrClass ? `${step.componentOrClass}.` : '' }}{{ step.fnName }}
                  </span>
                </div>
                <div v-if="step.filePath" class="text-[11px] font-mono text-muted">{{ step.filePath }}</div>
              </div>
              <div class="text-[11px] text-muted space-y-0.5 sm:text-right">
                <div v-if="step.inputs">In: <span class="text-highlighted">{{ step.inputs }}</span></div>
                <div v-if="step.outputs">Out: <span class="text-highlighted">{{ step.outputs }}</span></div>
                <div v-if="step.sideEffects" class="text-warning">Efeitos: {{ step.sideEffects }}</div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="selectedFlow.mermaidDiagram" class="space-y-1.5">
          <div class="text-xs font-semibold text-muted">Diagrama Mermaid do Ciclo de Vida</div>
          <MermaidDiagram :code="selectedFlow.mermaidDiagram" max-height-class="max-h-96" />
        </div>
      </div>
    </div>

    <UModal v-model:open="modalOpen" title="Registrar Fluxo de Função / Ciclo de Vida" class="max-w-2xl">
      <template #body>
        <div class="space-y-3">
          <UFormField label="Título do Fluxo">
            <UInput v-model="form.title" placeholder="Ex.: Autenticação OAuth 2.1 PKCE End-to-End" class="w-full" />
          </UFormField>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="Entrypoint (Início)">
              <UInput v-model="form.entrypoint" placeholder="GET /oauth/authorize" class="w-full font-mono text-xs" />
            </UFormField>
            <UFormField label="Regras / ADRs Relacionados (opcional)">
              <UInput v-model="form.relatedRuleIds" placeholder="BR-BRAIN-001, ADR-BRAIN-001" class="w-full font-mono text-xs" />
            </UFormField>
          </div>
          <UFormField label="Descrição do Ciclo de Vida">
            <UTextarea v-model="form.description" :rows="2" placeholder="Descreva o propósito e comportamento início-ao-fim..." class="w-full" />
          </UFormField>
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold">Etapas por Camada, Classe e Função</span>
              <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="addStep">Etapa</UButton>
            </div>
            <div v-for="(s, idx) in form.steps" :key="idx" class="p-2.5 rounded-lg border border-default grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
              <UInput v-model="s.layer" placeholder="Camada (api, service...)" size="xs" class="sm:col-span-3" />
              <UInput v-model="s.componentOrClass" placeholder="Classe / Módulo" size="xs" class="sm:col-span-3 font-mono" />
              <UInput v-model="s.fnName" placeholder="Função (obrigatório)" size="xs" class="sm:col-span-3 font-mono" />
              <UInput v-model="s.filePath" placeholder="Arquivo" size="xs" class="sm:col-span-2 font-mono" />
              <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" class="sm:col-span-1" @click="removeStep(idx)" />
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="ghost" @click="modalOpen = false">Cancelar</UButton>
          <UButton color="primary" :loading="saving" @click="submitFlow">Salvar Fluxo</UButton>
        </div>
      </template>
    </UModal>
  </UCard>
</template>
