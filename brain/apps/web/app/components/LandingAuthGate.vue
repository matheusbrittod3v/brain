<script setup lang="ts">
import { z } from 'zod'

const {
  authConfig,
  apiFetch,
  notify,
  refreshAuthSession,
  setSessionToken
} = useBrainApi()

const emit = defineEmits<{
  authenticated: []
}>()

onMounted(() => {
  refreshAuthSession()
})

const activeTab = ref<'login' | 'register'>('login')
const showLoginPassword = ref(false)
const showRegisterPassword = ref(false)

const tabs = computed(() => {
  const list: Array<{ label: string; value: 'login' | 'register'; icon: string }> = [
    { label: 'Entrar', value: 'login', icon: 'i-lucide-lock' }
  ]
  if (authConfig.value.registrationEnabled) {
    list.push({ label: 'Criar Conta', value: 'register', icon: 'i-lucide-user-plus' })
  }
  return list
})

watch(
  () => authConfig.value.registrationEnabled,
  (enabled) => {
    if (!enabled && activeTab.value === 'register') {
      activeTab.value = 'login'
    }
  }
)

// Login Form
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
    try {
      await refreshAuthSession()
    } catch {
      // Session already set in memory
    }
    notify(`Bem-vindo, ${res.user.name}!`)
    emit('authenticated')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    notify('Falha na autenticação', msg, 'error')
  } finally {
    loginLoading.value = false
  }
}

function quickFill(email: string, pass: string) {
  loginState.email = email
  loginState.password = pass
  onLogin()
}

// Register Form
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
      emit('authenticated')
    }
  } catch (err) {
    notify('Erro ao criar conta', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    registerLoading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex flex-col justify-between bg-slate-950 text-slate-50 relative overflow-hidden">
    <!-- Subtle Grid & Ambient Glow -->
    <div
      class="pointer-events-none absolute inset-0 opacity-[0.04]"
      style="background-image: linear-gradient(to right, #94a3b8 1px, transparent 1px), linear-gradient(to bottom, #94a3b8 1px, transparent 1px); background-size: 40px 40px;"
    />
    <div class="pointer-events-none absolute -top-40 -left-40 w-[560px] h-[560px] rounded-full bg-indigo-600/20 blur-3xl" />
    <div class="pointer-events-none absolute -bottom-40 -right-40 w-[520px] h-[520px] rounded-full bg-sky-500/15 blur-3xl" />

    <!-- Top Nav -->
    <header class="relative z-10 max-w-6xl w-full mx-auto px-6 py-5 flex items-center justify-between">
      <div class="flex items-center gap-2.5">
        <div class="w-9 h-9 rounded-xl bg-indigo-500/20 border border-indigo-400/40 flex items-center justify-center shadow-lg shadow-indigo-500/10">
          <UIcon name="i-lucide-brain-circuit" class="w-5 h-5 text-indigo-400" />
        </div>
        <span class="font-bold text-lg tracking-tight">Brain</span>
        <UBadge color="primary" variant="subtle" size="xs">Brain OS 2.0</UBadge>
      </div>

      <div class="flex items-center gap-3">
        <span class="hidden sm:inline-flex items-center gap-1.5 text-xs text-slate-400 bg-slate-900/80 border border-slate-800 px-3 py-1.5 rounded-full">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          Better Auth + Argon2id + CASL
        </span>
        <UButton
          v-if="authConfig.registrationEnabled && activeTab !== 'register'"
          size="sm"
          variant="soft"
          color="primary"
          icon="i-lucide-user-plus"
          @click="activeTab = 'register'"
        >
          Criar Conta
        </UButton>
        <UButton
          v-else-if="activeTab !== 'login'"
          size="sm"
          variant="soft"
          color="neutral"
          icon="i-lucide-log-in"
          @click="activeTab = 'login'"
        >
          Entrar
        </UButton>
      </div>
    </header>

    <!-- Main Hero + Auth Card -->
    <main class="relative z-10 max-w-6xl w-full mx-auto px-6 py-8 lg:py-12 grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
      <!-- Left: Landing Hero -->
      <div class="lg:col-span-7 space-y-6">
        <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 text-xs font-medium">
          <UIcon name="i-lucide-sparkles" class="w-3.5 h-3.5" />
          Engenharia Guiada por Conhecimento &amp; FinOps
        </div>

        <h1 class="text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.08] bg-gradient-to-br from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
          O Cérebro Corporativo para Times &amp; Agentes Autônomos.
        </h1>

        <p class="text-base text-slate-400 max-w-xl leading-relaxed">
          Centralize regras de negócio, ADRs, grafo de dependências e análise de impacto com isolamento multi-projeto, controle de acesso CASL e governança financeira em tempo real.
        </p>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
          <div class="p-4 rounded-xl border border-slate-800/90 bg-slate-900/60 backdrop-blur hover:border-emerald-500/40 transition-colors">
            <UIcon name="i-lucide-shield-check" class="w-5 h-5 text-emerald-400 mb-2.5" />
            <div class="font-semibold text-sm text-slate-100">Acesso Zero-Trust</div>
            <p class="text-xs text-slate-400 mt-1 leading-relaxed">RLS no PostgreSQL, CASL RBAC e OAuth2 Device Flow para MCP.</p>
          </div>

          <div class="p-4 rounded-xl border border-slate-800/90 bg-slate-900/60 backdrop-blur hover:border-indigo-500/40 transition-colors">
            <UIcon name="i-lucide-network" class="w-5 h-5 text-indigo-400 mb-2.5" />
            <div class="font-semibold text-sm text-slate-100">Grafo &amp; Impacto</div>
            <p class="text-xs text-slate-400 mt-1 leading-relaxed">Busca vetorial HNSW, AST Tree-sitter e blast radius antes do deploy.</p>
          </div>

          <div class="p-4 rounded-xl border border-slate-800/90 bg-slate-900/60 backdrop-blur hover:border-sky-500/40 transition-colors">
            <UIcon name="i-lucide-zap" class="w-5 h-5 text-sky-400 mb-2.5" />
            <div class="font-semibold text-sm text-slate-100">FinOps &amp; Downgrade</div>
            <p class="text-xs text-slate-400 mt-1 leading-relaxed">Cotas por área com fallback automático para Ollama local.</p>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 pt-2 text-[11px] text-slate-400">
          <span class="px-2.5 py-1 rounded-md bg-slate-900/80 border border-slate-800 font-mono">Bun + Fastify</span>
          <span class="px-2.5 py-1 rounded-md bg-slate-900/80 border border-slate-800 font-mono">PostgreSQL + pgvector HNSW</span>
          <span class="px-2.5 py-1 rounded-md bg-slate-900/80 border border-slate-800 font-mono">MCP Streamable HTTP</span>
          <span class="px-2.5 py-1 rounded-md bg-slate-900/80 border border-slate-800 font-mono">Arcjet WAF</span>
        </div>
      </div>

      <!-- Right: Auth Card -->
      <div class="lg:col-span-5">
        <UCard class="border-slate-800/90 bg-slate-900/85 backdrop-blur-xl shadow-2xl shadow-indigo-950/30">
          <template #header>
            <div class="space-y-1">
              <div class="flex items-center justify-between">
                <h2 class="text-lg font-bold text-white">
                  {{ activeTab === 'login' ? 'Entrar no Command Center' : 'Criar sua Conta' }}
                </h2>
                <UIcon
                  :name="activeTab === 'login' ? 'i-lucide-lock' : 'i-lucide-user-plus'"
                  class="w-5 h-5 text-indigo-400"
                />
              </div>
              <p class="text-xs text-slate-400">
                {{
                  activeTab === 'login'
                    ? 'Autentique-se com seu email e senha para desbloquear os workspaces.'
                    : 'Cadastre-se para acessar projetos, grafo de conhecimento e aprovações.'
                }}
              </p>
            </div>
          </template>

          <div class="space-y-5">
            <!-- Deterministic Segmented Switcher -->
            <div
              v-if="tabs.length > 1"
              role="tablist"
              aria-label="Modo de autenticação"
              class="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-950/90 border border-slate-800"
            >
              <button
                v-for="tab in tabs"
                :key="tab.value"
                type="button"
                role="tab"
                :aria-selected="activeTab === tab.value"
                class="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all cursor-pointer"
                :class="
                  activeTab === tab.value
                    ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                "
                @click="activeTab = tab.value"
              >
                <UIcon :name="tab.icon" class="w-4 h-4" />
                <span>{{ tab.label }}</span>
              </button>
            </div>

            <!-- LOGIN -->
            <UForm
              v-if="activeTab === 'login'"
              :schema="loginSchema"
              :state="loginState"
              class="space-y-4"
              @submit="onLogin"
            >
              <UFormField label="Email" name="email">
                <UInput
                  v-model="loginState.email"
                  type="email"
                  placeholder="voce@empresa.com"
                  icon="i-lucide-mail"
                  class="w-full"
                  size="md"
                  autocomplete="email"
                />
              </UFormField>

              <UFormField label="Senha" name="password">
                <UInput
                  v-model="loginState.password"
                  :type="showLoginPassword ? 'text' : 'password'"
                  placeholder="••••••••"
                  icon="i-lucide-lock"
                  class="w-full"
                  size="md"
                  autocomplete="current-password"
                >
                  <template #trailing>
                    <UButton
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      :icon="showLoginPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                      :aria-label="showLoginPassword ? 'Ocultar senha' : 'Mostrar senha'"
                      @click="showLoginPassword = !showLoginPassword"
                    />
                  </template>
                </UInput>
              </UFormField>

              <UButton type="submit" block size="md" :loading="loginLoading" icon="i-lucide-log-in">
                Entrar no Brain
              </UButton>

              <div class="pt-3 border-t border-slate-800/80 space-y-2">
                <div class="text-[11px] text-slate-400 font-medium text-center">
                  Acesso Rápido / Demonstração:
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <UButton
                    type="button"
                    size="xs"
                    variant="soft"
                    color="primary"
                    icon="i-lucide-shield-check"
                    class="justify-center truncate"
                    :loading="loginLoading"
                    @click="quickFill('test@gmail.com', '123456')"
                  >
                    Britto (Admin)
                  </UButton>
                  <UButton
                    type="button"
                    size="xs"
                    variant="soft"
                    color="neutral"
                    icon="i-lucide-user"
                    class="justify-center truncate"
                    :loading="loginLoading"
                    @click="quickFill('admin@brain.local', 'adminpassword123')"
                  >
                    Admin Local
                  </UButton>
                </div>
              </div>

              <p v-if="authConfig.registrationEnabled" class="text-center text-xs text-slate-400 pt-1">
                Ainda não possui acesso?
                <button
                  type="button"
                  class="text-indigo-400 hover:text-indigo-300 font-medium underline underline-offset-2 cursor-pointer"
                  @click="activeTab = 'register'"
                >
                  Criar conta agora
                </button>
              </p>
            </UForm>

            <!-- REGISTER -->
            <div v-else-if="activeTab === 'register' && authConfig.registrationEnabled">
              <UAlert
                v-if="verificationSentEmail"
                color="success"
                variant="subtle"
                icon="i-lucide-mail-check"
                title="Verifique seu Email"
                :description="`Enviamos um link de ativação para ${verificationSentEmail}.`"
              />
              <UForm
                v-else
                :schema="registerSchema"
                :state="registerState"
                class="space-y-4"
                @submit="onRegister"
              >
                <UFormField label="Nome Completo" name="name">
                  <UInput
                    v-model="registerState.name"
                    placeholder="Seu Nome"
                    icon="i-lucide-user"
                    class="w-full"
                    size="md"
                    autocomplete="name"
                  />
                </UFormField>

                <UFormField label="Email" name="email">
                  <UInput
                    v-model="registerState.email"
                    type="email"
                    placeholder="voce@empresa.com"
                    icon="i-lucide-mail"
                    class="w-full"
                    size="md"
                    autocomplete="email"
                  />
                </UFormField>

                <UFormField label="Senha" name="password">
                  <UInput
                    v-model="registerState.password"
                    :type="showRegisterPassword ? 'text' : 'password'"
                    placeholder="Mínimo 6 caracteres"
                    icon="i-lucide-lock"
                    class="w-full"
                    size="md"
                    autocomplete="new-password"
                  >
                    <template #trailing>
                      <UButton
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        :icon="showRegisterPassword ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                        :aria-label="showRegisterPassword ? 'Ocultar senha' : 'Mostrar senha'"
                        @click="showRegisterPassword = !showRegisterPassword"
                      />
                    </template>
                  </UInput>
                </UFormField>

                <UButton type="submit" block size="md" :loading="registerLoading" icon="i-lucide-user-plus">
                  Criar Conta
                </UButton>

                <p class="text-center text-xs text-slate-400 pt-1">
                  Já possui conta?
                  <button
                    type="button"
                    class="text-indigo-400 hover:text-indigo-300 font-medium underline underline-offset-2 cursor-pointer"
                    @click="activeTab = 'login'"
                  >
                    Entrar com email e senha
                  </button>
                </p>
              </UForm>
            </div>
          </div>

          <template #footer>
            <div class="flex items-center justify-between text-[11px] text-slate-500">
              <span>Login web exclusivo via usuário (CLI/MCP usam OAuth2)</span>
              <span v-if="!authConfig.registrationEnabled" class="text-amber-400/90">Cadastro restrito</span>
            </div>
          </template>
        </UCard>
      </div>
    </main>

    <!-- Footer -->
    <footer class="relative z-10 max-w-6xl w-full mx-auto px-6 py-4 border-t border-slate-900 flex flex-wrap gap-2 items-center justify-between text-xs text-slate-500">
      <span>Brain Project Brain OS · Bun + Nuxt UI</span>
      <span>Isolamento RLS &amp; Conformidade LGPD</span>
    </footer>
  </div>
</template>
