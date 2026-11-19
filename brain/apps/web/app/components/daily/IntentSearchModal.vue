<script setup lang="ts">
const props = defineProps<{
  projectId: string
}>()

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{
  (e: 'inspect', item: { title: string; content: string; type?: string; status?: string }): void
}>()

const { apiFetch, notify } = useBrainApi()

const searchMode = ref<'intent' | 'examples'>('intent')
const intentQuery = ref('')
const loading = ref(false)

const starterIntents = [
  'como publicar em produção?',
  'quem valida permissão e acesso?',
  'onde fica a arquitetura do banco?',
  'como diagnosticar erro ou falha?'
]

const intentResult = ref<{
  detectedIntent: string
  intentExplanation: string
  items: Array<{ id: string; title: string; type: string; summary: string; relevanceScore: number }>
  suggestedNextSteps: string[]
} | null>(null)

const examplesResult = ref<{
  query: string
  totalFound: number
  examples: Array<{ id: string; title: string; type: string; sample: string; uri: string }>
} | null>(null)

async function executeSearch() {
  if (!props.projectId || !intentQuery.value.trim()) return
  loading.value = true
  try {
    if (searchMode.value === 'intent') {
      intentResult.value = await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/daily/intent-search`, {
        method: 'POST',
        body: JSON.stringify({ intentQuery: intentQuery.value.trim() })
      })
      examplesResult.value = null
    } else {
      examplesResult.value = await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/daily/internal-examples`, {
        method: 'POST',
        body: JSON.stringify({ problemOrPattern: intentQuery.value.trim() })
      })
      intentResult.value = null
    }
  } catch (err) {
    notify('Erro na busca', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}

function selectStarter(q: string) {
  intentQuery.value = q
  searchMode.value = 'intent'
  executeSearch()
}
</script>

<template>
  <UModal v-model:open="open" title="Busca por Intenção & Exemplos Internos" class="max-w-3xl">
    <template #body>
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-3 border-b border-default pb-3">
          <p class="text-xs text-muted">
            Encontre conhecimento expressando sua intenção em linguagem natural ou busque exemplos de implementações já resolvidas.
          </p>
          <UiSegmentedTabs
            v-model="searchMode"
            :items="[
              { label: 'Por Intenção', value: 'intent', icon: 'i-lucide-sparkles' },
              { label: 'Exemplos Internos', value: 'examples', icon: 'i-lucide-code-2' }
            ]"
          />
        </div>

        <!-- Query Input -->
        <div class="flex items-center gap-2">
          <UInput
            v-model="intentQuery"
            :placeholder="searchMode === 'intent' ? 'Ex: como publicar? quem valida acesso? onde fica o banco?...' : 'Ex: validação CASL, conexão Valkey, handler Fastify...'"
            icon="i-lucide-search"
            class="flex-1"
            size="sm"
            @keyup.enter="executeSearch"
          />
          <UButton color="primary" size="sm" icon="i-lucide-search" :loading="loading" :disabled="!intentQuery.trim()" @click="executeSearch">
            Buscar
          </UButton>
        </div>

        <!-- Starters for intent search -->
        <div v-if="searchMode === 'intent' && !intentResult" class="space-y-1.5">
          <span class="text-[11px] text-muted">Sugestões de busca por intenção:</span>
          <div class="flex flex-wrap gap-1.5">
            <UButton
              v-for="s in starterIntents"
              :key="s"
              size="xs"
              variant="soft"
              color="neutral"
              @click="selectStarter(s)"
            >
              {{ s }}
            </UButton>
          </div>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="p-8 text-center text-xs text-muted">
          <UIcon name="i-lucide-loader-2" class="size-5 animate-spin mx-auto mb-2 text-primary" />
          Classificando intenção e buscando no grafo...
        </div>

        <!-- Intent Search Results -->
        <div v-else-if="intentResult" class="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
          <div class="p-3 rounded-xl border border-primary/20 bg-primary/5 space-y-1 text-xs">
            <div class="flex items-center justify-between">
              <span class="font-semibold text-primary">Intenção Identificada: {{ intentResult.detectedIntent }}</span>
              <UBadge color="primary" variant="subtle" size="xs">{{ intentResult.items.length }} resultados</UBadge>
            </div>
            <p class="text-highlighted">{{ intentResult.intentExplanation }}</p>
          </div>

          <div class="space-y-2">
            <div
              v-for="item in intentResult.items"
              :key="item.id"
              class="p-3 rounded-lg border border-default bg-elevated/40 space-y-1 text-xs cursor-pointer hover:border-primary/50 transition-colors"
              @click="emit('inspect', { title: item.title, content: item.summary, type: item.type })"
            >
              <div class="flex items-center justify-between">
                <span class="font-medium text-highlighted">{{ item.title }}</span>
                <UBadge color="neutral" variant="outline" size="xs">{{ item.type }}</UBadge>
              </div>
              <p class="text-[11px] text-muted line-clamp-2">{{ item.summary }}</p>
            </div>
          </div>
        </div>

        <!-- Internal Examples Results -->
        <div v-else-if="examplesResult" class="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
          <div class="p-3 rounded-xl border border-info/30 bg-info/5 space-y-1 text-xs">
            <span class="font-semibold text-info">Exemplos Internos Encontrados ({{ examplesResult.totalFound }})</span>
            <p class="text-muted">Padrões de implementação e soluções aprovadas no repositório.</p>
          </div>

          <div class="space-y-2">
            <div
              v-for="ex in examplesResult.examples"
              :key="ex.id"
              class="p-3 rounded-lg border border-default bg-elevated/40 space-y-1.5 text-xs"
            >
              <div class="flex items-center justify-between">
                <span class="font-medium text-highlighted">{{ ex.title }}</span>
                <UBadge color="info" variant="subtle" size="xs">{{ ex.type }}</UBadge>
              </div>
              <pre class="p-2 rounded bg-elevated text-[11px] font-mono whitespace-pre-wrap overflow-x-auto text-muted">{{ ex.sample }}</pre>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
