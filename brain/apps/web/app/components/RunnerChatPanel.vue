<script setup lang="ts">
interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  secondaryReply?: string
  secondaryProvider?: string
  secondaryModel?: string
  provider?: string
  model?: string
  latencyMs?: number
  totalTokens?: number
}

interface ProviderOption {
  id: string
  online: boolean
  models: Array<{ id: string; name?: string; disabled?: boolean }>
}

const { projectId, apiFetch, notify } = useBrainApi()

const messages = ref<ChatMessage[]>([])
const input = ref('')
const sending = ref(false)
const chatRole = ref<'primary' | 'secondary' | 'collaborate'>('primary')
const useCustomTarget = ref(false)
const manualModelInput = ref(false)
const selectedProvider = ref('codex')
const selectedModel = ref('default')
const routingInfo = ref<{ primary?: { provider: string; model: string }; secondary?: { provider: string; model: string } }>({})
const providers = ref<ProviderOption[]>([])
const threadEl = ref<HTMLElement | null>(null)
const copiedMsgId = ref<string | null>(null)

const starterPrompts = [
  'Resuma a arquitetura atual deste projeto',
  'Quais riscos técnicos ou melhorias você recomenda?',
  'Crie um checklist de validação para a próxima entrega'
]

const providerOptions = computed(() =>
  providers.value.map((p) => ({
    label: p.online ? `${p.id} (online)` : p.id,
    value: p.id
  }))
)
const availableModels = computed(() => {
  const found = providers.value.find((p) => p.id === selectedProvider.value)
  return (found?.models ?? []).filter((m) => !m.disabled).map((m) => m.id)
})

watch(selectedProvider, () => {
  const models = availableModels.value
  if (models.length > 0 && !models.includes(selectedModel.value)) {
    selectedModel.value = models[0]!
  }
})

function copyMessage(m: ChatMessage) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(m.content)
  }
  copiedMsgId.value = m.id
  setTimeout(() => {
    if (copiedMsgId.value === m.id) copiedMsgId.value = null
  }, 1500)
}

const activeBadgeLabel = computed(() => {
  if (useCustomTarget.value) return `${selectedProvider.value}/${selectedModel.value}`
  if (chatRole.value === 'secondary') {
    const s = routingInfo.value.secondary
    return s ? `Sub: ${s.provider}/${s.model}` : 'Submodelo'
  }
  if (chatRole.value === 'collaborate') {
    const p = routingInfo.value.primary
    const s = routingInfo.value.secondary
    return `${p?.provider || 'codex'} ↔ ${s?.provider || 'ollama'}`
  }
  const p = routingInfo.value.primary
  return p ? `${p.provider}/${p.model}` : `${selectedProvider.value}/${selectedModel.value}`
})

async function loadOptions() {
  if (!projectId.value) return
  try {
    const [provRes, routeRes] = await Promise.all([
      apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/providers?probe=false`) as Promise<{ providers?: ProviderOption[] }>,
      apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/routing`) as Promise<{
        primary?: { provider: string; model: string }
        secondary?: { provider: string; model: string }
      }>
    ])
    providers.value = provRes.providers ?? []
    routingInfo.value = routeRes
    if (routeRes.primary && !useCustomTarget.value) {
      selectedProvider.value = routeRes.primary.provider
      selectedModel.value = routeRes.primary.model
    }
  } catch {
    // Non-fatal
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (threadEl.value) {
      threadEl.value.scrollTop = threadEl.value.scrollHeight
    }
  })
}

function clearChat() {
  messages.value = []
}

async function sendMessage(textOverride?: string) {
  const text = (textOverride ?? input.value).trim()
  if (!text || sending.value || !projectId.value) return

  if (!textOverride) input.value = ''
  messages.value.push({
    id: `u-${Date.now()}`,
    role: 'user',
    content: text
  })
  scrollToBottom()

  sending.value = true
  try {
    const payload: Record<string, unknown> = {
      role: chatRole.value,
      messages: messages.value.map((m) => ({ role: m.role, content: m.content }))
    }
    if (useCustomTarget.value) {
      payload.provider = selectedProvider.value
      payload.model = selectedModel.value
    }

    const res = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/chat`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }) as {
      reply: string
      secondaryReply?: string
      secondaryProvider?: string
      secondaryModel?: string
      provider: string
      model: string
      latencyMs: number
      usage?: { totalTokens?: number }
    }

    messages.value.push({
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: res.reply,
      secondaryReply: res.secondaryReply,
      secondaryProvider: res.secondaryProvider,
      secondaryModel: res.secondaryModel,
      provider: res.provider,
      model: res.model,
      latencyMs: res.latencyMs,
      totalTokens: res.usage?.totalTokens ?? 0
    })
    scrollToBottom()
  } catch (err) {
    notify('Erro ao enviar mensagem', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    sending.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}

watch(projectId, () => {
  loadOptions()
}, { immediate: true })
</script>

<template>
  <UCard class="flex flex-col">
    <template #header>
      <div class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <UIcon name="i-lucide-message-square-code" class="size-4 text-primary" />
            <span class="font-semibold text-sm">Brain Chat</span>
            <UBadge color="primary" variant="subtle" size="xs" class="font-mono">
              {{ activeBadgeLabel }}
            </UBadge>
          </div>
          <UButton
            size="xs"
            variant="ghost"
            icon="i-lucide-rotate-ccw"
            :disabled="messages.length === 0"
            @click="clearChat"
          >
            Nova Conversa
          </UButton>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-default/60">
          <UiSegmentedTabs
            v-model="chatRole"
            :items="[
              { label: 'Principal', value: 'primary', icon: 'i-lucide-bot' },
              { label: 'Submodelo', value: 'secondary', icon: 'i-lucide-sparkles' },
              { label: 'Principal ↔ Sub', value: 'collaborate', icon: 'i-lucide-git-compare' }
            ]"
          />

          <UButton
            size="xs"
            :variant="useCustomTarget ? 'soft' : 'ghost'"
            :color="useCustomTarget ? 'primary' : 'neutral'"
            icon="i-lucide-sliders-horizontal"
            @click="useCustomTarget = !useCustomTarget"
          >
            {{ useCustomTarget ? 'Alvo Manual Ativo' : 'Escolher Modelo' }}
          </UButton>
        </div>

        <div
          v-if="useCustomTarget"
          class="flex flex-wrap items-center gap-2 p-2.5 rounded-lg border border-default bg-elevated/40"
        >
          <span class="text-xs font-medium text-muted">Provedor:</span>
          <USelect
            v-model="selectedProvider"
            :items="providerOptions"
            size="xs"
            class="w-40"
          />

          <span class="text-xs font-medium text-muted ml-1">Modelo:</span>
          <USelect
            v-if="availableModels.length > 0 && !manualModelInput"
            v-model="selectedModel"
            :items="availableModels"
            size="xs"
            class="w-52 font-mono"
          />
          <UInput
            v-else
            v-model="selectedModel"
            size="xs"
            placeholder="Digite o ID do modelo..."
            class="w-52 font-mono"
          />

          <UButton
            v-if="availableModels.length > 0"
            size="xs"
            variant="ghost"
            color="neutral"
            :icon="manualModelInput ? 'i-lucide-list' : 'i-lucide-pencil'"
            :title="manualModelInput ? 'Escolher da lista' : 'Digitar manualmente'"
            @click="manualModelInput = !manualModelInput"
          />
        </div>
      </div>
    </template>

    <div ref="threadEl" class="h-[440px] overflow-y-auto space-y-4 pr-1">
      <div v-if="messages.length === 0" class="h-full flex flex-col items-center justify-center text-center gap-4 px-4">
        <div class="space-y-1">
          <p class="text-sm font-semibold">Converse com o Agente Principal, com o Submodelo ou coloque os dois para colaborar</p>
          <p class="text-xs text-muted">No modo Principal ↔ Sub, o Principal analisa, o Submodelo revisa e o Principal consolida a decisão.</p>
        </div>
        <div class="flex flex-wrap justify-center gap-2 max-w-xl">
          <UButton
            v-for="s in starterPrompts"
            :key="s"
            size="xs"
            variant="soft"
            color="neutral"
            @click="sendMessage(s)"
          >
            {{ s }}
          </UButton>
        </div>
      </div>

      <div
        v-for="m in messages"
        :key="m.id"
        class="flex"
        :class="m.role === 'user' ? 'justify-end' : 'justify-start'"
      >
        <div
          class="max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm whitespace-pre-wrap"
          :class="m.role === 'user'
            ? 'bg-primary text-white'
            : 'bg-elevated border border-default'"
        >
          <div v-if="m.secondaryReply" class="mb-2.5 p-2.5 rounded-lg border border-info/30 bg-info/5 text-xs">
            <div class="font-mono text-[10px] text-info mb-1">
              Parecer do Submodelo ({{ m.secondaryProvider }}/{{ m.secondaryModel }})
            </div>
            <div>{{ m.secondaryReply }}</div>
          </div>
          <div>{{ m.content }}</div>
          <div v-if="m.role === 'assistant'" class="flex items-center justify-between gap-2 mt-2 pt-1.5 border-t border-default/50 text-[10px] text-muted font-mono">
            <div class="flex items-center gap-2">
              <span>{{ m.provider }}/{{ m.model }}</span>
              <span v-if="m.latencyMs">· {{ m.latencyMs }}ms</span>
              <span v-if="m.totalTokens">· {{ m.totalTokens }} tok</span>
            </div>
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              :icon="copiedMsgId === m.id ? 'i-lucide-check' : 'i-lucide-copy'"
              title="Copiar resposta"
              @click="copyMessage(m)"
            />
          </div>
        </div>
      </div>

      <div v-if="sending" class="flex justify-start">
        <div class="rounded-xl px-3.5 py-2.5 text-xs bg-elevated border border-default text-muted flex items-center gap-2">
          <UIcon name="i-lucide-loader-2" class="size-3.5 animate-spin" />
          <span>Gerando resposta ({{ activeBadgeLabel }})...</span>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex items-end gap-2">
        <UTextarea
          v-model="input"
          :rows="2"
          autoresize
          placeholder="Pergunte algo ao Runner... (Enter para enviar, Shift+Enter para nova linha)"
          class="flex-1"
          @keydown="onKeydown"
        />
        <UButton icon="i-lucide-send" :loading="sending" :disabled="!input.trim()" @click="sendMessage()">
          Enviar
        </UButton>
      </div>
    </template>
  </UCard>
</template>
