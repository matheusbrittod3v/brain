<script setup lang="ts">
import { z } from 'zod'

export interface RunnerTaskItem {
  taskId: string
  instruction: string
  status: string
  priority: 'low' | 'normal' | 'high' | string
  createdAt?: string
  updatedAt?: string
  completedAt?: string
  provider?: string
  model?: string
  result?: string
  error?: string
  pendingQuestion?: {
    questionId: string
    question: string
  }
}

const props = defineProps<{
  tasks: RunnerTaskItem[]
  loading?: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

const { projectId, apiFetch, notify, hasPermission } = useBrainApi()

const runnerSchema = z.object({
  instruction: z.string().min(5, 'Descreva a tarefa (mín. 5 caracteres)'),
  priority: z.enum(['low', 'normal', 'high'])
})

const runnerState = reactive({
  instruction: '',
  priority: 'normal' as 'low' | 'normal' | 'high'
})

const dispatching = ref(false)
const cancellingId = ref<string | null>(null)
const statusFilter = ref<'all' | 'active' | 'completed' | 'failed'>('all')
const searchQuery = ref('')
const inspectedTask = ref<RunnerTaskItem | null>(null)

const priorityOptions: Array<{ value: 'low' | 'normal' | 'high'; label: string; icon: string; color: 'neutral' | 'primary' | 'error' }> = [
  { value: 'low', label: 'Baixa', icon: 'i-lucide-arrow-down', color: 'neutral' },
  { value: 'normal', label: 'Normal', icon: 'i-lucide-minus', color: 'primary' },
  { value: 'high', label: 'Alta', icon: 'i-lucide-arrow-up', color: 'error' }
]

const quickTemplates = [
  'Analise os impactos técnicos das últimas alterações',
  'Gere um checklist de validação para a entrega atual',
  'Revise inconsistências entre specs e regras de negócio'
]

const counts = computed(() => {
  let active = 0
  let completed = 0
  let failed = 0
  for (const t of props.tasks) {
    if (t.status === 'queued' || t.status === 'running') active++
    else if (t.status === 'completed') completed++
    else if (t.status === 'failed' || t.status === 'cancelled') failed++
  }
  return { all: props.tasks.length, active, completed, failed }
})

const filterTabs = computed(() => [
  { label: 'Todas', value: 'all', badge: counts.value.all },
  { label: 'Em andamento', value: 'active', badge: counts.value.active },
  { label: 'Concluídas', value: 'completed', badge: counts.value.completed },
  { label: 'Falhas / Canceladas', value: 'failed', badge: counts.value.failed }
])

const filteredTasks = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return props.tasks.filter((t) => {
    if (statusFilter.value === 'active' && t.status !== 'queued' && t.status !== 'running') return false
    if (statusFilter.value === 'completed' && t.status !== 'completed') return false
    if (statusFilter.value === 'failed' && t.status !== 'failed' && t.status !== 'cancelled') return false
    if (q) {
      return t.taskId.toLowerCase().includes(q) || t.instruction.toLowerCase().includes(q)
    }
    return true
  })
})

function statusMeta(status: string): { label: string; color: 'success' | 'error' | 'warning' | 'info' | 'neutral'; icon: string } {
  switch (status) {
    case 'completed':
      return { label: 'Concluída', color: 'success', icon: 'i-lucide-check-circle-2' }
    case 'running':
      return { label: 'Executando', color: 'info', icon: 'i-lucide-loader-2' }
    case 'queued':
      return { label: 'Na fila', color: 'warning', icon: 'i-lucide-clock' }
    case 'cancelled':
      return { label: 'Cancelada', color: 'neutral', icon: 'i-lucide-ban' }
    case 'failed':
      return { label: 'Falhou', color: 'error', icon: 'i-lucide-alert-circle' }
    default:
      return { label: status, color: 'neutral', icon: 'i-lucide-circle-dot' }
  }
}

function priorityMeta(priority: string): { label: string; color: 'error' | 'primary' | 'neutral' } {
  if (priority === 'high') return { label: 'Alta', color: 'error' }
  if (priority === 'low') return { label: 'Baixa', color: 'neutral' }
  return { label: 'Normal', color: 'primary' }
}

function formatTime(iso?: string) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

async function onDispatch() {
  dispatching.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/tasks`, {
      method: 'POST',
      body: JSON.stringify(runnerState)
    })
    notify('Tarefa delegada ao Brain Runner!')
    runnerState.instruction = ''
    emit('refresh')
  } catch (err) {
    notify('Erro ao delegar tarefa', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    dispatching.value = false
  }
}

async function cancelTask(taskId: string) {
  cancellingId.value = taskId
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST'
    })
    notify('Tarefa cancelada', taskId, 'warning')
    if (inspectedTask.value?.taskId === taskId) {
      inspectedTask.value = null
    }
    emit('refresh')
  } catch (err) {
    notify('Erro ao cancelar tarefa', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    cancellingId.value = null
  }
}

function reuseInstruction(task: RunnerTaskItem) {
  runnerState.instruction = task.instruction
  if (task.priority === 'low' || task.priority === 'normal' || task.priority === 'high') {
    runnerState.priority = task.priority
  }
  inspectedTask.value = null
}

function onTextareaKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    if (runnerState.instruction.trim().length >= 5 && !dispatching.value) {
      onDispatch()
    }
  }
}
</script>

<template>
  <div class="space-y-5">
    <!-- Delegar Tarefa -->
    <UCard v-if="hasPermission('runner:execute')">
      <template #header>
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-sparkles" class="size-4 text-primary" />
            <h2 class="font-semibold text-sm">Delegar Tarefa</h2>
          </div>
          <span class="hidden sm:inline-flex items-center gap-1 text-[11px] text-muted">
            <UKbd size="sm">⌘</UKbd> + <UKbd size="sm">Enter</UKbd> para enviar
          </span>
        </div>
      </template>

      <UForm :schema="runnerSchema" :state="runnerState" class="space-y-3" @submit="onDispatch">
        <UFormField label="Instrução para o Agente" name="instruction">
          <UTextarea
            v-model="runnerState.instruction"
            :rows="3"
            autoresize
            placeholder="Descreva o que o Brain Runner deve analisar, planejar ou validar..."
            class="w-full"
            @keydown="onTextareaKeydown"
          />
        </UFormField>

        <div v-if="!runnerState.instruction.trim()" class="flex flex-wrap items-center gap-1.5">
          <span class="text-[11px] text-muted mr-1">Sugestões:</span>
          <UButton
            v-for="tpl in quickTemplates"
            :key="tpl"
            type="button"
            size="xs"
            variant="soft"
            color="neutral"
            @click="runnerState.instruction = tpl"
          >
            {{ tpl }}
          </UButton>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-muted">Prioridade:</span>
            <div class="inline-flex p-0.5 rounded-lg bg-elevated/70 border border-default">
              <button
                v-for="opt in priorityOptions"
                :key="opt.value"
                type="button"
                class="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer"
                :class="runnerState.priority === opt.value
                  ? 'bg-primary text-inverted shadow-xs'
                  : 'text-muted hover:text-highlighted'"
                @click="runnerState.priority = opt.value"
              >
                <UIcon :name="opt.icon" class="size-3" />
                <span>{{ opt.label }}</span>
              </button>
            </div>
          </div>

          <UButton type="submit" :loading="dispatching" icon="i-lucide-play">
            Executar Tarefa
          </UButton>
        </div>
      </UForm>
    </UCard>

    <!-- Fila & Execuções Recentes -->
    <UCard>
      <template #header>
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-list-checks" class="size-4 text-primary" />
            <h2 class="font-semibold text-sm">Fila de Execução</h2>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <UInput
              v-model="searchQuery"
              size="xs"
              icon="i-lucide-search"
              placeholder="Filtrar instrução ou ID..."
              class="w-48"
            />
            <UButton
              size="xs"
              variant="ghost"
              icon="i-lucide-refresh-cw"
              :loading="loading"
              @click="emit('refresh')"
            >
              Atualizar
            </UButton>
          </div>
        </div>
      </template>

      <div class="space-y-4">
        <UiSegmentedTabs v-model="statusFilter" :items="filterTabs" />

        <UiEmptyState
          v-if="filteredTasks.length === 0"
          compact
          icon="i-lucide-bot"
          :title="tasks.length === 0 ? 'Nenhuma execução registrada' : 'Nenhuma tarefa neste filtro'"
          :description="tasks.length === 0 ? 'Delegue uma tarefa acima para iniciar a fila do Brain Runner.' : 'Limpe a busca ou troque o filtro de status.'"
        />

        <UTable
          v-else
          :data="filteredTasks"
          :columns="[
            { accessorKey: 'taskId', header: 'ID' },
            { accessorKey: 'instruction', header: 'Instrução' },
            { accessorKey: 'status', header: 'Status' },
            { accessorKey: 'priority', header: 'Prioridade' },
            { id: 'actions', header: '' }
          ]"
        >
          <template #taskId-cell="{ row }">
            <button
              type="button"
              class="font-mono text-xs text-primary hover:underline cursor-pointer"
              @click="inspectedTask = row.original"
            >
              {{ row.original.taskId }}
            </button>
          </template>

          <template #instruction-cell="{ row }">
            <div class="max-w-md">
              <p
                class="text-xs text-highlighted line-clamp-2 cursor-pointer hover:text-primary transition-colors"
                @click="inspectedTask = row.original"
              >
                {{ row.original.instruction }}
              </p>
              <div class="flex items-center gap-2 mt-0.5 text-[11px] text-muted">
                <span v-if="row.original.createdAt">{{ formatTime(row.original.createdAt) }}</span>
                <span v-if="row.original.model" class="font-mono">{{ row.original.provider }}/{{ row.original.model }}</span>
                <UBadge v-if="row.original.pendingQuestion" color="warning" variant="subtle" size="xs">
                  Pergunta pendente
                </UBadge>
              </div>
            </div>
          </template>

          <template #status-cell="{ row }">
            <UBadge
              :color="statusMeta(row.original.status).color"
              variant="subtle"
              size="xs"
              class="inline-flex items-center gap-1"
            >
              <UIcon
                :name="statusMeta(row.original.status).icon"
                class="size-3"
                :class="row.original.status === 'running' ? 'animate-spin' : ''"
              />
              <span>{{ statusMeta(row.original.status).label }}</span>
            </UBadge>
          </template>

          <template #priority-cell="{ row }">
            <UBadge :color="priorityMeta(row.original.priority).color" variant="outline" size="xs">
              {{ priorityMeta(row.original.priority).label }}
            </UBadge>
          </template>

          <template #actions-cell="{ row }">
            <div class="flex items-center justify-end gap-1">
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-eye"
                title="Ver detalhes"
                @click="inspectedTask = row.original"
              />
              <UButton
                v-if="hasPermission('runner:cancel') && (row.original.status === 'queued' || row.original.status === 'running')"
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-square"
                :loading="cancellingId === row.original.taskId"
                @click="cancelTask(row.original.taskId)"
              >
                Cancelar
              </UButton>
            </div>
          </template>
        </UTable>
      </div>
    </UCard>

    <!-- Slideover de Detalhes da Tarefa -->
    <USlideover
      :open="!!inspectedTask"
      :title="inspectedTask ? `Tarefa ${inspectedTask.taskId}` : ''"
      @update:open="(v: boolean) => { if (!v) inspectedTask = null }"
    >
      <template #body>
        <div v-if="inspectedTask" class="space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <UBadge :color="statusMeta(inspectedTask.status).color" variant="subtle" size="xs">
              {{ statusMeta(inspectedTask.status).label }}
            </UBadge>
            <UBadge :color="priorityMeta(inspectedTask.priority).color" variant="outline" size="xs">
              Prioridade: {{ priorityMeta(inspectedTask.priority).label }}
            </UBadge>
            <span v-if="inspectedTask.createdAt" class="text-xs text-muted">
              {{ formatTime(inspectedTask.createdAt) }}
            </span>
          </div>

          <div class="space-y-1">
            <div class="text-xs font-medium text-muted">Instrução</div>
            <div class="p-3 rounded-lg border border-default bg-elevated/40 text-xs whitespace-pre-wrap">
              {{ inspectedTask.instruction }}
            </div>
          </div>

          <div v-if="inspectedTask.pendingQuestion" class="p-3 rounded-lg border border-warning/40 bg-warning/5 space-y-1">
            <div class="text-xs font-semibold text-warning">Pergunta pendente do Runner</div>
            <div class="text-xs whitespace-pre-wrap">{{ inspectedTask.pendingQuestion.question }}</div>
          </div>

          <div v-if="inspectedTask.result" class="space-y-1">
            <div class="text-xs font-medium text-muted">Resultado</div>
            <pre class="p-3 rounded-lg border border-default bg-elevated/40 text-xs whitespace-pre-wrap font-mono overflow-x-auto">{{ inspectedTask.result }}</pre>
          </div>

          <div v-if="inspectedTask.error" class="space-y-1">
            <div class="text-xs font-medium text-error">Erro</div>
            <pre class="p-3 rounded-lg border border-error/40 bg-error/5 text-xs text-error whitespace-pre-wrap font-mono overflow-x-auto">{{ inspectedTask.error }}</pre>
          </div>

          <div class="flex items-center justify-end gap-2 pt-2 border-t border-default">
            <UButton
              v-if="hasPermission('runner:execute')"
              size="sm"
              variant="soft"
              icon="i-lucide-rotate-cw"
              @click="reuseInstruction(inspectedTask)"
            >
              Reutilizar Instrução
            </UButton>
            <UButton
              v-if="hasPermission('runner:cancel') && (inspectedTask.status === 'queued' || inspectedTask.status === 'running')"
              size="sm"
              color="error"
              variant="soft"
              icon="i-lucide-square"
              :loading="cancellingId === inspectedTask.taskId"
              @click="cancelTask(inspectedTask.taskId)"
            >
              Cancelar
            </UButton>
          </div>
        </div>
      </template>
    </USlideover>
  </div>
</template>

