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
  const authRestoring = useState<boolean>('brain.authRestoring', () => true)

  // Hydrate from localStorage on client synchronously before render
  if (import.meta.client) {
    const savedUrl = localStorage.getItem('brain.apiUrl')
    const savedKey = localStorage.getItem('brain.apiKey')
    const savedProj = localStorage.getItem('brain.projectId')
    const savedUser = localStorage.getItem('brain.currentUser')

    if (savedUrl) {
      apiUrl.value = savedUrl
    } else if (typeof window !== 'undefined' && window.location.hostname === '127.0.0.1') {
      apiUrl.value = 'http://127.0.0.1:3333'
    }
    if (savedKey && !apiKey.value) apiKey.value = savedKey
    if (savedProj && projectId.value === 'brain') projectId.value = savedProj
    if (savedUser && !currentUser.value) {
      try {
        currentUser.value = JSON.parse(savedUser)
      } catch {
        localStorage.removeItem('brain.currentUser')
      }
    }
    if (!savedKey) {
      authRestoring.value = false
    }
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
      if (me.allowedProjects && me.allowedProjects.length > 0 && !me.allowedProjects.includes(projectId.value)) {
        projectId.value = me.allowedProjects[0]!
        if (import.meta.client) {
          localStorage.setItem('brain.projectId', projectId.value)
        }
      }
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
      if (import.meta.client) {
        localStorage.setItem('brain.currentUser', JSON.stringify(currentUser.value))
      }
    } catch (err) {
      const status = (err as { status?: number })?.status
      if (status === 401) {
        currentUser.value = null
        apiKey.value = ''
        if (import.meta.client) {
          localStorage.removeItem('brain.apiKey')
          localStorage.removeItem('brain.currentUser')
        }
      }
    } finally {
      authRestoring.value = false
    }
  }

  function setSessionToken(token: string, user?: Partial<AuthUserProfile>) {
    apiKey.value = token
    if (user?.id) {
      if (user.allowedProjects && user.allowedProjects.length > 0 && !user.allowedProjects.includes(projectId.value)) {
        projectId.value = user.allowedProjects[0]!
        if (import.meta.client) {
          localStorage.setItem('brain.projectId', projectId.value)
        }
      }
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
    if (import.meta.client) {
      localStorage.setItem('brain.apiKey', token)
      localStorage.setItem('brain.apiUrl', apiUrl.value)
      if (currentUser.value) {
        localStorage.setItem('brain.currentUser', JSON.stringify(currentUser.value))
      }
    }
    authRestoring.value = false
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
    authRestoring.value = false
    if (import.meta.client) {
      localStorage.removeItem('brain.apiKey')
      localStorage.removeItem('brain.currentUser')
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
    authRestoring,
    apiFetch,
    notify,
    refreshAuthSession,
    setSessionToken,
    hasPermission,
    logout
  }
}

