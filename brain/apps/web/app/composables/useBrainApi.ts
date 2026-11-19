export interface AuthUserProfile {
  id: string
  email?: string
  name?: string
  roles: string[]
  allowedProjects: string[]
  allowedPolicies: string[]
  permissions?: string[]
  visibilityScope?: string
  actorType?: string
}

export interface AuthConfig {
  registrationEnabled: boolean
  emailVerificationRequired?: boolean
  smtpConfigured?: boolean
}

export function useBrainApi() {
  const toast = useToast()

  const apiUrl = useState<string>('brain.apiUrl', () => 'http://localhost:3333')
  const apiKey = useState<string>('brain.apiKey', () => '')
  const projectId = useState<string>('brain.projectId', () => 'brain')
  const currentUser = useState<AuthUserProfile | null>('brain.currentUser', () => null)
  const authConfig = useState<AuthConfig>('brain.authConfig', () => ({ registrationEnabled: true }))
  const authModalOpen = useState<boolean>('brain.authModalOpen', () => false)
  const authModalTab = useState<string>('brain.authModalTab', () => 'login')

  // Hydrate from localStorage on client
  if (import.meta.client) {
    const savedUrl = localStorage.getItem('brain.apiUrl')
    const savedKey = localStorage.getItem('brain.apiKey')
    const savedProj = localStorage.getItem('brain.projectId')
    if (savedUrl && apiUrl.value === 'http://localhost:3333') apiUrl.value = savedUrl
    if (savedKey && !apiKey.value) apiKey.value = savedKey
    if (savedProj && projectId.value === 'brain') projectId.value = savedProj
  }

  function notify(title: string, description?: string, color: 'primary' | 'success' | 'warning' | 'error' = 'success') {
    toast.add({ title, description, color })
  }

  async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const base = apiUrl.value.replace(/\/$/, '')
    const headers: Record<string, string> = {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string> ?? {})
    }
    if (apiKey.value) {
      headers.authorization = `Bearer ${apiKey.value}`
    }
    const res = await fetch(`${base}${path}`, { ...init, headers })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const msg = (data as { message?: string; error?: { message?: string } })?.error?.message
        ?? (data as { message?: string })?.message
        ?? `HTTP ${res.status}`
      throw Object.assign(new Error(msg), { status: res.status })
    }
    return data as T
  }

  async function refreshAuthSession() {
    try {
      const cfg = await apiFetch<AuthConfig>('/v1/auth/config')
      authConfig.value = cfg
    } catch {
      // ignore if offline
    }

    if (!apiKey.value) {
      currentUser.value = null
      return
    }

    try {
      const me = await apiFetch<{
        actorId?: string
        id?: string
        email?: string
        name?: string
        roles?: string[]
        allowedProjects?: string[]
        allowedPolicies?: string[]
        permissions?: string[]
        visibilityScope?: string
        actorType?: string
      }>(`/v1/auth/me?projectId=${encodeURIComponent(projectId.value)}`)
      currentUser.value = {
        id: me.actorId ?? me.id ?? 'local',
        email: me.email,
        name: me.name ?? me.actorId ?? 'Usuário',
        roles: me.roles ?? ['developer'],
        allowedProjects: me.allowedProjects ?? [],
        allowedPolicies: me.allowedPolicies ?? [],
        permissions: me.permissions ?? [],
        visibilityScope: me.visibilityScope,
        actorType: me.actorType
      }
    } catch (err) {
      const status = (err as { status?: number })?.status
      if (status === 401) {
        currentUser.value = null
        apiKey.value = ''
        if (import.meta.client) {
          localStorage.removeItem('brain.apiKey')
        }
      }
    }
  }

  function setSessionToken(token: string, user?: Partial<AuthUserProfile>) {
    apiKey.value = token
    if (import.meta.client) {
      localStorage.setItem('brain.apiKey', token)
      localStorage.setItem('brain.apiUrl', apiUrl.value)
    }
    if (user?.id) {
      currentUser.value = {
        id: user.id,
        email: user.email,
        name: user.name ?? user.id,
        roles: user.roles ?? ['developer'],
        allowedProjects: user.allowedProjects ?? [],
        allowedPolicies: user.allowedPolicies ?? [],
        permissions: user.permissions ?? []
      }
    }
  }

  function hasPermission(permission: string): boolean {
    const user = currentUser.value
    if (!user) return false
    if (user.roles.includes('admin')) return true
    if (user.permissions && user.permissions.length > 0) {
      return user.permissions.includes(permission)
    }
    return false
  }

  function logout() {
    apiKey.value = ''
    currentUser.value = null
    if (import.meta.client) {
      localStorage.removeItem('brain.apiKey')
    }
    notify('Sessão encerrada', undefined, 'warning')
  }

  return {
    apiUrl,
    apiKey,
    projectId,
    currentUser,
    authConfig,
    authModalOpen,
    authModalTab,
    apiFetch,
    notify,
    refreshAuthSession,
    setSessionToken,
    hasPermission,
    logout
  }
}

