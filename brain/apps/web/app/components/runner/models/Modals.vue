<script setup lang="ts">
const props = defineProps<{
  addModelOpen: boolean
  configOpen: boolean
  oauthOpen: boolean
  providerIds: string[]
  configInitial: {
    id: string
    mode: 'http' | 'cli'
    baseUrl: string
    apiKey: string
    cliCommandText: string
  }
  oauthData: {
    provider: string
    flowType: 'pkce' | 'device_code'
    authUrl?: string
    state?: string
    deviceCode?: string
    userCode?: string
    verificationUri?: string
  } | null
  savingRouting: boolean
  oauthLoading: boolean
}>()

const emit = defineEmits<{
  'update:addModelOpen': [value: boolean]
  'update:configOpen': [value: boolean]
  'update:oauthOpen': [value: boolean]
  reload: [probe: boolean]
  saveProviderConfig: [cfg: { id: string; mode: 'http' | 'cli'; baseUrl?: string; apiKey?: string; cliCommand?: string[] }]
  completeOAuth: [callbackInput: string]
}>()

const { projectId, apiFetch, notify } = useBrainApi()

const addModelForm = ref({
  provider: 'codex-cli',
  modelId: '',
  name: '',
  free: false
})
const registeringModel = ref(false)
const testingCustomModel = ref(false)
const customModelTestMsg = ref<{ ok: boolean; text: string } | null>(null)

const configForm = ref({ ...props.configInitial })
watch(() => props.configInitial, (val) => {
  configForm.value = { ...val }
}, { deep: true })

const oauthCallbackInput = ref('')
watch(() => props.oauthOpen, (open) => {
  if (open) oauthCallbackInput.value = ''
})

function openExternalUrl(url?: string) {
  if (url && typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

async function testBeforeRegister() {
  if (!projectId.value || !addModelForm.value.modelId.trim()) return
  testingCustomModel.value = true
  customModelTestMsg.value = null
  try {
    const res = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/providers/test`, {
      method: 'POST',
      body: JSON.stringify({ provider: addModelForm.value.provider, model: addModelForm.value.modelId.trim() })
    }) as { ok: boolean; latencyMs?: number; preview?: string; error?: string }
    customModelTestMsg.value = res.ok
      ? { ok: true, text: `OK em ${res.latencyMs}ms: "${res.preview}"` }
      : { ok: false, text: res.error || 'Falha no teste' }
  } catch (err) {
    customModelTestMsg.value = { ok: false, text: err instanceof Error ? err.message : String(err) }
  } finally {
    testingCustomModel.value = false
  }
}

async function submitRegisterModel() {
  if (!projectId.value || !addModelForm.value.modelId.trim()) return
  registeringModel.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/models`, {
      method: 'POST',
      body: JSON.stringify({
        provider: addModelForm.value.provider,
        modelId: addModelForm.value.modelId.trim(),
        name: addModelForm.value.name.trim() || undefined,
        free: addModelForm.value.free
      })
    })
    notify(`Modelo ${addModelForm.value.provider}/${addModelForm.value.modelId.trim()} registrado`, undefined, 'success')
    emit('update:addModelOpen', false)
    addModelForm.value = { provider: addModelForm.value.provider, modelId: '', name: '', free: false }
    customModelTestMsg.value = null
    emit('reload', false)
  } catch (err) {
    notify('Erro ao registrar modelo', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    registeringModel.value = false
  }
}

function submitProviderConfig() {
  const cliCommand = configForm.value.mode === 'cli'
    ? configForm.value.cliCommandText.trim().split(/\s+/).filter(Boolean)
    : undefined
  emit('saveProviderConfig', {
    id: configForm.value.id.trim(),
    mode: configForm.value.mode,
    baseUrl: configForm.value.baseUrl.trim() || undefined,
    apiKey: configForm.value.apiKey.trim() || undefined,
    cliCommand
  })
}
</script>

<template>
  <div>
    <!-- Modal: Registrar Modelo Customizado -->
    <UModal
      :open="addModelOpen"
      title="Registrar Modelo Customizado"
      @update:open="(v: boolean) => emit('update:addModelOpen', v)"
    >
      <template #body>
        <div class="space-y-3">
          <UFormField label="Provedor">
            <USelect v-model="addModelForm.provider" :items="providerIds" class="w-full" />
          </UFormField>
          <UFormField label="Model ID">
            <UInput v-model="addModelForm.modelId" placeholder="Ex.: gpt-5.4, qwen3-coder:30b, deepseek/deepseek-chat" class="w-full font-mono text-xs" />
          </UFormField>
          <UFormField label="Nome de exibição (opcional)">
            <UInput v-model="addModelForm.name" placeholder="Ex.: Qwen 3 Coder 30B" class="w-full text-xs" />
          </UFormField>
          <div class="flex items-center gap-2">
            <UCheckbox v-model="addModelForm.free" label="Modelo gratuito (Free tier / Local)" />
          </div>

          <div v-if="customModelTestMsg" class="text-xs px-3 py-2 rounded border" :class="customModelTestMsg.ok ? 'border-success/40 bg-success/10 text-success' : 'border-error/40 bg-error/10 text-error'">
            {{ customModelTestMsg.text }}
          </div>

          <div class="flex justify-between gap-2 pt-2">
            <UButton variant="outline" icon="i-lucide-flask-conical" :loading="testingCustomModel" @click="testBeforeRegister">
              Testar antes de salvar
            </UButton>
            <div class="flex gap-2">
              <UButton variant="ghost" @click="emit('update:addModelOpen', false)">Cancelar</UButton>
              <UButton :loading="registeringModel" @click="submitRegisterModel">Registrar</UButton>
            </div>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Modal: Configurar Conexão / Novo Provedor -->
    <UModal
      :open="configOpen"
      :title="`Configurar Provedor: ${configForm.id}`"
      @update:open="(v: boolean) => emit('update:configOpen', v)"
    >
      <template #body>
        <div class="space-y-3">
          <UFormField label="ID do Provedor">
            <UInput v-model="configForm.id" class="w-full font-mono text-xs" />
          </UFormField>
          <UFormField label="Modo de Conexão">
            <USelect v-model="configForm.mode" :items="['http', 'cli']" class="w-full" />
          </UFormField>
          <UFormField v-if="configForm.mode === 'http'" label="Base URL (OpenAI-compatible)">
            <UInput v-model="configForm.baseUrl" placeholder="http://localhost:20128/v1" class="w-full font-mono text-xs" />
          </UFormField>
          <UFormField v-if="configForm.mode === 'http'" label="API Key / Token OAuth (opcional, salva em runtime)">
            <UInput v-model="configForm.apiKey" type="password" placeholder="sk-... ou token 9router" class="w-full font-mono text-xs" />
          </UFormField>
          <UFormField v-else label="Comando CLI">
            <UInput v-model="configForm.cliCommandText" placeholder="claude -p" class="w-full font-mono text-xs" />
          </UFormField>
          <div class="flex justify-end gap-2 pt-2">
            <UButton variant="ghost" @click="emit('update:configOpen', false)">Cancelar</UButton>
            <UButton :loading="savingRouting" @click="submitProviderConfig">Salvar Conexão</UButton>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Modal: Conectar via OAuth -->
    <UModal
      :open="oauthOpen"
      :title="`Conectar ${oauthData?.provider || ''} via OAuth`"
      @update:open="(v: boolean) => emit('update:oauthOpen', v)"
    >
      <template #body>
        <div v-if="oauthData" class="space-y-4">
          <template v-if="oauthData.flowType === 'device_code'">
            <p class="text-xs text-muted">1. Clique para abrir a página de ativação e informe o código abaixo:</p>
            <div class="text-center py-3 rounded-lg border border-default bg-elevated font-mono text-2xl font-bold tracking-widest">
              {{ oauthData.userCode }}
            </div>
            <div class="flex justify-between gap-2">
              <UButton variant="outline" icon="i-lucide-external-link" @click="openExternalUrl(oauthData.verificationUri)">
                Abrir {{ oauthData.provider }}
              </UButton>
              <UButton :loading="oauthLoading" @click="emit('completeOAuth', '')">Verificar Autorização</UButton>
            </div>
          </template>
          <template v-else>
            <p class="text-xs text-muted">
              1. Abra o login no navegador e autorize a conta. A conexão será concluída automaticamente (ou cole a URL de retorno abaixo):
            </p>
            <UButton variant="outline" icon="i-lucide-external-link" class="w-full justify-center" @click="openExternalUrl(oauthData.authUrl)">
              Abrir Login {{ oauthData.provider }} no Navegador
            </UButton>
            <UFormField label="URL de Callback ou Código OAuth">
              <UInput v-model="oauthCallbackInput" placeholder="http://localhost:1455/auth/callback?code=..." class="w-full font-mono text-xs" />
            </UFormField>
            <div class="flex justify-end gap-2">
              <UButton variant="ghost" @click="emit('update:oauthOpen', false)">Cancelar</UButton>
              <UButton :loading="oauthLoading" @click="emit('completeOAuth', oauthCallbackInput)">Concluir Conexão</UButton>
            </div>
          </template>
        </div>
      </template>
    </UModal>
  </div>
</template>

