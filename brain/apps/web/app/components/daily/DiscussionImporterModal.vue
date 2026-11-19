<script setup lang="ts">
const props = defineProps<{
  projectId: string
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ (e: 'imported'): void }>()
const { apiFetch, notify } = useBrainApi()

const discussionTitle = ref('')
const conversationText = ref('')
const extracting = ref(false)
const result = ref<{
  sourceTitle: string
  summary: string
  adrCandidates: Array<{ suggestedId: string; title: string; context: string; decision: string }>
  ruleCandidates: Array<{ suggestedId: string; title: string; ruleContent: string }>
} | null>(null)

async function extractKnowledge() {
  if (!props.projectId || !conversationText.value.trim()) return
  extracting.value = true
  try {
    result.value = await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/daily/import-from-discussion`, {
      method: 'POST',
      body: JSON.stringify({
        title: discussionTitle.value.trim() || 'Discussão Técnica',
        conversationText: conversationText.value.trim()
      })
    })
    notify('Extração concluída', `${result.value?.adrCandidates.length || 0} decisão(ões) e ${result.value?.ruleCandidates.length || 0} regra(s) identificadas.`)
  } catch (err) {
    notify('Erro na extração', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    extracting.value = false
  }
}

function clearForm() {
  discussionTitle.value = ''
  conversationText.value = ''
  result.value = null
}
</script>

<template>
  <UModal v-model:open="open" title="Importar Conhecimento de Discussão / Ata" class="max-w-3xl">
    <template #body>
      <div class="space-y-4">
        <p class="text-xs text-muted">
          Cole a ata de reunião, retrospectiva, thread do Slack ou discussão de PR. O Brain identifica automaticamente decisões arquiteturais e regras de negócio sugeridas.
        </p>

        <div class="space-y-3">
          <UInput
            v-model="discussionTitle"
            placeholder="Título da discussão (ex: Retrospectiva Sprint 42 ou Alinhamento de Cache)..."
            size="sm"
          />
          <UTextarea
            v-model="conversationText"
            :rows="6"
            placeholder="Cole o texto da conversa ou ata aqui... Ex: 'Decidimos adotar Valkey no cluster. Devemos sempre invalidar o cache após qualquer mutação CASL...'"
            class="font-mono text-xs"
          />
          <div class="flex justify-end gap-2">
            <UButton size="xs" variant="ghost" :disabled="extracting" @click="clearForm">Limpar</UButton>
            <UButton
              size="xs"
              color="primary"
              icon="i-lucide-sparkles"
              :loading="extracting"
              :disabled="!conversationText.trim()"
              @click="extractKnowledge"
            >
              Extrair Regras e Decisões
            </UButton>
          </div>
        </div>

        <!-- Resultados da Extração -->
        <div v-if="result" class="space-y-4 pt-4 border-t border-default max-h-[50vh] overflow-y-auto pr-1">
          <div class="p-3 rounded-xl border border-success/30 bg-success/5 text-xs text-highlighted">
            <span class="font-semibold text-success">Resultado: </span>
            {{ result.summary }}
          </div>

          <!-- Candidatos ADR -->
          <div v-if="result.adrCandidates.length > 0" class="space-y-2">
            <h4 class="text-xs font-semibold text-info flex items-center gap-1.5">
              <UIcon name="i-lucide-git-branch" class="size-3.5" />
              Decisões de Arquitetura Sugeridas (ADR)
            </h4>
            <div class="space-y-1.5">
              <div
                v-for="a in result.adrCandidates"
                :key="a.suggestedId"
                class="p-2.5 rounded-lg border border-default bg-elevated/40 space-y-1 text-xs"
              >
                <div class="flex items-center justify-between">
                  <span class="font-medium text-highlighted">{{ a.title }}</span>
                  <UBadge size="xs" color="info" variant="subtle">{{ a.suggestedId }}</UBadge>
                </div>
                <p class="text-[11px] text-muted">{{ a.decision }}</p>
              </div>
            </div>
          </div>

          <!-- Candidatos Regra -->
          <div v-if="result.ruleCandidates.length > 0" class="space-y-2">
            <h4 class="text-xs font-semibold text-warning flex items-center gap-1.5">
              <UIcon name="i-lucide-shield-alert" class="size-3.5" />
              Regras de Negócio Sugeridas
            </h4>
            <div class="space-y-1.5">
              <div
                v-for="r in result.ruleCandidates"
                :key="r.suggestedId"
                class="p-2.5 rounded-lg border border-default bg-elevated/40 space-y-1 text-xs"
              >
                <div class="flex items-center justify-between">
                  <span class="font-medium text-highlighted">{{ r.title }}</span>
                  <UBadge size="xs" color="warning" variant="subtle">{{ r.suggestedId }}</UBadge>
                </div>
                <p class="text-[11px] text-muted">{{ r.ruleContent }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
