<script setup lang="ts">
const route = useRoute()
const { apiFetch, apiKey, currentUser, setSessionToken, refreshAuthSession, notify } = useBrainApi()

// OAuth 2.1 PKCE params
const clientId = computed(() => String(route.query.client_id ?? '').trim())
const redirectUri = computed(() => String(route.query.redirect_uri ?? '').trim())
const codeChallenge = computed(() => String(route.query.code_challenge ?? '').trim())
const codeChallengeMethod = computed(() => String(route.query.code_challenge_method ?? 'S256').trim())
const requestedScope = computed(() => String(route.query.scope ?? 'brain').trim())
const oauthState = computed(() => String(route.query.state ?? '').trim())
const isPkceMode = computed(() => Boolean(clientId.value && redirectUri.value && codeChallenge.value))

const clientInfo = ref<{ clientId: string; clientName: string; scope: string } | null>(null)
const availableProjects = ref<Array<{ id: string; name: string }>>([])
const selectedProjects = ref<string[]>([])
const restrictProjects = ref(false)

const loading = ref(false)
const submitting = ref(false)
const doneMessage = ref<string | null>(null)
const errorMessage = ref<string | null>(null)

const email = ref('')
const password = ref('')
const loggingIn = ref(false)

async function loadConsentContext() {
  loading.value = true
  errorMessage.value = null
  try {
    if (isPkceMode.value) {
      clientInfo.value = await apiFetch<{ clientId: string; clientName: string; scope: string }>(
        `/v1/auth/oauth/client/${encodeURIComponent(clientId.value)}`
      ).catch(() => ({ clientId: clientId.value, clientName: clientId.value, scope: requestedScope.value }))
    }

    if (apiKey.value) {
      const res = await apiFetch<{ items?: Array<{ id: string; name: string }> }>('/v1/projects').catch(() => ({ items: [] }))
      availableProjects.value = res.items ?? []
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function handleLogin() {
  loggingIn.value = true
  errorMessage.value = null
  try {
    const res = await apiFetch<{ token: string; user: { id: string; email: string; name: string } }>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: email.value, password: password.value })
    })
    setSessionToken(res.token)
    await refreshAuthSession()
    await loadConsentContext()
    notify('Autenticado', `Bem-vindo, ${res.user.name}`, 'success')
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    loggingIn.value = false
  }
}

async function approvePkce() {
  submitting.value = true
  errorMessage.value = null
  try {
    const res = await apiFetch<{ code: string; redirectTo: string }>('/v1/auth/oauth/authorize', {
      method: 'POST',
      body: JSON.stringify({
        clientId: clientId.value,
        redirectUri: redirectUri.value,
        codeChallenge: codeChallenge.value,
        codeChallengeMethod: codeChallengeMethod.value,
        scope: requestedScope.value,
        allowedProjects: restrictProjects.value ? selectedProjects.value : [],
        state: oauthState.value || undefined
      })
    })
    doneMessage.value = 'Autorizado! Redirecionando para o cliente MCP...'
    window.location.href = res.redirectTo
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    submitting.value = false
  }
}

function rejectPkce() {
  try {
    const target = new URL(redirectUri.value)
    target.searchParams.set('error', 'access_denied')
    if (oauthState.value) target.searchParams.set('state', oauthState.value)
    window.location.href = target.toString()
  } catch {
    doneMessage.value = 'Solicitação cancelada.'
  }
}

function toggleProject(id: string) {
  selectedProjects.value = selectedProjects.value.includes(id)
    ? selectedProjects.value.filter((p) => p !== id)
    : [...selectedProjects.value, id]
}

onMounted(loadConsentContext)
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-default p-6">
    <UCard class="w-full max-w-lg border border-default">
      <template #header>
        <div class="flex items-center gap-2.5">
          <UIcon name="i-lucide-shield-check" class="w-5 h-5 text-primary" />
          <div>
            <h1 class="text-base font-semibold text-highlighted">Autorizar Cliente MCP / CLI</h1>
            <p class="text-xs text-muted">{{ isPkceMode ? 'OAuth 2.1 Automático (PKCE)' : 'Aprovação em 1 Clique — Brain' }}</p>
          </div>
        </div>
      </template>

      <div class="space-y-4">
        <UAlert v-if="errorMessage" color="error" variant="subtle" :description="errorMessage" />
        <UAlert v-if="doneMessage" color="success" variant="subtle" icon="i-lucide-check-circle-2" :description="doneMessage" />

        <div v-if="!apiKey" class="space-y-3">
          <p class="text-xs text-muted">Entre na sua conta para aprovar esta conexão em 1 clique:</p>
          <UInput v-model="email" type="email" placeholder="seu@email.com" class="w-full" />
          <UInput v-model="password" type="password" placeholder="Senha" class="w-full" @keyup.enter="handleLogin" />
          <UButton color="primary" block :loading="loggingIn" @click="handleLogin">Entrar e Continuar</UButton>
        </div>

        <template v-else-if="isPkceMode">
          <div class="rounded-lg border border-default bg-elevated/40 p-3.5 space-y-2 text-xs">
            <div class="flex justify-between">
              <span class="text-muted">Cliente:</span>
              <span class="font-medium text-highlighted">{{ clientInfo?.clientName || clientId }}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted">Permissões:</span>
              <span class="text-default">Centralizadas no usuário (CASL / RBAC)</span>
            </div>
            <div class="flex justify-between gap-2">
              <span class="text-muted shrink-0">Callback:</span>
              <span class="font-mono text-[11px] text-muted truncate">{{ redirectUri }}</span>
            </div>
          </div>

          <div v-if="availableProjects.length > 0" class="rounded-lg border border-default p-3 space-y-2">
            <label class="flex items-center gap-2 text-xs font-medium text-highlighted cursor-pointer">
              <input v-model="restrictProjects" type="checkbox" class="rounded border-default" />
              Restringir acesso a projetos específicos
            </label>
            <div v-if="restrictProjects" class="flex flex-wrap gap-1.5 pt-1">
              <UButton
                v-for="proj in availableProjects"
                :key="proj.id"
                size="xs"
                :variant="selectedProjects.includes(proj.id) ? 'solid' : 'outline'"
                :color="selectedProjects.includes(proj.id) ? 'primary' : 'neutral'"
                @click="toggleProject(proj.id)"
              >
                {{ proj.name || proj.id }}
              </UButton>
            </div>
          </div>

          <p class="text-xs text-muted">
            Conectado como <strong class="text-highlighted">{{ currentUser?.email ?? currentUser?.name }}</strong>.
          </p>
          <div class="grid grid-cols-2 gap-2">
            <UButton color="neutral" variant="outline" :disabled="submitting" @click="rejectPkce">Rejeitar</UButton>
            <UButton color="primary" icon="i-lucide-check" :loading="submitting" @click="approvePkce">Aprovar e Conectar</UButton>
          </div>
        </template>

        <template v-else>
          <div class="text-xs text-muted py-4 text-center">
            Nenhuma solicitação OAuth 2.1 ativa. Conecte pelo Codex ou execute <code class="font-mono">brain-mcp login</code>.
          </div>
        </template>
      </div>
    </UCard>
  </div>
</template>
