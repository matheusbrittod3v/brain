<script setup lang="ts">
interface ModelCatalogItem {
  id: string
  name?: string
  free?: boolean
  custom?: boolean
  disabled?: boolean
}

interface RunnerProviderItem {
  id: string
  mode: 'http' | 'cli'
  format?: string
  category: 'local' | 'cloud' | 'gateway' | 'cli'
  hasFree?: boolean
  supportsOAuth?: boolean
  supportsLocalImport?: boolean
  connectedAccount?: {
    authType: string
    email?: string
    planType?: string
    updatedAt?: string
  }
  baseUrl?: string
  envKey?: string
  cliCommand?: string[]
  configured: boolean
  online: boolean
  connectionError?: string
  discoveredModels: string[]
  models: ModelCatalogItem[]
}

interface RoutingTarget {
  provider: string
  model: string
  baseUrl?: string
}

const { projectId, apiFetch, notify, hasPermission } = useBrainApi()

const providers = ref<RunnerProviderItem[]>([])
const loadingProviders = ref(false)
const probing = ref(false)
const savingRouting = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; latencyMs?: number; preview?: string; error?: string } | null>(null)

const categoryFilter = ref<'all' | 'free' | 'local' | 'cloud' | 'gateway' | 'cli'>('all')
const modelSearch = ref('')
const modelProviderFilter = ref<string>('all')
const onlyFreeModels = ref(false)
const probingProvider = ref<string | null>(null)
const modelTestState = ref<Record<string, 'testing' | 'ok' | 'error'>>({})
const copiedModel = ref<string | null>(null)

const primary = ref<RoutingTarget>({ provider: 'codex', model: 'default' })
const secondary = ref<RoutingTarget>({ provider: 'ollama', model: 'gemma2:2b' })
const fallbacks = ref<RoutingTarget[]>([
  { provider: 'ollama', model: 'gemma2:2b' },
  { provider: '9router', model: 'qwen2.5-coder:7b' }
])
const newFallback = ref<RoutingTarget>({ provider: 'ollama', model: 'gemma2:2b' })

const configOpen = ref(false)
const configForm = ref({
  id: '',
  mode: 'http' as 'http' | 'cli',
  baseUrl: '',
  apiKey: '',
  cliCommandText: ''
})

const addModelOpen = ref(false)
const addModelForm = ref({
  provider: 'codex-cli',
  modelId: '',
  name: '',
  free: false
})
const registeringModel = ref(false)
const testingCustomModel = ref(false)
const customModelTestMsg = ref<{ ok: boolean; text: string } | null>(null)

const importingLocal = ref(false)
const oauthOpen = ref(false)
const oauthLoading = ref(false)
const oauthData = ref<{
  provider: string
  flowType: 'pkce' | 'device_code'
  authUrl?: string
  state?: string
  deviceCode?: string
  userCode?: string
  verificationUri?: string
} | null>(null)
const oauthCallbackInput = ref('')

const categoryTabs = [
  { label: 'Todos', value: 'all' },
  { label: 'Gratuitos', value: 'free' },
  { label: 'Local', value: 'local' },
  { label: 'Gateway / OAuth', value: 'gateway' },
  { label: 'Cloud API', value: 'cloud' },
  { label: 'CLI', value: 'cli' }
]

const providerIds = computed(() => providers.value.map((p) => p.id))

const filteredProviders = computed(() => {
  if (categoryFilter.value === 'all') return providers.value
  if (categoryFilter.value === 'free') return providers.value.filter((p) => p.hasFree)
  return providers.value.filter((p) => p.category === categoryFilter.value)
})

const allCatalogModels = computed(() => {
  const q = modelSearch.value.trim().toLowerCase()
  const rows: Array<{
    key: string
    provider: string
    category: RunnerProviderItem['category']
    online: boolean
    configured: boolean
    model: ModelCatalogItem
  }> = []
  for (const p of providers.value) {
    if (modelProviderFilter.value !== 'all' && p.id !== modelProviderFilter.value) continue
    for (const m of p.models || []) {
      if (onlyFreeModels.value && !m.free) continue
      const key = `${p.id}/${m.id}`
      if (q && !key.toLowerCase().includes(q) && !(m.name || '').toLowerCase().includes(q)) continue
      rows.push({
        key,
        provider: p.id,
        category: p.category,
        online: p.online,
        configured: p.configured,
        model: m
      })
    }
  }
  return rows
})

const categoryColor = (cat: RunnerProviderItem['category']) => {
  if (cat === 'local') return 'success'
  if (cat === 'gateway') return 'primary'
  if (cat === 'cli') return 'warning'
  return 'neutral'
}

const categoryLabel = (cat: RunnerProviderItem['category']) => {
  if (cat === 'local') return 'Local'
  if (cat === 'gateway') return 'Gateway / OAuth'
  if (cat === 'cli') return 'CLI'
  return 'Cloud API'
}

async function loadAll(probe = false) {
  if (!projectId.value) return
  if (probe) probing.value = true
  else loadingProviders.value = true
  try {
    const [provRes, routeRes] = await Promise.all([
      apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/providers?probe=${probe ? 'true' : 'false'}`) as Promise<{ providers?: RunnerProviderItem[] }>,
      apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/routing`) as Promise<{ primary?: RoutingTarget; secondary?: RoutingTarget; fallbacks?: RoutingTarget[] }>
    ])
    providers.value = provRes.providers ?? []
    if (routeRes.primary) primary.value = routeRes.primary
    if (routeRes.secondary) secondary.value = routeRes.secondary
    if (routeRes.fallbacks) fallbacks.value = routeRes.fallbacks
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao carregar provedores do Runner', 'error')
  } finally {
    loadingProviders.value = false
    probing.value = false
  }
}

async function importLocalAuth(providerId?: string) {
  if (!projectId.value) return
  importingLocal.value = true
  try {
    const res = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/connections/import-local`, {
      method: 'POST',
      body: JSON.stringify({ providerId })
    }) as { imported: Array<{ provider: string; email?: string }> }
    if (res.imported.length > 0) {
      notify(`Importado: ${res.imported.map((i) => `${i.provider}${i.email ? ` (${i.email})` : ''}`).join(', ')}`, 'success')
    } else {
      notify('Nenhuma credencial local (~/.codex, ~/.claude, ~/.gemini) encontrada.', 'warning')
    }
    await loadAll(true)
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao importar credenciais locais', 'error')
  } finally {
    importingLocal.value = false
  }
}

async function openOAuthLogin(providerId: string) {
  if (!projectId.value) return
  oauthLoading.value = true
  oauthCallbackInput.value = ''
  try {
    const res = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/connections/${encodeURIComponent(providerId)}/oauth/start`, {
      method: 'POST',
      body: JSON.stringify({})
    }) as typeof oauthData.value
    oauthData.value = res
    oauthOpen.value = true
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao iniciar OAuth', 'error')
  } finally {
    oauthLoading.value = false
  }
}

function openExternalUrl(url?: string) {
  if (url && typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

async function completeOAuthLogin() {
  if (!projectId.value || !oauthData.value) return
  oauthLoading.value = true
  try {
    const res = await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/runner/connections/${encodeURIComponent(oauthData.value.provider)}/oauth/complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          codeOrUrl: oauthCallbackInput.value.trim(),
          state: oauthData.value.state,
          deviceCode: oauthData.value.deviceCode
        })
      }
    ) as { pending?: boolean; connection?: { provider: string; email?: string } }
    if (res.pending) {
      notify('Aguardando autorização no navegador. Tente novamente em instantes.', 'warning')
      return
    }
    notify(`Conectado a ${oauthData.value.provider}${res.connection?.email ? ` (${res.connection.email})` : ''}`, 'success')
    oauthOpen.value = false
    await loadAll(true)
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao concluir OAuth', 'error')
  } finally {
    oauthLoading.value = false
  }
}

async function disconnectProvider(providerId: string) {
  if (!projectId.value) return
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/connections/${encodeURIComponent(providerId)}`, {
      method: 'DELETE'
    })
    notify(`Desconectado: ${providerId}`, 'info')
    await loadAll(true)
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao desconectar', 'error')
  }
}

async function refreshProviderModels(providerId: string) {
  if (!projectId.value) return
  probingProvider.value = providerId
  try {
    const res = await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/runner/providers/${encodeURIComponent(providerId)}/models`
    ) as { online: boolean; error?: string; models: ModelCatalogItem[] }
    const target = providers.value.find((p) => p.id === providerId)
    if (target) {
      target.online = res.online
      target.connectionError = res.error
      target.models = res.models
      target.discoveredModels = res.online ? res.models.map((m) => m.id) : []
    }
    notify(
      res.online ? `${providerId}: ${res.models.length} modelo(s) carregado(s)` : `${providerId} offline: ${res.error || 'sem resposta'}`,
      res.online ? 'success' : 'error'
    )
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao consultar provedor', 'error')
  } finally {
    probingProvider.value = null
  }
}

async function saveRouting(providerConfig?: { id: string; mode: 'http' | 'cli'; baseUrl?: string; apiKey?: string; cliCommand?: string[] }) {
  if (!projectId.value) return
  savingRouting.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/routing`, {
      method: 'PUT',
      body: JSON.stringify({
        primary: primary.value,
        secondary: secondary.value,
        fallbacks: fallbacks.value,
        providerConfig
      })
    })
    notify('Roteamento de modelos atualizado', 'success')
    await loadAll(false)
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao salvar roteamento', 'error')
  } finally {
    savingRouting.value = false
  }
}

async function testPrimaryConnection() {
  if (!projectId.value) return
  testing.value = true
  testResult.value = null
  try {
    const res = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/providers/test`, {
      method: 'POST',
      body: JSON.stringify(primary.value)
    }) as { ok: boolean; latencyMs?: number; preview?: string; error?: string }
    testResult.value = res
    notify(res.ok ? `Conexão OK (${res.latencyMs}ms)` : `Falha: ${res.error}`, res.ok ? 'success' : 'error')
  } catch (err) {
    testResult.value = { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    testing.value = false
  }
}

async function testCatalogModel(providerId: string, modelId: string) {
  if (!projectId.value) return
  const key = `${providerId}/${modelId}`
  modelTestState.value[key] = 'testing'
  try {
    const res = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/providers/test`, {
      method: 'POST',
      body: JSON.stringify({ provider: providerId, model: modelId })
    }) as { ok: boolean; latencyMs?: number; error?: string }
    modelTestState.value[key] = res.ok ? 'ok' : 'error'
    notify(res.ok ? `${key} OK (${res.latencyMs}ms)` : `${key} falhou: ${res.error}`, res.ok ? 'success' : 'error')
  } catch (err) {
    modelTestState.value[key] = 'error'
    notify(err instanceof Error ? err.message : 'Erro ao testar modelo', 'error')
  }
}

async function toggleModelDisabled(providerId: string, modelId: string, disabled: boolean) {
  if (!projectId.value) return
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/models/toggle`, {
      method: 'PATCH',
      body: JSON.stringify({ provider: providerId, modelId, disabled })
    })
    await loadAll(false)
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao atualizar modelo', 'error')
  }
}

async function deleteCustomModel(providerId: string, modelId: string) {
  if (!projectId.value) return
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/models`, {
      method: 'DELETE',
      body: JSON.stringify({ provider: providerId, modelId })
    })
    notify(`Modelo ${providerId}/${modelId} removido`, 'success')
    await loadAll(false)
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao remover modelo', 'error')
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
    notify(`Modelo ${addModelForm.value.provider}/${addModelForm.value.modelId.trim()} registrado`, 'success')
    addModelOpen.value = false
    addModelForm.value = { provider: addModelForm.value.provider, modelId: '', name: '', free: false }
    customModelTestMsg.value = null
    await loadAll(false)
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao registrar modelo', 'error')
  } finally {
    registeringModel.value = false
  }
}

function copyModelId(key: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(key)
  }
  copiedModel.value = key
  setTimeout(() => {
    if (copiedModel.value === key) copiedModel.value = null
  }, 1500)
}

function selectAsPrimary(providerId: string, modelName?: string) {
  primary.value = {
    provider: providerId,
    model: modelName || primary.value.model || 'default'
  }
}

function selectAsSecondary(providerId: string, modelName?: string) {
  secondary.value = {
    provider: providerId,
    model: modelName || secondary.value.model || 'default'
  }
  notify(`Submodelo definido: ${providerId}/${secondary.value.model}`, 'success')
}

function appendToFallback(providerId: string, modelName: string) {
  fallbacks.value.push({ provider: providerId, model: modelName })
  notify(`${providerId}/${modelName} adicionado ao fallback`, 'success')
}

function addFallback() {
  if (!newFallback.value.provider || !newFallback.value.model) return
  fallbacks.value.push({ ...newFallback.value })
}

function moveFallback(index: number, delta: -1 | 1) {
  const target = index + delta
  if (target < 0 || target >= fallbacks.value.length) return
  const copy = [...fallbacks.value]
  const [item] = copy.splice(index, 1)
  if (item) copy.splice(target, 0, item)
  fallbacks.value = copy
}

function removeFallback(index: number) {
  fallbacks.value.splice(index, 1)
}

function openProviderConfig(p: RunnerProviderItem) {
  configForm.value = {
    id: p.id,
    mode: p.mode,
    baseUrl: p.baseUrl || '',
    apiKey: '',
    cliCommandText: (p.cliCommand || []).join(' ')
  }
  configOpen.value = true
}

function openCustomProvider() {
  configForm.value = {
    id: 'custom-gateway',
    mode: 'http',
    baseUrl: 'http://localhost:20128/v1',
    apiKey: '',
    cliCommandText: ''
  }
  configOpen.value = true
}

async function submitProviderConfig() {
  const cliCommand = configForm.value.mode === 'cli'
    ? configForm.value.cliCommandText.trim().split(/\s+/).filter(Boolean)
    : undefined
  await saveRouting({
    id: configForm.value.id.trim(),
    mode: configForm.value.mode,
    baseUrl: configForm.value.baseUrl.trim() || undefined,
    apiKey: configForm.value.apiKey.trim() || undefined,
    cliCommand
  })
  configOpen.value = false
}

watch(projectId, () => {
  loadAll(true)
}, { immediate: true })
</script>

<template>
  <div class="space-y-6">
    <!-- Roteamento Ativo & Cadeia de Fallback (estilo 9Router Combo) -->
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="font-semibold text-sm">Roteamento Ativo &amp; Cadeia de Fallback (9Router)</h2>
            <p class="text-xs text-muted">Define o modelo primário do Runner e a ordem automática de fallback em caso de erro ou rate-limit.</p>
          </div>
          <div class="flex items-center gap-2">
            <UButton size="xs" variant="outline" icon="i-lucide-activity" :loading="testing" @click="testPrimaryConnection">
              Testar Primário
            </UButton>
            <UButton
              v-if="hasPermission('runner:execute')"
              size="xs"
              icon="i-lucide-save"
              :loading="savingRouting"
              @click="saveRouting()"
            >
              Salvar Roteamento
            </UButton>
          </div>
        </div>
      </template>

      <div class="space-y-4">
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-lg border border-primary/40 bg-primary/5">
            <UFormField label="Agente Principal (Primário)">
              <USelect v-model="primary.provider" :items="providerIds" class="w-full" />
            </UFormField>
            <UFormField label="Modelo Principal">
              <UInput v-model="primary.model" placeholder="Ex.: default, gpt-6.2-sol, gpt-4o" class="w-full font-mono text-xs" />
            </UFormField>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-lg border border-default bg-elevated/40">
            <UFormField label="Submodelo (Agente Secundário)">
              <USelect v-model="secondary.provider" :items="providerIds" class="w-full" />
            </UFormField>
            <UFormField label="Modelo Secundário">
              <UInput v-model="secondary.model" placeholder="Ex.: gemma2:2b, gpt-4o-mini" class="w-full font-mono text-xs" />
            </UFormField>
          </div>
        </div>

        <div v-if="testResult" class="text-xs px-3 py-2 rounded-md border" :class="testResult.ok ? 'border-success/40 bg-success/10 text-success' : 'border-error/40 bg-error/10 text-error'">
          <span v-if="testResult.ok">Conectado em {{ testResult.latencyMs }}ms — "{{ testResult.preview }}"</span>
          <span v-else>Falha ({{ testResult.latencyMs }}ms): {{ testResult.error }}</span>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted">Cadeia de Fallback ({{ fallbacks.length }})</span>
          </div>
          <div v-for="(fb, idx) in fallbacks" :key="`${fb.provider}-${idx}`" class="flex items-center gap-2 p-2 rounded-md border border-default">
            <UBadge color="neutral" variant="subtle" size="xs">#{{ idx + 1 }}</UBadge>
            <USelect v-model="fb.provider" :items="providerIds" size="xs" class="w-40" />
            <UInput v-model="fb.model" size="xs" class="flex-1 font-mono" placeholder="modelo" />
            <UButton size="xs" variant="ghost" icon="i-lucide-arrow-up" :disabled="idx === 0" @click="moveFallback(idx, -1)" />
            <UButton size="xs" variant="ghost" icon="i-lucide-arrow-down" :disabled="idx === fallbacks.length - 1" @click="moveFallback(idx, 1)" />
            <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" @click="removeFallback(idx)" />
          </div>

          <div class="flex flex-wrap items-center gap-2 pt-1">
            <USelect v-model="newFallback.provider" :items="providerIds" size="xs" class="w-40" />
            <UInput v-model="newFallback.model" size="xs" class="flex-1 min-w-44 font-mono" placeholder="Ex.: llama3.2 ou sonnet" />
            <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="addFallback">Adicionar Fallback</UButton>
          </div>
        </div>
      </div>
    </UCard>

    <!-- Catálogo de Modelos Disponíveis (9Router ModelsCard + ModelRow) -->
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="font-semibold text-sm">
              Modelos Disponíveis das Conexões Reais
              <UBadge color="primary" variant="subtle" size="xs" class="ml-1">{{ allCatalogModels.length }}</UBadge>
            </h2>
            <p class="text-xs text-muted">Lista apenas modelos retornados diretamente pelas conexões ativas (ou registrados manualmente).</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <UCheckbox v-model="onlyFreeModels" label="Gratuitos" />
            <UInput v-model="modelSearch" size="xs" icon="i-lucide-search" placeholder="Filtrar modelos..." class="w-44" />
            <USelect v-model="modelProviderFilter" :items="['all', ...providerIds]" size="xs" class="w-36" />
            <UButton size="xs" icon="i-lucide-plus" @click="addModelOpen = true">Registrar Modelo</UButton>
          </div>
        </div>
      </template>

      <div v-if="allCatalogModels.length === 0" class="text-xs text-muted py-4 text-center">
        Nenhum modelo encontrado para o filtro atual.
      </div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-2.5 max-h-96 overflow-y-auto pr-1">
        <div
          v-for="row in allCatalogModels"
          :key="row.key"
          class="px-3 py-2 rounded-lg border flex flex-col gap-2 transition-colors"
          :class="[
            modelTestState[row.key] === 'ok' ? 'border-success/50 bg-success/5' :
            modelTestState[row.key] === 'error' ? 'border-error/50 bg-error/5' : 'border-default',
            row.model.disabled ? 'opacity-50' : ''
          ]"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <code class="text-xs font-mono bg-elevated px-1.5 py-0.5 rounded truncate">{{ row.key }}</code>
              <UBadge v-if="row.model.free" color="success" variant="soft" size="xs">FREE</UBadge>
              <UBadge v-if="row.model.custom" color="primary" variant="soft" size="xs">CUSTOM</UBadge>
              <UBadge v-if="row.online" color="info" variant="subtle" size="xs">ONLINE</UBadge>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <UButton
                size="xs"
                variant="ghost"
                icon="i-lucide-flask-conical"
                :loading="modelTestState[row.key] === 'testing'"
                title="Testar modelo"
                @click="testCatalogModel(row.provider, row.model.id)"
              />
              <UButton
                size="xs"
                variant="ghost"
                :icon="copiedModel === row.key ? 'i-lucide-check' : 'i-lucide-copy'"
                title="Copiar ID"
                @click="copyModelId(row.key)"
              />
              <UButton
                v-if="row.model.custom"
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-x"
                title="Remover modelo customizado"
                @click="deleteCustomModel(row.provider, row.model.id)"
              />
            </div>
          </div>

          <div class="flex items-center justify-between gap-2 text-[11px]">
            <span class="text-muted truncate">{{ row.model.name || row.model.id }}</span>
            <div class="flex items-center gap-1 shrink-0">
              <UButton size="xs" variant="soft" color="primary" @click="selectAsPrimary(row.provider, row.model.id)">
                Primário
              </UButton>
              <UButton size="xs" variant="soft" color="info" @click="selectAsSecondary(row.provider, row.model.id)">
                Submodelo
              </UButton>
              <UButton size="xs" variant="soft" color="neutral" @click="appendToFallback(row.provider, row.model.id)">
                + Fallback
              </UButton>
              <UButton
                size="xs"
                variant="ghost"
                :color="row.model.disabled ? 'success' : 'neutral'"
                @click="toggleModelDisabled(row.provider, row.model.id, !row.model.disabled)"
              >
                {{ row.model.disabled ? 'Ativar' : 'Desativar' }}
              </UButton>
            </div>
          </div>
        </div>
      </div>
    </UCard>

    <!-- Catálogo de Conexões & Provedores -->
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <UiSegmentedTabs v-model="categoryFilter" :items="categoryTabs" />
          <div class="flex flex-wrap items-center gap-2">
            <UButton size="xs" variant="outline" icon="i-lucide-key-round" :loading="importingLocal" @click="importLocalAuth()">
              Importar Auth Local
            </UButton>
            <UButton size="xs" variant="outline" icon="i-lucide-radar" :loading="probing" @click="loadAll(true)">
              Detectar Modelos Locais
            </UButton>
            <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="openCustomProvider">
              Novo Provedor
            </UButton>
          </div>
        </div>
      </template>

      <div v-if="loadingProviders" class="text-xs text-muted py-6 text-center">Carregando conexões...</div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <div
          v-for="p in filteredProviders"
          :key="p.id"
          class="p-3 rounded-lg border border-default flex flex-col justify-between gap-3 bg-default"
          :class="primary.provider === p.id ? 'ring-1 ring-primary' : ''"
        >
          <div class="space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="font-semibold text-sm truncate">{{ p.id }}</span>
                <UBadge :color="categoryColor(p.category)" variant="subtle" size="xs">{{ categoryLabel(p.category) }}</UBadge>
              </div>
              <UBadge
                :color="p.online ? 'success' : p.configured ? 'info' : 'neutral'"
                variant="soft"
                size="xs"
              >
                {{ p.online ? 'Online' : p.configured ? 'Configurado' : 'Sem chave' }}
              </UBadge>
            </div>

            <div class="text-[11px] font-mono text-muted truncate">
              <span v-if="p.mode === 'cli'">$ {{ (p.cliCommand || []).join(' ') }}</span>
              <span v-else>{{ p.baseUrl || 'Endpoint padrão SDK' }}</span>
            </div>
            <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
              <UBadge v-if="p.hasFree" color="success" variant="subtle" size="xs">Grátis</UBadge>
              <UBadge v-if="p.connectedAccount" color="primary" variant="soft" size="xs">
                {{ p.connectedAccount.email || p.connectedAccount.authType }}
                <span v-if="p.connectedAccount.planType"> ({{ p.connectedAccount.planType }})</span>
              </UBadge>
              <span class="text-muted">{{ p.models.length }} modelo(s)</span>
              <span v-if="!p.online && p.connectionError" class="text-warning truncate">· {{ p.connectionError }}</span>
            </div>

            <div v-if="p.discoveredModels.length > 0" class="flex flex-wrap gap-1 pt-1">
              <UButton
                v-for="m in p.discoveredModels.slice(0, 6)"
                :key="m"
                size="xs"
                variant="soft"
                color="neutral"
                class="font-mono text-[10px]"
                @click="selectAsPrimary(p.id, m)"
              >
                {{ m }}
              </UButton>
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-1 pt-2 border-t border-default/60">
            <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" :loading="probingProvider === p.id" @click="refreshProviderModels(p.id)">
              Carregar
            </UButton>
            <UButton v-if="p.supportsOAuth" size="xs" variant="soft" color="primary" icon="i-lucide-log-in" :loading="oauthLoading" @click="openOAuthLogin(p.id)">
              OAuth
            </UButton>
            <UButton v-if="p.supportsLocalImport && !p.connectedAccount" size="xs" variant="ghost" icon="i-lucide-download" @click="importLocalAuth(p.id)">
              Importar
            </UButton>
            <UButton v-if="p.connectedAccount" size="xs" variant="ghost" color="error" icon="i-lucide-unlink" @click="disconnectProvider(p.id)">
              Sair
            </UButton>
            <UButton size="xs" variant="ghost" icon="i-lucide-check-circle" @click="selectAsPrimary(p.id, p.discoveredModels[0] || p.models[0]?.id)">
              Primário
            </UButton>
            <UButton size="xs" variant="ghost" icon="i-lucide-settings-2" @click="openProviderConfig(p)">
              Configurar
            </UButton>
          </div>
        </div>
      </div>
    </UCard>

    <!-- Modal: Registrar Modelo Customizado (estilo 9Router AddCustomModelModal) -->
    <UModal v-model:open="addModelOpen" title="Registrar Modelo Customizado">
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
              <UButton variant="ghost" @click="addModelOpen = false">Cancelar</UButton>
              <UButton :loading="registeringModel" @click="submitRegisterModel">Registrar</UButton>
            </div>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Modal: Configurar Conexão / Novo Provedor -->
    <UModal v-model:open="configOpen" :title="`Configurar Provedor: ${configForm.id}`">
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
            <UButton variant="ghost" @click="configOpen = false">Cancelar</UButton>
            <UButton :loading="savingRouting" @click="submitProviderConfig">Salvar Conexão</UButton>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Modal: Conectar via OAuth (PKCE ou Device Code estilo 9Router) -->
    <UModal v-model:open="oauthOpen" :title="`Conectar ${oauthData?.provider || ''} via OAuth`">
      <template #body>
        <div v-if="oauthData" class="space-y-4">
          <template v-if="oauthData.flowType === 'device_code'">
            <p class="text-xs text-muted">1. Clique para abrir a página de ativação e informe o código abaixo:</p>
            <div class="text-center py-3 rounded-lg border border-default bg-elevated font-mono text-2xl font-bold tracking-widest">
              {{ oauthData.userCode }}
            </div>
            <div class="flex justify-between gap-2">
              <UButton variant="outline" icon="i-lucide-external-link" @click="openExternalUrl(oauthData.verificationUri)">
                Abrir GitHub
              </UButton>
              <UButton :loading="oauthLoading" @click="completeOAuthLogin">Verificar Autorização</UButton>
            </div>
          </template>
          <template v-else>
            <p class="text-xs text-muted">
              1. Abra o login no navegador, autorize a conta e cole abaixo a URL de retorno (ou o código `code`) exibido no endereço:
            </p>
            <UButton variant="outline" icon="i-lucide-external-link" class="w-full justify-center" @click="openExternalUrl(oauthData.authUrl)">
              Abrir Login {{ oauthData.provider }} no Navegador
            </UButton>
            <UFormField label="URL de Callback ou Código OAuth">
              <UInput v-model="oauthCallbackInput" placeholder="http://localhost:1455/auth/callback?code=..." class="w-full font-mono text-xs" />
            </UFormField>
            <div class="flex justify-end gap-2">
              <UButton variant="ghost" @click="oauthOpen = false">Cancelar</UButton>
              <UButton :loading="oauthLoading" @click="completeOAuthLogin">Concluir Conexão</UButton>
            </div>
          </template>
        </div>
      </template>
    </UModal>
  </div>
</template>
