<script setup lang="ts">
export interface AccessTokenRow {
  id: string
  userId: string
  clientId: string
  clientName: string
  label: string
  scopes: string[]
  allowedProjects: string[]
  lastUsedAt?: string | null
  expiresAt: string
  revokedAt?: string | null
  createdAt: string
}

const props = defineProps<{
  tokens: AccessTokenRow[]
  canManageAll?: boolean
}>()

const emit = defineEmits<{
  revokeToken: [tokenId: string]
  deleteToken: [tokenId: string]
  revokeUserTokens: [userId: string]
  openCreateToken: []
}>()

const search = ref('')
const statusFilter = ref<'all' | 'active' | 'inactive'>('all')

function isExpired(t: AccessTokenRow) {
  return Date.parse(t.expiresAt) <= Date.now()
}

function isTokenActive(t: AccessTokenRow) {
  return !t.revokedAt && !isExpired(t)
}

function resolveAccessMethod(t: AccessTokenRow): { label: string; color: 'primary' | 'info' | 'warning' | 'neutral' } {
  const txt = `${t.label} ${t.clientName} ${t.clientId}`.toLowerCase()
  if (txt.includes('oauth 2.1') || txt.includes('pkce') || txt.includes('codex')) {
    return { label: 'OAuth 2.1 PKCE', color: 'primary' }
  }
  if (txt.includes('device')) {
    return { label: 'OAuth Device Flow', color: 'info' }
  }
  if (txt.includes('cli') || txt.includes('stdio')) {
    return { label: 'CLI / Stdio Proxy', color: 'warning' }
  }
  return { label: 'Bearer Token', color: 'neutral' }
}

const activeCount = computed(() => props.tokens.filter(isTokenActive).length)
const oauthCount = computed(() => props.tokens.filter(t => isTokenActive(t) && resolveAccessMethod(t).label.startsWith('OAuth')).length)
const revokedCount = computed(() => props.tokens.filter(t => !isTokenActive(t)).length)

const filteredTokens = computed(() => {
  const q = search.value.trim().toLowerCase()
  return props.tokens.filter((t) => {
    const active = isTokenActive(t)
    if (statusFilter.value === 'active' && !active) return false
    if (statusFilter.value === 'inactive' && active) return false
    if (!q) return true
    return (
      t.clientName.toLowerCase().includes(q) ||
      t.label.toLowerCase().includes(q) ||
      t.userId.toLowerCase().includes(q) ||
      t.scopes.some(s => s.toLowerCase().includes(q)) ||
      t.allowedProjects.some(p => p.toLowerCase().includes(q))
    )
  })
})

function formatDate(iso?: string | null) {
  if (!iso) return 'Nunca'
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="rounded-lg border border-default bg-elevated/40 p-3">
        <div class="text-[11px] text-muted">Tokens Ativos</div>
        <div class="text-base font-semibold text-success mt-0.5">{{ activeCount }}</div>
      </div>
      <div class="rounded-lg border border-default bg-elevated/40 p-3">
        <div class="text-[11px] text-muted">Sessões OAuth Ativas</div>
        <div class="text-base font-semibold text-primary mt-0.5">{{ oauthCount }}</div>
      </div>
      <div class="rounded-lg border border-default bg-elevated/40 p-3">
        <div class="text-[11px] text-muted">Revogados / Expirados</div>
        <div class="text-base font-semibold text-warning mt-0.5">{{ revokedCount }}</div>
      </div>
      <div class="rounded-lg border border-default bg-elevated/40 p-3">
        <div class="text-[11px] text-muted">Total Registrado</div>
        <div class="text-base font-semibold text-highlighted mt-0.5">{{ tokens.length }}</div>
      </div>
    </div>

    <UCard>
      <template #header>
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 class="font-semibold text-sm">Acessos via Token, OAuth 2.1 &amp; Revogações</h3>
            <p class="text-xs text-muted">Visualize credenciais emitidas (OAuth PKCE, Device Flow, Bearer/CLI), último uso e revogue acessos instantaneamente.</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <UInput
              v-model="search"
              size="xs"
              icon="i-lucide-search"
              placeholder="Buscar cliente, usuário, escopo..."
              class="w-52"
            />
            <USelect
              v-model="statusFilter"
              :items="[
                { label: 'Todos', value: 'all' },
                { label: 'Somente Ativos', value: 'active' },
                { label: 'Revogados / Expirados', value: 'inactive' }
              ]"
              size="xs"
              class="w-40"
            />
            <UButton size="xs" color="info" variant="soft" icon="i-lucide-key-round" @click="emit('openCreateToken')">
              Gerar Token
            </UButton>
          </div>
        </div>
      </template>

      <UiEmptyState
        v-if="filteredTokens.length === 0"
        compact
        icon="i-lucide-key-round"
        title="Nenhum token ou sessão OAuth encontrada"
        description="Gere um token MCP ou conecte um cliente via OAuth 2.1 (Codex, Cursor, CLI)."
      />

      <UTable
        v-else
        :data="filteredTokens"
        :columns="[
          { accessorKey: 'label', header: 'Origem & Cliente' },
          { accessorKey: 'userId', header: 'Usuário' },
          { accessorKey: 'scopes', header: 'Escopos & Projetos' },
          { accessorKey: 'status', header: 'Status & Uso' },
          { id: 'actions', header: '' }
        ]"
      >
        <template #label-cell="{ row }">
          <div class="space-y-1">
            <div class="font-medium text-sm text-highlighted">{{ row.original.label || row.original.clientName }}</div>
            <div class="flex items-center gap-1.5">
              <UBadge :color="resolveAccessMethod(row.original).color" variant="subtle" size="xs">
                {{ resolveAccessMethod(row.original).label }}
              </UBadge>
              <span class="text-[11px] font-mono text-muted">{{ row.original.clientName }}</span>
            </div>
          </div>
        </template>

        <template #userId-cell="{ row }">
          <div class="font-mono text-xs text-highlighted">{{ row.original.userId }}</div>
          <div class="text-[11px] text-muted">Criado: {{ formatDate(row.original.createdAt) }}</div>
        </template>

        <template #scopes-cell="{ row }">
          <div class="flex flex-wrap gap-1">
            <UBadge v-for="s in row.original.scopes" :key="s" size="xs" variant="soft" color="neutral">
              {{ s }}
            </UBadge>
            <UBadge v-for="p in row.original.allowedProjects" :key="p" size="xs" variant="outline" color="primary">
              {{ p }}
            </UBadge>
            <span v-if="!row.original.allowedProjects.length" class="text-[11px] text-muted">Projetos do usuário</span>
          </div>
        </template>

        <template #status-cell="{ row }">
          <div class="space-y-1">
            <UBadge v-if="row.original.revokedAt" color="error" variant="subtle" size="xs">
              Revogado em {{ formatDate(row.original.revokedAt) }}
            </UBadge>
            <UBadge v-else-if="isExpired(row.original)" color="warning" variant="subtle" size="xs">
              Expirado
            </UBadge>
            <UBadge v-else color="success" variant="subtle" size="xs">
              Ativo
            </UBadge>
            <div class="text-[11px] text-muted">
              Último uso: {{ formatDate(row.original.lastUsedAt) }}
            </div>
          </div>
        </template>

        <template #actions-cell="{ row }">
          <div class="flex items-center justify-end gap-1">
            <UButton
              v-if="isTokenActive(row.original)"
              size="xs"
              color="error"
              variant="soft"
              icon="i-lucide-shield-off"
              @click="emit('revokeToken', row.original.id)"
            >
              Revogar
            </UButton>
            <UButton
              v-else
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-trash-2"
              @click="emit('deleteToken', row.original.id)"
            >
              Apagar
            </UButton>
            <UButton
              v-if="canManageAll && isTokenActive(row.original)"
              size="xs"
              color="warning"
              variant="ghost"
              icon="i-lucide-user-x"
              title="Revogar todos os tokens deste usuário"
              @click="emit('revokeUserTokens', row.original.userId)"
            />
          </div>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
