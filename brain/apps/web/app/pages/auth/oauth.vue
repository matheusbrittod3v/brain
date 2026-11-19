<script setup lang="ts">
const route = useRoute()
const { apiFetch, apiKey, currentUser, setSessionToken, refreshAuthSession, notify } = useBrainApi()

const userCode = ref(String(route.query.code ?? '').trim().toUpperCase())
const session = ref<{
  userCode: string
  clientId: string
  clientName: string
  scope: string
  status: string
  expiresAt: string | number
} | null>(null)
const loadingSession = ref(false)
const submitting = ref(false)
const doneMessage = ref<string | null>(null)
const errorMessage = ref<string | null>(null)

const email = ref('')
const password = ref('')
const loggingIn = ref(false)

async function loadSession() {
  const code = userCode.value.trim().toUpperCase()
  if (!code) return
  loadingSession.value = true
  errorMessage.value = null
  try {
    session.value = await apiFetch(`/v1/auth/oauth/session/${encodeURIComponent(code)}`)
  } catch (err) {
    session.value = null
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    loadingSession.value = false
  }
}

async function handleLogin() {
  loggingIn.value = true
  errorMessage.value = null
  try {
    const res = await apiFetch<{ token: string; user: { id: string; email: string; name: string; tenantId: string; roles: string[] } }>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: email.value, password: password.value })
    })
    setSessionToken(res.token)
    await refreshAuthSession()
    notify('Autenticado', `Bem-vindo, ${res.user.name}`, 'success')
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    loggingIn.value = false
  }
}

async function decide(approve: boolean) {
  submitting.value = true
  errorMessage.value = null
  try {
    const endpoint = approve ? '/v1/auth/oauth/approve' : '/v1/auth/oauth/reject'
    const res = await apiFetch<{ status: string; message?: string }>(endpoint, {
      method: 'POST',
      body: JSON.stringify({ userCode: userCode.value.trim().toUpperCase() })
    })
    doneMessage.value = res.message || (approve ? 'Conexão MCP autorizada! Você já pode voltar ao terminal/Codex.' : 'Solicitação rejeitada.')
    await loadSession()
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  if (userCode.value) loadSession()
})
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-default p-6">
    <UCard class="w-full max-w-md border border-default">
      <template #header>
        <div class="flex items-center gap-2.5">
          <UIcon name="i-lucide-shield-check" class="w-5 h-5 text-primary" />
          <div>
            <h1 class="text-base font-semibold text-highlighted">Autorizar Cliente MCP / CLI</h1>
            <p class="text-xs text-muted">OAuth2 Device Flow — Brain</p>
          </div>
        </div>
      </template>

      <div class="space-y-4">
        <div class="flex gap-2">
          <UInput v-model="userCode" placeholder="ABCD-1234" class="flex-1 font-mono uppercase" @keyup.enter="loadSession" />
          <UButton variant="soft" :loading="loadingSession" @click="loadSession">Verificar</UButton>
        </div>

        <UAlert v-if="errorMessage" color="error" variant="subtle" :description="errorMessage" />
        <UAlert v-if="doneMessage" color="success" variant="subtle" icon="i-lucide-check-circle-2" :description="doneMessage" />

        <div v-if="session" class="rounded-lg border border-default bg-elevated/40 p-3.5 space-y-1.5 text-xs">
          <div class="flex justify-between">
            <span class="text-muted">Cliente:</span>
            <span class="font-medium text-highlighted">{{ session.clientName }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted">Escopo:</span>
            <span class="font-mono text-default">{{ session.scope }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-muted">Status:</span>
            <UBadge :color="session.status === 'approved' ? 'success' : session.status === 'pending' ? 'warning' : 'neutral'" size="xs">
              {{ session.status }}
            </UBadge>
          </div>
        </div>

        <div v-if="!apiKey" class="space-y-3 pt-2 border-t border-default">
          <p class="text-xs text-muted">Faça login para aprovar esta conexão:</p>
          <UInput v-model="email" type="email" placeholder="seu@email.com" class="w-full" />
          <UInput v-model="password" type="password" placeholder="Senha" class="w-full" @keyup.enter="handleLogin" />
          <UButton color="primary" block :loading="loggingIn" @click="handleLogin">Entrar</UButton>
        </div>

        <div v-else-if="session && session.status === 'pending'" class="space-y-2 pt-2 border-t border-default">
          <p class="text-xs text-muted">
            Conectado como <strong class="text-highlighted">{{ currentUser?.email ?? currentUser?.name }}</strong>.
          </p>
          <div class="grid grid-cols-2 gap-2">
            <UButton color="neutral" variant="outline" :loading="submitting" @click="decide(false)">Rejeitar</UButton>
            <UButton color="primary" icon="i-lucide-check" :loading="submitting" @click="decide(true)">Aprovar</UButton>
          </div>
        </div>
      </div>
    </UCard>
  </div>
</template>
