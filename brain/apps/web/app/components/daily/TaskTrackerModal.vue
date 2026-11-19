<script setup lang="ts">
const props = defineProps<{
  projectId: string
}>()

const open = defineModel<boolean>('open', { default: false })
const { apiFetch, notify } = useBrainApi()

const loading = ref(false)
const tasksData = ref<{
  totalTrackedTasks: number
  tasks: Array<{
    id: string
    title: string
    status: string
    progressPercent: number
    linkedRulesCount: number
    linkedDocsCount: number
    tags: string[]
  }>
} | null>(null)

async function loadTasks() {
  if (!props.projectId) return
  loading.value = true
  try {
    tasksData.value = await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/daily/task-tracker`)
  } catch (err) {
    notify('Erro ao carregar rastreador', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}

watch(open, (isOpen) => {
  if (isOpen && !tasksData.value) {
    loadTasks()
  }
})
</script>

<template>
  <UModal v-model:open="open" title="Acompanhamento de Tarefas Técnicas & Vínculos" class="max-w-3xl">
    <template #body>
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <p class="text-xs text-muted">
            Rastreie o progresso técnico das tarefas relacionando-as a regras de negócio, testes e especificações.
          </p>
          <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="loadTasks">
            Atualizar
          </UButton>
        </div>

        <div v-if="loading" class="p-8 text-center text-xs text-muted">
          <UIcon name="i-lucide-loader-2" class="size-5 animate-spin mx-auto mb-2 text-primary" />
          Calculando vínculos e progresso...
        </div>

        <div v-else-if="tasksData" class="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          <div v-if="tasksData.tasks.length === 0" class="p-8 text-center text-xs text-muted">
            Nenhuma tarefa técnica com vínculos registrada ainda neste projeto.
          </div>

          <div
            v-for="t in tasksData.tasks"
            :key="t.id"
            class="p-3.5 rounded-xl border border-default bg-elevated/40 space-y-2.5"
          >
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 truncate">
                <span class="font-mono text-xs font-bold text-primary">{{ t.id }}</span>
                <span class="text-xs font-semibold text-highlighted truncate">{{ t.title }}</span>
              </div>
              <UBadge
                :color="t.progressPercent === 100 ? 'success' : t.progressPercent > 50 ? 'primary' : 'warning'"
                variant="subtle"
                size="xs"
              >
                {{ t.status }} ({{ t.progressPercent }}%)
              </UBadge>
            </div>

            <!-- Progress Bar -->
            <UProgress :model-value="t.progressPercent" color="primary" size="xs" />

            <div class="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted pt-1 border-t border-default/40">
              <div class="flex items-center gap-3">
                <span class="flex items-center gap-1">
                  <UIcon name="i-lucide-shield-check" class="size-3.5 text-warning" />
                  {{ t.linkedRulesCount }} regra(s) vinculada(s)
                </span>
                <span class="flex items-center gap-1">
                  <UIcon name="i-lucide-file-text" class="size-3.5 text-info" />
                  {{ t.linkedDocsCount }} documento(s)
                </span>
              </div>
              <div class="flex gap-1">
                <UBadge v-for="tag in t.tags" :key="tag" size="xs" variant="outline" color="neutral">
                  {{ tag }}
                </UBadge>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
