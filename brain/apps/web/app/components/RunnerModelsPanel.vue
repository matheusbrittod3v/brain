<script setup lang="ts">
import RoutingTab from './runner/models/RoutingTab.vue'
import ProvidersTab from './runner/models/ProvidersTab.vue'
import CatalogTab from './runner/models/CatalogTab.vue'
import Modals from './runner/models/Modals.vue'
import type { ModelCatalogItem, RoutingTarget, RunnerProviderItem } from './runner/models/types'

const { projectId, apiFetch, notify, hasPermission } = useBrainApi()

const providers = ref<RunnerProviderItem[]>([])
const loadingProviders = ref(false)
const probing = ref(false)
const savingRouting = ref(false)
const testing = ref(false)
const testingSecondary = ref(false)
const testResult = ref<{ ok: boolean; latencyMs?: number; preview?: string; error?: string } | null>(null)
const secondaryTestResult = ref<{ ok: boolean; latencyMs?: number; preview?: string; error?: string } | null>(null)

const sectionTab = ref<'routing' | 'providers' | 'models'>('routing')
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

const configOpen = ref(false)
const configInitial = ref({
  id: '',
  mode: 'http' as 'http' | 'cli',
  baseUrl: '',
  apiKey: '',
  cliCommandText: ''
})

const addModelOpen = ref(false)
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

const providerIds = computed(() => providers.value.map(p => p.id))
const onlineProvidersCount = computed(() => providers.value.filter(p => p.online).length)
const providerOptions = computed(() =>
  providers.value.map(p => ({ label: p.online ? `${p.id} (online)` : p.id, value: p.id }))
)
const modelFilterProviderOptions = computed(() => [
  { label: 'Todos os provedores', value: 'all' },
  ...providerOptions.value
])

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
      rows.push({ key, provider: p.id, category: p.category, online: p.online, configured: p.configured, model: m })
    }
  }
  return rows
})

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
    notify('Erro ao carregar provedores', err instanceof Error ? err.message : String(err), 'error')
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
      notify('Credenciais importadas', res.imported.map(i => `${i.provider}${i.email ? ` (${i.email})` : ''}`).join(', '), 'success')
    } else {
      notify('Nenhuma credencial local encontrada', undefined, 'warning')
    }
    await loadAll(true)
  } catch (err) {
    notify('Erro ao importar credenciais', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    importingLocal.value = false
  }
}

let oauthPollTimer: ReturnType<typeof setInterval> | null = null
function stopOAuthPolling() {
  if (oauthPollTimer) {
    clearInterval(oauthPollTimer)
    oauthPollTimer = null
  }
}
watch(oauthOpen, (open) => { if (!open) stopOAuthPolling() })

async function openOAuthLogin(providerId: string) {
  if (!projectId.value) return
  stopOAuthPolling()
  oauthLoading.value = true
  try {
    const res = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/connections/${encodeURIComponent(providerId)}/oauth/start`, {
      method: 'POST',
      body: JSON.stringify({})
    }) as typeof oauthData.value
    oauthData.value = res
    oauthOpen.value = true

    if (res?.flowType === 'pkce' && res.state) {
      const stateVal = res.state
      oauthPollTimer = setInterval(async () => {
        if (!oauthOpen.value || !projectId.value) {
          stopOAuthPolling()
          return
        }
        try {
          const st = await apiFetch(
            `/v1/projects/${encodeURIComponent(projectId.value)}/runner/connections/${encodeURIComponent(providerId)}/oauth/status?state=${encodeURIComponent(stateVal)}`
          ) as { completed: boolean; ok?: boolean; error?: string; connection?: { email?: string } }
          if (st.completed) {
            stopOAuthPolling()
            if (st.ok) {
              notify(`Conectado a ${providerId}`, st.connection?.email || 'Autenticação concluída', 'success')
              oauthOpen.value = false
              await loadAll(true)
            } else {
              notify('Erro no OAuth2', st.error || 'Falha ao autenticar', 'error')
            }
          }
        } catch {
          // Ignore transient poll errors
        }
      }, 1500)
    }
  } catch (err) {
    notify('Erro ao iniciar OAuth', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    oauthLoading.value = false
  }
}

async function completeOAuthLogin(callbackInput: string) {
  if (!projectId.value || !oauthData.value) return
  oauthLoading.value = true
  try {
    const res = await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/runner/connections/${encodeURIComponent(oauthData.value.provider)}/oauth/complete`,
      {
        method: 'POST',
        body: JSON.stringify({
          codeOrUrl: callbackInput.trim(),
          state: oauthData.value.state,
          deviceCode: oauthData.value.deviceCode
        })
      }
    ) as { pending?: boolean; connection?: { provider: string; email?: string } }
    if (res.pending) {
      notify('Aguardando autorização no navegador', undefined, 'warning')
      return
    }
    notify(`Conectado a ${oauthData.value.provider}`, res.connection?.email, 'success')
    oauthOpen.value = false
    await loadAll(true)
  } catch (err) {
    notify('Erro ao concluir OAuth', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    oauthLoading.value = false
  }
}

async function disconnectProvider(providerId: string) {
  if (!projectId.value) return
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/connections/${encodeURIComponent(providerId)}`, { method: 'DELETE' })
    notify(`Desconectado: ${providerId}`, undefined, 'primary')
    await loadAll(true)
  } catch (err) {
    notify('Erro ao desconectar', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function refreshProviderModels(providerId: string) {
  if (!projectId.value) return
  probingProvider.value = providerId
  try {
    const res = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/providers/${encodeURIComponent(providerId)}/models`) as { online: boolean; error?: string; models: ModelCatalogItem[] }
    const target = providers.value.find(p => p.id === providerId)
    if (target) {
      target.online = res.online
      target.connectionError = res.error
      target.models = res.models
      target.discoveredModels = res.online ? res.models.map(m => m.id) : []
    }
    notify(res.online ? `${providerId}: ${res.models.length} modelo(s)` : `${providerId} offline`, res.error, res.online ? 'success' : 'error')
  } catch (err) {
    notify('Erro ao consultar provedor', err instanceof Error ? err.message : String(err), 'error')
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
      body: JSON.stringify({ primary: primary.value, secondary: secondary.value, fallbacks: fallbacks.value, providerConfig })
    })
    notify('Roteamento de modelos atualizado', undefined, 'success')
    configOpen.value = false
    await loadAll(false)
  } catch (err) {
    notify('Erro ao salvar roteamento', err instanceof Error ? err.message : String(err), 'error')
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
    notify(res.ok ? `Primário OK (${res.latencyMs}ms)` : `Falha no Primário: ${res.error}`, undefined, res.ok ? 'success' : 'error')
  } catch (err) {
    testResult.value = { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    testing.value = false
  }
}

async function testSecondaryConnection() {
  if (!projectId.value) return
  testingSecondary.value = true
  secondaryTestResult.value = null
  try {
    const res = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/providers/test`, {
      method: 'POST',
      body: JSON.stringify(secondary.value)
    }) as { ok: boolean; latencyMs?: number; preview?: string; error?: string }
    secondaryTestResult.value = res
    notify(res.ok ? `Submodelo OK (${res.latencyMs}ms)` : `Falha no Submodelo: ${res.error}`, undefined, res.ok ? 'success' : 'error')
  } catch (err) {
    secondaryTestResult.value = { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    testingSecondary.value = false
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
    notify(res.ok ? `${key} OK (${res.latencyMs}ms)` : `${key} falhou`, res.error, res.ok ? 'success' : 'error')
  } catch (err) {
    modelTestState.value[key] = 'error'
    notify('Erro ao testar modelo', err instanceof Error ? err.message : String(err), 'error')
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
    notify('Erro ao atualizar modelo', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function deleteCustomModel(providerId: string, modelId: string) {
  if (!projectId.value) return
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/runner/models`, {
      method: 'DELETE',
      body: JSON.stringify({ provider: providerId, modelId })
    })
    notify(`Modelo ${providerId}/${modelId} removido`, undefined, 'success')
    await loadAll(false)
  } catch (err) {
    notify('Erro ao remover modelo', err instanceof Error ? err.message : String(err), 'error')
  }
}

function copyModelId(key: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    navigator.clipboard.writeText(key)
  }
  copiedModel.value = key
  setTimeout(() => { if (copiedModel.value === key) copiedModel.value = null }, 1500)
}

function selectAsPrimary(providerId: string, modelName?: string) {
  primary.value = { provider: providerId, model: modelName || primary.value.model || 'default' }
}

function selectAsSecondary(providerId: string, modelName?: string) {
  secondary.value = { provider: providerId, model: modelName || secondary.value.model || 'default' }
  notify(`Submodelo definido: ${providerId}/${secondary.value.model}`, undefined, 'success')
}

function swapPrimaryAndSecondary() {
  const prevPrimary = { ...primary.value }
  primary.value = { ...secondary.value }
  secondary.value = prevPrimary
  notify('Principal e Submodelo invertidos', `${primary.value.provider}/${primary.value.model} ↔ ${secondary.value.provider}/${secondary.value.model}`, 'primary')
}

function openProviderConfig(p: RunnerProviderItem) {
  configInitial.value = {
    id: p.id,
    mode: p.mode,
    baseUrl: p.baseUrl || '',
    apiKey: '',
    cliCommandText: (p.cliCommand || []).join(' ')
  }
  configOpen.value = true
}

function openCustomProvider() {
  configInitial.value = {
    id: 'custom-gateway',
    mode: 'http',
    baseUrl: 'http://localhost:20128/v1',
    apiKey: '',
    cliCommandText: ''
  }
  configOpen.value = true
}

watch(projectId, () => { loadAll(true) }, { immediate: true })
</script>

<template>
  <div class="space-y-5">
    <div class="rounded-xl border border-default bg-elevated/40 p-4">
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 flex-1">
          <div class="min-w-0">
            <div class="text-[11px] text-muted">Principal</div>
            <div class="text-xs font-mono font-semibold text-highlighted truncate mt-0.5">{{ primary.provider }} / {{ primary.model }}</div>
          </div>
          <div class="min-w-0">
            <div class="text-[11px] text-muted">Submodelo</div>
            <div class="text-xs font-mono font-semibold text-highlighted truncate mt-0.5">{{ secondary.provider }} / {{ secondary.model }}</div>
          </div>
          <div class="min-w-0">
            <div class="text-[11px] text-muted">Fallbacks</div>
            <div class="text-xs font-semibold text-highlighted mt-0.5">{{ fallbacks.length }} {{ fallbacks.length === 1 ? 'configurado' : 'configurados' }}</div>
          </div>
          <div class="min-w-0">
            <div class="text-[11px] text-muted">Conexões</div>
            <div class="text-xs font-semibold mt-0.5" :class="onlineProvidersCount > 0 ? 'text-success' : 'text-muted'">
              {{ onlineProvidersCount }} / {{ providers.length }} online
            </div>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 shrink-0">
          <UButton size="xs" variant="outline" icon="i-lucide-activity" :loading="testing" @click="testPrimaryConnection">
            Testar Primário
          </UButton>
          <UButton v-if="hasPermission('runner:execute')" size="xs" icon="i-lucide-save" :loading="savingRouting" @click="saveRouting()">
            Salvar Roteamento
          </UButton>
        </div>
      </div>

      <div
        v-if="testResult"
        class="mt-3 text-xs px-3 py-2 rounded-lg border"
        :class="testResult.ok ? 'border-success/40 bg-success/10 text-success' : 'border-error/40 bg-error/10 text-error'"
      >
        <span v-if="testResult.ok">Conectado em {{ testResult.latencyMs }}ms — "{{ testResult.preview }}"</span>
        <span v-else>Falha ({{ testResult.latencyMs }}ms): {{ testResult.error }}</span>
      </div>
    </div>

    <UiSegmentedTabs
      v-model="sectionTab"
      :items="[
        { label: 'Roteamento & Fallback', value: 'routing', icon: 'i-lucide-git-branch' },
        { label: 'Provedores & Auth', value: 'providers', icon: 'i-lucide-plug', badge: onlineProvidersCount || undefined },
        { label: 'Catálogo de Modelos', value: 'models', icon: 'i-lucide-layers', badge: allCatalogModels.length || undefined }
      ]"
    />

    <RoutingTab
      v-if="sectionTab === 'routing'"
      v-model:primary="primary"
      v-model:secondary="secondary"
      v-model:fallbacks="fallbacks"
      :providers="providers"
      :provider-options="providerOptions"
      :testing-primary="testing"
      :testing-secondary="testingSecondary"
      :secondary-test-result="secondaryTestResult"
      @test-primary="testPrimaryConnection"
      @test-secondary="testSecondaryConnection"
      @swap="swapPrimaryAndSecondary"
      @select-secondary="selectAsSecondary"
    />

    <ProvidersTab
      v-else-if="sectionTab === 'providers'"
      :providers="providers"
      :primary-provider="primary.provider"
      :loading-providers="loadingProviders"
      :probing="probing"
      :importing-local="importingLocal"
      :probing-provider="probingProvider"
      :oauth-loading="oauthLoading"
      @import-local="importLocalAuth"
      @probe-all="loadAll(true)"
      @open-custom-provider="openCustomProvider"
      @refresh-provider="refreshProviderModels"
      @open-o-auth="openOAuthLogin"
      @disconnect="disconnectProvider"
      @open-config="openProviderConfig"
      @select-primary="selectAsPrimary"
      @select-secondary="selectAsSecondary"
    />

    <CatalogTab
      v-else
      v-model:search="modelSearch"
      v-model:provider-filter="modelProviderFilter"
      v-model:only-free="onlyFreeModels"
      :rows="allCatalogModels"
      :provider-filter-items="modelFilterProviderOptions"
      :model-test-state="modelTestState"
      :copied-model="copiedModel"
      @open-add-model="addModelOpen = true"
      @test-model="testCatalogModel"
      @copy-model="copyModelId"
      @toggle-disabled="toggleModelDisabled"
      @delete-custom="deleteCustomModel"
      @select-primary="selectAsPrimary"
      @select-secondary="selectAsSecondary"
      @append-fallback="(p, m) => { fallbacks.push({ provider: p, model: m }); notify(`${p}/${m} adicionado ao fallback`, undefined, 'success') }"
    />

    <Modals
      v-model:add-model-open="addModelOpen"
      v-model:config-open="configOpen"
      v-model:oauth-open="oauthOpen"
      :provider-ids="providerIds"
      :config-initial="configInitial"
      :oauth-data="oauthData"
      :saving-routing="savingRouting"
      :oauth-loading="oauthLoading"
      @reload="loadAll"
      @save-provider-config="saveRouting"
      @complete-o-auth="completeOAuthLogin"
    />
  </div>
</template>
