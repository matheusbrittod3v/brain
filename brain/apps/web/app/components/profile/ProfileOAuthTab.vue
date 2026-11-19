<script setup lang="ts">
const { apiFetch, apiUrl, notify } = useBrainApi()

interface PendingSessionItem {
  userCode: string
  clientId: string
  clientName: string
  scope: string
  status: string
  expiresAt: string
}

const pendingList = ref<PendingSessionItem[]>([])
const loadingPending = ref(false)
const decidingCode = ref<string | null>(null)

const codexAutoToml = computed(() => `[mcp_servers.brain]\nurl = "${apiUrl.value.replace(/\/+$/, '')}/mcp"`)

async function loadPending() {
  loadingPending.value = true
  try {
    const res = await apiFetch<{ items?: PendingSessionItem[] }>('/v1/auth/oauth/pending')
    pendingList.value = res.items ?? []
  } catch {
    pendingList.value = []
  } finally {
    loadingPending.value = false
  }
}

async function decide(item: PendingSessionItem, approve: boolean) {
  decidingCode.value = item.userCode
  try {
    const endpoint = approve ? '/v1/auth/oauth/approve' : '/v1/auth/oauth/reject'
    await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ userCode: item.userCode })
    })
    notify(
      approve ? 'Cliente Autorizado' : 'Autorização Rejeitada',
      approve ? `Acesso concedido para ${item.clientName}.` : 'Solicitação cancelada.',
      approve ? 'success' : 'warning'
    )
    await loadPending()
  } catch (err) {
    notify('Erro na autorização', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    decidingCode.value = null
  }
}

async function copySnippet() {
  await navigator.clipboard.writeText(codexAutoToml.value)
  notify('Copiado', 'Bloco TOML copiado para a área de transferência.', 'success')
}

let pollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  loadPending()
  pollTimer = setInterval(loadPending, 5000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
    <UCard class="border border-default">
      <template #header>
        <div class="flex items-center gap-2 text-sm font-semibold text-highlighted">
          <UIcon name="i-lucide-sparkles" class="w-4 h-4 text-primary" />
          <span>Login Automático 1-Clique (OAuth 2.1 PKCE)</span>
        </div>
      </template>

      <div class="space-y-3 text-xs text-muted">
        <p>
          Sem códigos manuais nem <code class="font-mono">.env</code>: Codex, Cursor e <code class="font-mono">brain-mcp login</code> abrem o navegador direto para você clicar em <strong>Aprovar</strong> e conectam automaticamente.
        </p>
        <div class="flex items-center justify-between pt-1">
          <span class="font-medium text-highlighted">Configuração mínima (~/.codex/config.toml)</span>
          <UButton size="xs" variant="ghost" icon="i-lucide-copy" @click="copySnippet">Copiar</UButton>
        </div>
        <pre class="rounded-lg border border-default bg-elevated p-3 text-[11px] font-mono text-default overflow-x-auto">{{ codexAutoToml }}</pre>
        <div class="rounded-lg border border-default bg-elevated/40 p-2.5 font-mono text-[11px] text-default">
          CLI stdio: brain-mcp login
        </div>
      </div>
    </UCard>

    <UCard class="border border-default">
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-sm font-semibold text-highlighted">
            <UIcon name="i-lucide-shield-check" class="w-4 h-4 text-primary" />
            <span>Solicitações de Conexão Pendentes</span>
          </div>
          <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" :loading="loadingPending" @click="loadPending" />
        </div>
      </template>

      <div v-if="pendingList.length === 0" class="text-xs text-muted py-6 text-center">
        Nenhuma solicitação pendente no momento. Quando um agente pedir acesso, ela aparecerá aqui automaticamente para aprovação em 1 clique.
      </div>
      <div v-else class="space-y-2.5">
        <div
          v-for="item in pendingList"
          :key="item.userCode"
          class="rounded-xl border border-primary/40 bg-elevated/40 p-3.5 space-y-2.5"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <div class="text-sm font-semibold text-highlighted truncate">{{ item.clientName }}</div>
              <div class="text-[11px] text-muted font-mono truncate">{{ item.clientId }} • {{ item.scope }}</div>
            </div>
            <UBadge color="warning" variant="subtle" size="xs">Aguardando</UBadge>
          </div>
          <div class="flex justify-end gap-2">
            <UButton size="xs" color="neutral" variant="outline" :loading="decidingCode === item.userCode" @click="decide(item, false)">
              Rejeitar
            </UButton>
            <UButton size="xs" color="primary" icon="i-lucide-check" :loading="decidingCode === item.userCode" @click="decide(item, true)">
              Aprovar Acesso
            </UButton>
          </div>
        </div>
      </div>
    </UCard>
  </div>
</template>
