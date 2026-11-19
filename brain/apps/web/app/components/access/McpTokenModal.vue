<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })
const { apiFetch, notify } = useBrainApi()

const label = ref('codex-mcp')
const expiresInDays = ref(90)
const generating = ref(false)
const generated = ref<{
  token: string
  mcpUrl: string
  expiresInDays: number
  codexToml: string
} | null>(null)

async function generateToken() {
  generating.value = true
  try {
    generated.value = await apiFetch<{
      token: string
      mcpUrl: string
      expiresInDays: number
      codexToml: string
    }>('/v1/auth/mcp-token', {
      method: 'POST',
      body: JSON.stringify({ label: label.value.trim() || 'codex-mcp', expiresInDays: expiresInDays.value })
    })
    notify('Token MCP gerado', 'Copie o bloco TOML ou o Bearer Token para conectar no Codex.', 'success')
  } catch (err) {
    notify('Erro ao gerar token', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    generating.value = false
  }
}

async function copyText(text: string, title: string) {
  await navigator.clipboard.writeText(text)
  notify(title, 'Conteúdo copiado para a área de transferência.', 'success')
}
</script>

<template>
  <UModal v-model:open="open" title="Conectar Codex / MCP via HTTP (sem .env)" description="Gere um Bearer Token pessoal com escopo dinâmico automático direto do PostgreSQL.">
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
      </div>
    </template>
  </UModal>
</template>
