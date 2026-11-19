<script setup lang="ts">
const { apiFetch, notify, currentUser } = useBrainApi()

interface SystemSettingItem {
  id: string
  tenantId: string
  category: string
  key: string
  value: unknown
  isSecret: boolean
  updatedBy?: string | null
  updatedAt?: string | null
}

const loading = ref(false)
const savingKey = ref<string | null>(null)
const items = ref<SystemSettingItem[]>([])
const drafts = ref<Record<string, string>>({})

const newCategory = ref('embeddings')
const newKey = ref('')
const newValue = ref('')
const newIsSecret = ref(false)
const creating = ref(false)

const isAdmin = computed(() =>
  (currentUser.value?.roles ?? []).some((r) => ['admin', 'owner', 'tech-lead'].includes(r.toLowerCase()))
)

const categoryLabels: Record<string, string> = {
  embeddings: 'Embeddings & Ollama',
  runner: 'Agentes & Runner',
  cache: 'Cache Distribuído (Valkey / Redis)',
  storage: 'Object Storage (MinIO / S3)',
  github: 'GitHub & Repositórios',
  smtp: 'Servidor de Email (SMTP)',
  policies: 'Políticas & Escopos Padrão'
}

const groupedItems = computed(() => {
  const groups = new Map<string, SystemSettingItem[]>()
  for (const item of items.value) {
    const list = groups.get(item.category) ?? []
    list.push(item)
    groups.set(item.category, list)
  }
  return Array.from(groups.entries()).map(([category, entries]) => ({
    category,
    label: categoryLabels[category] ?? category,
    entries
  }))
})

function settingId(category: string, key: string): string {
  return `${category}:${key}`
}

function formatDraftValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function parseInputValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed !== '' && !Number.isNaN(Number(trimmed)) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed)
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return raw
    }
  }
  return raw
}

async function loadSettings() {
  loading.value = true
  try {
    const res = await apiFetch<{ items?: SystemSettingItem[] }>('/v1/system/settings')
    items.value = res.items ?? []
    const nextDrafts: Record<string, string> = {}
    for (const item of items.value) {
      nextDrafts[settingId(item.category, item.key)] = item.isSecret ? '' : formatDraftValue(item.value)
    }
    drafts.value = nextDrafts
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

async function saveSetting(item: SystemSettingItem) {
  const id = settingId(item.category, item.key)
  const raw = drafts.value[id] ?? ''
  if (item.isSecret && (!raw.trim() || raw.trim() === '***')) {
    notify('Digite um novo valor para atualizar este segredo.', 'warning')
    return
  }
  savingKey.value = id
  try {
    await apiFetch('/v1/system/settings', {
      method: 'PUT',
      body: JSON.stringify({
        category: item.category,
        key: item.key,
        value: item.isSecret ? raw : parseInputValue(raw),
        isSecret: item.isSecret
      })
    })
    notify(`Configuração '${id}' salva no PostgreSQL.`, 'success')
    await loadSettings()
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao salvar configuração.', 'error')
  } finally {
    savingKey.value = null
  }
}

async function createSetting() {
  if (!newCategory.value.trim() || !newKey.value.trim()) {
    notify('Informe categoria e chave.', 'warning')
    return
  }
  creating.value = true
  try {
    await apiFetch('/v1/system/settings', {
      method: 'PUT',
      body: JSON.stringify({
        category: newCategory.value.trim(),
        key: newKey.value.trim(),
        value: newIsSecret.value ? newValue.value : parseInputValue(newValue.value),
        isSecret: newIsSecret.value
      })
    })
    notify(`Configuração '${newCategory.value}:${newKey.value}' adicionada.`, 'success')
    newKey.value = ''
    newValue.value = ''
    newIsSecret.value = false
    await loadSettings()
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao criar configuração.', 'error')
  } finally {
    creating.value = false
  }
}

async function deleteSetting(item: SystemSettingItem) {
  const id = settingId(item.category, item.key)
  savingKey.value = id
  try {
    await apiFetch(`/v1/system/settings/${encodeURIComponent(item.category)}/${encodeURIComponent(item.key)}`, {
      method: 'DELETE'
    })
    notify(`Configuração '${id}' removida.`, 'success')
    await loadSettings()
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Erro ao remover configuração.', 'error')
  } finally {
    savingKey.value = null
  }
}

onMounted(() => {
  loadSettings()
})
</script>

<template>
  <div class="space-y-5">
    <UCard class="border border-default">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 class="text-sm font-semibold text-highlighted">Configurações Dinâmicas (PostgreSQL)</h3>
          <p class="text-xs text-muted mt-0.5">
            Provedores de embeddings, modelos do runner, SMTP e integrações desacoplados do .env e persistidos no banco.
          </p>
        </div>
        <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" :loading="loading" @click="loadSettings">
          Atualizar
        </UButton>
      </div>
    </UCard>

    <UCard v-if="isAdmin" class="border border-default">
      <h4 class="text-xs font-semibold uppercase tracking-wide text-muted mb-3">Adicionar / Sobrescrever Parâmetro</h4>
      <div class="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
        <UFormField label="Categoria" class="md:col-span-3">
          <UInput v-model="newCategory" placeholder="embeddings, runner, smtp..." size="sm" />
        </UFormField>
        <UFormField label="Chave" class="md:col-span-3">
          <UInput v-model="newKey" placeholder="ex: model" size="sm" />
        </UFormField>
        <UFormField label="Valor (texto ou JSON)" class="md:col-span-4">
          <UInput v-model="newValue" :type="newIsSecret ? 'password' : 'text'" placeholder="ex: bge-m3" size="sm" />
        </UFormField>
        <div class="md:col-span-2 flex items-center justify-between gap-2">
          <UCheckbox v-model="newIsSecret" label="Segredo" />
          <UButton size="sm" color="primary" :loading="creating" @click="createSetting">
            Salvar
          </UButton>
        </div>
      </div>
    </UCard>

    <div v-if="loading && groupedItems.length === 0" class="text-xs text-muted py-6 text-center">
      Carregando configurações do banco...
    </div>

    <div v-else class="space-y-4">
      <UCard v-for="group in groupedItems" :key="group.category" class="border border-default">
        <template #header>
          <div class="flex items-center justify-between">
            <span class="text-sm font-semibold text-highlighted">{{ group.label }}</span>
            <UBadge color="neutral" variant="subtle" size="xs">{{ group.entries.length }}</UBadge>
          </div>
        </template>

        <div class="divide-y divide-default">
          <div
            v-for="item in group.entries"
            :key="settingId(item.category, item.key)"
            class="py-3 first:pt-0 last:pb-0 flex flex-col md:flex-row md:items-center gap-3"
          >
            <div class="md:w-64 shrink-0">
              <div class="flex items-center gap-2">
                <span class="text-xs font-mono font-semibold text-highlighted">{{ item.key }}</span>
                <UBadge v-if="item.isSecret" color="warning" variant="subtle" size="xs">segredo</UBadge>
              </div>
              <div v-if="item.updatedBy" class="text-[11px] text-muted mt-0.5">
                por {{ item.updatedBy }}
              </div>
            </div>

            <div class="flex-1">
              <UInput
                v-model="drafts[settingId(item.category, item.key)]"
                :type="item.isSecret ? 'password' : 'text'"
                :placeholder="item.isSecret ? 'Valor mascarado (digite para substituir)' : 'Valor'"
                :disabled="!isAdmin"
                size="sm"
                class="font-mono"
              />
            </div>

            <div v-if="isAdmin" class="flex items-center gap-2 shrink-0">
              <UButton
                size="xs"
                color="primary"
                variant="soft"
                :loading="savingKey === settingId(item.category, item.key)"
                @click="saveSetting(item)"
              >
                Salvar
              </UButton>
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                :loading="savingKey === settingId(item.category, item.key)"
                @click="deleteSetting(item)"
              />
            </div>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>
