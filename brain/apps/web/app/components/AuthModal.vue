<script setup lang="ts">
import { z } from 'zod'

const {
  currentUser,
  authConfig,
  authModalOpen,
  authModalTab,
  apiFetch,
  notify,
  refreshAuthSession,
  setSessionToken,
  logout
} = useBrainApi()

const emit = defineEmits<{
  authenticated: []
}>()

const tabs = computed(() => {
  const list: Array<{ label: string; value: 'login' | 'register'; icon: string }> = [
    { label: 'Entrar', value: 'login', icon: 'i-lucide-lock' }
  ]
  if (authConfig.value.registrationEnabled) {
    list.push({ label: 'Criar Conta', value: 'register', icon: 'i-lucide-user-plus' })
  }
  return list
})

// Login Schema & State
const loginSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z.string().min(1, 'Senha obrigatória')
})
const loginState = reactive({ email: '', password: '' })
const loginLoading = ref(false)

async function onLogin() {
  loginLoading.value = true
  try {
    const res = await apiFetch<{ token: string; user: { id: string; email: string; name: string; roles: string[] } }>(
      '/v1/auth/login',
      { method: 'POST', body: JSON.stringify(loginState) }
    )
    setSessionToken(res.token, res.user)
    await refreshAuthSession()
    notify(`Bem-vindo, ${res.user.name}!`)
    authModalOpen.value = false
    emit('authenticated')
  } catch (err) {
    notify('Erro no login', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loginLoading.value = false
  }
}

// Register Schema & State
const registerSchema = z.object({
  name: z.string().min(2, 'Mínimo 2 caracteres'),
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Mínimo 6 caracteres')
})
const registerState = reactive({ name: '', email: '', password: '' })
const registerLoading = ref(false)
const verificationSentEmail = ref<string | null>(null)

async function onRegister() {
  registerLoading.value = true
  try {
    const res = await apiFetch<{ status?: string; token?: string; user?: { id: string; email: string; name: string; roles: string[] } }>(
      '/v1/auth/register',
      { method: 'POST', body: JSON.stringify(registerState) }
    )
    if (res.status === 'pending_verification') {
      verificationSentEmail.value = registerState.email
      notify('Confirmação enviada', 'Verifique seu email para ativar a conta.')
    } else if (res.token && res.user) {
      setSessionToken(res.token, res.user)
      await refreshAuthSession()
      notify(`Conta criada! Bem-vindo, ${res.user.name}`)
      authModalOpen.value = false
      emit('authenticated')
    }
  } catch (err) {
    notify('Erro ao criar conta', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    registerLoading.value = false
  }
}

// OAuth2 Device Flow State
const userCode = ref('')
const pendingOAuth = ref<{ userCode: string; clientId: string; clientName: string; scope: string } | null>(null)
const checkingOAuth = ref(false)
const approvingOAuth = ref(false)

async function checkOAuthCode() {
  const code = userCode.value.trim().toUpperCase()
  if (!code) return
  checkingOAuth.value = true
  try {
    pendingOAuth.value = await apiFetch(`/v1/auth/oauth/session/${encodeURIComponent(code)}`)
  } catch (err) {
    pendingOAuth.value = null
    notify('Código inválido ou expirado', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    checkingOAuth.value = false
  }
}

async function approveOAuth() {
  if (!pendingOAuth.value) return
  approvingOAuth.value = true
  try {
    await apiFetch('/v1/auth/oauth/approve', {
      method: 'POST',
      body: JSON.stringify({ userCode: pendingOAuth.value.userCode })
    })
    notify('Agente autorizado!', `${pendingOAuth.value.clientName} conectado com suas permissões.`)
    pendingOAuth.value = null
    userCode.value = ''
    authModalOpen.value = false
  } catch (err) {
    notify('Erro ao aprovar', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    approvingOAuth.value = false
  }
}

</script>

<template>
  <USlideover
    v-model:open="authModalOpen"
    title="Autenticação & Acesso Brain"
    description="Gerencie login, registro, permissões e autorizações OAuth2 para Agentes de IA."
  >
    <template #body>
      <div class="space-y-5">
        <!-- Logged-in User Card -->
        <UCard v-if="currentUser" variant="subtle">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-3">
              <UAvatar :alt="currentUser.name || currentUser.email" size="md" color="primary" />
              <div>
                <div class="font-semibold text-sm">{{ currentUser.name }}</div>
                <div class="text-xs text-muted">{{ currentUser.email || 'Sessão Local' }}</div>
                <div class="flex gap-1.5 mt-1.5 flex-wrap">
                  <UBadge v-for="role in currentUser.roles" :key="role" size="xs" color="primary" variant="subtle">
                    {{ role }}
                  </UBadge>
                </div>
              </div>
            </div>
            <UButton color="error" variant="ghost" size="xs" icon="i-lucide-log-out" @click="logout">
              Sair
            </UButton>
          </div>
        </UCard>

        <!-- Tabs (somente quando não autenticado) -->
        <template v-if="!currentUser">
        <div role="tablist" class="flex flex-wrap gap-1.5 p-1 rounded-xl bg-slate-950/90 border border-slate-800">
          <button
            v-for="tab in tabs"
            :key="tab.value"
            type="button"
            role="tab"
            :aria-selected="authModalTab === tab.value"
            class="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer"
            :class="
              authModalTab === tab.value
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
            "
            @click="authModalTab = tab.value"
          >
            <UIcon :name="tab.icon" class="w-4 h-4" />
            <span>{{ tab.label }}</span>
          </button>
        </div>

        <!-- Tab: Login -->
        <UForm v-if="authModalTab === 'login'" :schema="loginSchema" :state="loginState" class="space-y-4" @submit="onLogin">
          <UFormField label="Endereço de Email" name="email">
            <UInput v-model="loginState.email" type="email" placeholder="seu-email@empresa.com" icon="i-lucide-mail" class="w-full" />
          </UFormField>

          <UFormField label="Senha" name="password">
            <UInput v-model="loginState.password" type="password" placeholder="••••••••" icon="i-lucide-lock" class="w-full" />
          </UFormField>

          <div class="flex items-center justify-between pt-2">
            <span class="text-xs text-muted">Argon2id + JWT assinado</span>
            <UButton type="submit" :loading="loginLoading" icon="i-lucide-log-in">
              Entrar
            </UButton>
          </div>
        </UForm>

        <!-- Tab: Register -->
        <div v-else-if="authModalTab === 'register' && authConfig.registrationEnabled">
          <UAlert
            v-if="verificationSentEmail"
            color="success"
            variant="subtle"
            icon="i-lucide-mail-check"
            title="Confirmação Enviada"
            :description="`Enviamos um link de confirmação para ${verificationSentEmail}.`"
          />
          <UForm v-else :schema="registerSchema" :state="registerState" class="space-y-4" @submit="onRegister">
            <UFormField label="Nome Completo" name="name">
              <UInput v-model="registerState.name" placeholder="Seu Nome" icon="i-lucide-user" class="w-full" />
            </UFormField>

            <UFormField label="Email" name="email">
              <UInput v-model="registerState.email" type="email" placeholder="voce@empresa.com" icon="i-lucide-mail" class="w-full" />
            </UFormField>

            <UFormField label="Senha (mín. 6 caracteres)" name="password">
              <UInput v-model="registerState.password" type="password" placeholder="••••••••" icon="i-lucide-lock" class="w-full" />
            </UFormField>

            <div class="flex justify-end pt-2">
              <UButton type="submit" :loading="registerLoading" icon="i-lucide-user-plus">
                Criar Conta
              </UButton>
            </div>
          </UForm>
        </div>
        </template>
      </div>
    </template>
  </USlideover>
</template>

