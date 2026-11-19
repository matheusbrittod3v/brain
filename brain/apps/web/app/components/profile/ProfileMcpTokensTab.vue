<script setup lang="ts">
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

async function copyText(text: string, title: string) {
  await navigator.clipboard.writeText(text)
  notify(title, 'Conteúdo copiado para a área de transferência.', 'success')
}

onMounted(loadTokens)
</script>

<template>
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
    <UCard class="border border-default">
      <template #header>
        <div class="flex items-center gap-2 text-sm font-semibold text-highlighted">
          <UIcon name="i-lucide-key-round" class="w-4 h-4 text-primary" />
          <span>Gerar Bearer Token MCP</span>
        </div>
      </template>

      <div class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <UFormField label="Nome do Cliente">
            <UInput v-model="label" placeholder="codex-mcp" class="w-full" />
          </UFormField>
          <UFormField label="Validade (dias)">
            <UInput v-model.number="expiresInDays" type="number" :min="1" :max="365" class="w-full" />
          </UFormField>
        </div>

        <UButton color="primary" icon="i-lucide-plus" :loading="generating" block @click="generateToken">
          Gerar Novo Token
        </UButton>

        <div v-if="generated" class="space-y-3 pt-2 border-t border-default">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-highlighted">Configuração Codex (~/.codex/config.toml)</span>
            <UButton size="xs" variant="ghost" icon="i-lucide-copy" @click="copyText(generated.codexToml, 'TOML copiado')">
              Copiar TOML
            </UButton>
          </div>
          <pre class="rounded-lg border border-default bg-elevated p-3 text-[11px] font-mono text-default overflow-x-auto whitespace-pre-wrap">{{ generated.codexToml }}</pre>
        </div>
      </div>
    </UCard>

    <UCard class="border border-default">
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-sm font-semibold text-highlighted">
            <UIcon name="i-lucide-laptop" class="w-4 h-4 text-primary" />
            <span>Clientes &amp; Tokens Conectados</span>
          </div>
          <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" :loading="loadingTokens" @click="loadTokens" />
        </div>
      </template>

      <div v-if="tokens.length === 0" class="text-xs text-muted py-4 text-center">
        Nenhum token MCP emitido ainda.
      </div>
      <div v-else class="space-y-2 max-h-80 overflow-y-auto">
        <div
          v-for="item in tokens"
          :key="item.id"
          class="flex items-center justify-between gap-2 rounded-lg border border-default bg-elevated/40 px-3 py-2.5 text-xs"
        >
          <div class="min-w-0">
            <div class="font-medium text-highlighted truncate">{{ item.label }}</div>
            <div class="text-[11px] text-muted">
              {{ item.lastUsedAt ? `Último uso: ${new Date(item.lastUsedAt).toLocaleString()}` : 'Nunca usado' }}
              • Expira em {{ new Date(item.expiresAt).toLocaleDateString() }}
            </div>
          </div>
          <UBadge v-if="item.revokedAt" color="neutral" size="xs">Revogado</UBadge>
          <UButton v-else size="xs" color="error" variant="soft" @click="revokeToken(item.id)">Revogar</UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>
