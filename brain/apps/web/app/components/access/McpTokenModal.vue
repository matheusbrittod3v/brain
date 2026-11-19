<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })
const { apiFetch, notify } = useBrainApi()

interface McpTokenItem {
  id: string
  clientId: string
  clientName: string
  label: string
  lastUsedAt: string | null
  expiresAt: string
  revokedAt: string | null
  createdAt: string
}

const label = ref('codex-mcp')
const expiresInDays = ref(90)
const generating = ref(false)
const loadingTokens = ref(false)
const tokens = ref<McpTokenItem[]>([])
const generated = ref<{
  tokenId?: string
  token: string
  mcpUrl: string
  expiresInDays: number
  codexToml: string
} | null>(null)

async function loadTokens() {
  loadingTokens.value = true
  try {
    const res = await apiFetch<{ items?: McpTokenItem[] }>('/v1/auth/mcp-tokens')
    tokens.value = res.items ?? []
  } catch {
    tokens.value = []
  } finally {
    loadingTokens.value = false
  }
}

async function generateToken() {
  generating.value = true
  try {
    generated.value = await apiFetch('/v1/auth/mcp-token', {
      method: 'POST',
      body: JSON.stringify({ label: label.value.trim() || 'codex-mcp', expiresInDays: expiresInDays.value })
    })
    await loadTokens()
    notify('Token MCP gerado', 'Copie o bloco TOML ou o Bearer Token para conectar no Codex.', 'success')
  } catch (err) {
    notify('Erro ao gerar token', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    generating.value = false
  }
}

async function revokeToken(tokenId: string) {
  try {
    await apiFetch(`/v1/auth/mcp-tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' })
    await loadTokens()
    notify('Token revogado', 'O cliente MCP não poderá mais usar este token.', 'warning')
  } catch (err) {
    notify('Erro ao revogar', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function deleteToken(tokenId: string) {
  try {
    await apiFetch(`/v1/auth/mcp-tokens/${encodeURIComponent(tokenId)}?permanent=true`, { method: 'DELETE' })
    await loadTokens()
    notify('Token apagado', 'Registro removido definitivamente.', 'success')
  } catch (err) {
    notify('Erro ao apagar', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function clearRevokedTokens() {
  try {
    const res = await apiFetch<{ deletedCount: number }>('/v1/auth/mcp-tokens/revoked', { method: 'DELETE' })
    await loadTokens()
    notify('Revogados apagados', `${res.deletedCount} registro(s) removido(s).`, 'success')
  } catch (err) {
    notify('Erro ao limpar', err instanceof Error ? err.message : String(err), 'error')
  }
}

const tokenFilter = ref<'all' | 'active' | 'revoked'>('all')
const isTokenExpired = (t: McpTokenItem) => Date.parse(t.expiresAt) <= Date.now()
const isTokenActive = (t: McpTokenItem) => !t.revokedAt && !isTokenExpired(t)
const resolveLoginType = (t: McpTokenItem) => {
  const txt = `${t.label} ${t.clientName} ${t.clientId}`.toLowerCase()
  if (txt.includes('oauth') || txt.includes('pkce') || txt.includes('codex')) return 'OAuth 2.1 PKCE'
  if (txt.includes('cli') || txt.includes('stdio')) return 'CLI / Stdio'
  return 'Bearer Token'
}
const filteredTokens = computed(() =>
  tokens.value.filter((t) => {
    if (tokenFilter.value === 'active') return isTokenActive(t)
    if (tokenFilter.value === 'revoked') return !isTokenActive(t)
    return true
  })
)
const hasRevokedTokens = computed(() => tokens.value.some(t => !isTokenActive(t)))

async function copyText(text: string, title: string) {
  await navigator.clipboard.writeText(text)
  notify(title, 'Conteúdo copiado para a área de transferência.', 'success')
}

watch(open, (isOpen) => {
  if (isOpen) loadTokens()
})
</script>

<template>
  <UModal v-model:open="open" title="Conectar Codex / MCP & Tokens Ativos" description="Gere Bearer Tokens ou gerencie clientes OAuth 2.1 conectados ao PostgreSQL.">
    <template #body>
      <div class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <UFormField label="Nome do Cliente">
            <UInput v-model="label" placeholder="codex-mcp" class="w-full" />
          </UFormField>
          <UFormField label="Validade (dias)">
            <UInput v-model.number="expiresInDays" type="number" :min="1" :max="365" class="w-full" />
          </UFormField>
        </div>

        <UButton color="primary" icon="i-lucide-key-round" :loading="generating" block @click="generateToken">
          Gerar Bearer Token MCP
        </UButton>

        <div v-if="generated" class="space-y-3 pt-2 border-t border-default">
          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-medium text-highlighted">Endpoint Streamable HTTP</span>
              <UButton size="xs" variant="ghost" icon="i-lucide-copy" @click="copyText(generated.mcpUrl, 'URL copiada')">
                Copiar URL
              </UButton>
            </div>
            <code class="block rounded-lg bg-elevated px-3 py-2 text-xs font-mono text-primary break-all">{{ generated.mcpUrl }}</code>
          </div>

          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-medium text-highlighted">Bearer Token ({{ generated.expiresInDays }}d)</span>
              <UButton size="xs" variant="ghost" icon="i-lucide-copy" @click="copyText(generated.token, 'Token copiado')">
                Copiar Token
              </UButton>
            </div>
            <textarea
              readonly
              rows="2"
              :value="generated.token"
              class="w-full rounded-lg border border-default bg-elevated px-3 py-2 text-xs font-mono text-default"
            />
          </div>

          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-medium text-highlighted">Configuração Codex (~/.codex/config.toml)</span>
              <UButton size="xs" variant="ghost" icon="i-lucide-copy" @click="copyText(generated.codexToml, 'TOML copiado')">
                Copiar TOML
              </UButton>
            </div>
            <pre class="rounded-lg border border-default bg-elevated p-3 text-[11px] font-mono text-default overflow-x-auto whitespace-pre-wrap">{{ generated.codexToml }}</pre>
          </div>
        </div>

        <div class="pt-3 border-t border-default space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs font-semibold text-highlighted">Clientes &amp; Tokens Conectados ({{ tokens.length }})</span>
            <div class="flex items-center gap-1.5">
              <USelect
                v-model="tokenFilter"
                :items="[
                  { label: 'Todos', value: 'all' },
                  { label: 'Ativos', value: 'active' },
                  { label: 'Revogados / Expirados', value: 'revoked' }
                ]"
                size="xs"
                class="w-36"
              />
              <UButton v-if="hasRevokedTokens" size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" @click="clearRevokedTokens">
                Limpar
              </UButton>
              <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" :loading="loadingTokens" @click="loadTokens" />
            </div>
          </div>
          <div v-if="filteredTokens.length === 0" class="text-xs text-muted py-2">Nenhum token encontrado para este filtro.</div>
          <div v-else class="space-y-1.5 max-h-56 overflow-y-auto">
            <div
              v-for="item in filteredTokens"
              :key="item.id"
              class="flex items-center justify-between gap-2 rounded-lg border border-default bg-elevated/40 px-3 py-2 text-xs"
            >
              <div class="min-w-0 space-y-0.5">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="font-medium text-highlighted truncate">{{ item.label }}</span>
                  <UBadge size="xs" color="info" variant="subtle">{{ resolveLoginType(item) }}</UBadge>
                  <UBadge v-if="item.revokedAt" color="error" variant="subtle" size="xs">Revogado</UBadge>
                  <UBadge v-else-if="isTokenExpired(item)" color="warning" variant="subtle" size="xs">Expirado</UBadge>
                  <UBadge v-else color="success" variant="subtle" size="xs">Ativo</UBadge>
                </div>
                <div class="text-[11px] text-muted">
                  {{ item.clientName }} • {{ item.lastUsedAt ? `Último uso: ${new Date(item.lastUsedAt).toLocaleString()}` : 'Nunca usado' }}
                </div>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <UButton v-if="isTokenActive(item)" size="xs" color="error" variant="soft" @click="revokeToken(item.id)">Revogar</UButton>
                <UButton v-else size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" @click="deleteToken(item.id)">Apagar</UButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
