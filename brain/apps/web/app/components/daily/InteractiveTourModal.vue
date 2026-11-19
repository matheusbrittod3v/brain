<script setup lang="ts">
const props = defineProps<{
  projectId: string
}>()

const open = defineModel<boolean>('open', { default: false })
const { apiFetch, notify } = useBrainApi()

const currentStep = ref(1)
const loading = ref(false)
const tourData = ref<{
  projectId: string
  totalSteps: number
  steps: Array<{
    stepNumber: number
    title: string
    description: string
    keyItems: string[]
    verificationQuestion: string
  }>
} | null>(null)

async function loadTour() {
  if (!props.projectId) return
  loading.value = true
  try {
    tourData.value = await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/daily/interactive-tour`)
  } catch (err) {
    notify('Erro ao carregar tour', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}

watch(open, (isOpen) => {
  if (isOpen && !tourData.value) {
    loadTour()
  }
})

const activeStep = computed(() => {
  if (!tourData.value) return null
  return tourData.value.steps.find((s) => s.stepNumber === currentStep.value) || tourData.value.steps[0]
})
</script>

<template>
  <UModal v-model:open="open" title="Roteiro de Exploração do Projeto (Tour Guiado)" class="max-w-2xl">
    <template #body>
      <div v-if="loading" class="p-8 text-center text-xs text-muted">
        <UIcon name="i-lucide-loader-2" class="size-5 animate-spin mx-auto mb-2 text-primary" />
        Gerando tour interativo...
      </div>

      <div v-else-if="tourData && activeStep" class="space-y-4">
        <!-- Progress Steps indicator -->
        <div class="flex items-center justify-between border-b border-default pb-3">
          <div
            v-for="s in tourData.steps"
            :key="s.stepNumber"
            class="flex items-center gap-1.5 cursor-pointer text-xs select-none"
            :class="s.stepNumber === currentStep ? 'font-bold text-primary' : 'text-muted'"
            @click="currentStep = s.stepNumber"
          >
            <span
              class="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-mono border"
              :class="s.stepNumber === currentStep ? 'bg-primary text-white border-primary' : 'bg-elevated border-default'"
            >
              {{ s.stepNumber }}
            </span>
            <span class="hidden sm:inline">Passo {{ s.stepNumber }}</span>
          </div>
        </div>

        <!-- Step content -->
        <div class="p-4 rounded-xl border border-default bg-elevated/40 space-y-3">
          <div class="space-y-1">
            <h3 class="text-sm font-semibold text-primary">{{ activeStep.title }}</h3>
            <p class="text-xs text-muted">{{ activeStep.description }}</p>
          </div>

          <div v-if="activeStep.keyItems.length > 0" class="space-y-1.5 pt-2 border-t border-default/50">
            <span class="text-[11px] font-semibold text-highlighted">Artefatos-Chave a Explorar:</span>
            <ul class="space-y-1">
              <li
                v-for="(item, idx) in activeStep.keyItems"
                :key="idx"
                class="text-xs flex items-center gap-2 text-highlighted"
              >
                <UIcon name="i-lucide-check-circle" class="size-3.5 text-success shrink-0" />
                <span class="truncate">{{ item }}</span>
              </li>
            </ul>
          </div>

          <!-- Checkpoint question -->
          <div class="p-3 rounded-lg border border-info/30 bg-info/5 space-y-1.5">
            <div class="flex items-center gap-1 text-[11px] font-semibold text-info">
              <UIcon name="i-lucide-help-circle" class="size-3.5" />
              <span>Pergunta de Checagem:</span>
            </div>
            <p class="text-xs text-highlighted">{{ activeStep.verificationQuestion }}</p>
          </div>
        </div>

        <!-- Navigation buttons -->
        <div class="flex items-center justify-between pt-2">
          <UButton
            size="xs"
            variant="ghost"
            :disabled="currentStep <= 1"
            icon="i-lucide-chevron-left"
            @click="currentStep--"
          >
            Anterior
          </UButton>
          <span class="text-xs text-muted font-mono">{{ currentStep }} de {{ tourData.totalSteps }}</span>
          <UButton
            v-if="currentStep < tourData.totalSteps"
            size="xs"
            color="primary"
            trailing-icon="i-lucide-chevron-right"
            @click="currentStep++"
          >
            Próximo Passo
          </UButton>
          <UButton
            v-else
            size="xs"
            color="success"
            icon="i-lucide-check"
            @click="open = false"
          >
            Concluir Exploração
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
