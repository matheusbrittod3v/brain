<script setup lang="ts">
import { z } from 'zod'

const { projectId, apiFetch, notify, hasPermission } = useBrainApi()

interface RoleItem {
  roleId: string
  name: string
  description: string
  permissions: string[]
  allowedPolicies: string[]
}

interface RegisteredUser {
  id: string
  name: string
  email?: string
  roles: string[]
  linkedAgentIds: string[]
  source: string
}

interface AssignmentItem {
  userId: string
  roleIds: string[]
  linkedAgentIds: string[]
  inheritUserPermissions: boolean
  extraPermissions?: string[]
  deniedPermissions?: string[]
}

interface GrantItem {
  grantId: string
  actorId: string
  roles: string[]
  policyIds: string[]
  expiresAt: string
}

const activeTab = ref('assignments')
const tabs = computed(() => [
  { label: 'Atribuições & Usuários', value: 'assignments', icon: 'i-lucide-users', badge: usersList.value.length },
  { label: 'Cargos & Permissões (CASL)', value: 'roles', icon: 'i-lucide-shield', badge: rolesList.value.length },
  { label: 'Concessões Temporárias', value: 'grants', icon: 'i-lucide-clock', badge: grantsList.value.length }
])

const rolesList = ref<RoleItem[]>([])
const usersList = ref<RegisteredUser[]>([])
const assignmentsList = ref<AssignmentItem[]>([])
const grantsList = ref<GrantItem[]>([])
const permissionCatalog = ref<Array<{ id: string; group: string; label: string }>>([])
const loading = ref(false)
const accessError = ref<string | null>(null)

const permissionGroups = computed(() => {
  const map = new Map<string, Array<{ id: string; label: string }>>()
  for (const p of permissionCatalog.value) {
    const arr = map.get(p.group) ?? []
    arr.push({ id: p.id, label: p.label })
    map.set(p.group, arr)
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }))
})

// Role Editor Modal
const roleModalOpen = ref(false)
const savingRole = ref(false)
const roleForm = reactive({
  roleId: '',
  name: '',
  description: '',
  permissions: [] as string[],
  allowedPolicies: ['public-org', 'internal-project'] as string[],
  isNew: true
})

function openRoleEditor(role?: RoleItem) {
  if (role) {
    roleForm.roleId = role.roleId
    roleForm.name = role.name
    roleForm.description = role.description
    roleForm.permissions = [...role.permissions]
    roleForm.allowedPolicies = [...role.allowedPolicies]
    roleForm.isNew = false
  } else {
    roleForm.roleId = ''
    roleForm.name = ''
    roleForm.description = ''
    roleForm.permissions = ['menu:projects', 'menu:knowledge', 'knowledge:view', 'knowledge:read']
    roleForm.allowedPolicies = ['public-org', 'internal-project']
    roleForm.isNew = true
  }
  roleModalOpen.value = true
}

function toggleRolePerm(permId: string) {
  const idx = roleForm.permissions.indexOf(permId)
  if (idx >= 0) roleForm.permissions.splice(idx, 1)
  else roleForm.permissions.push(permId)
}

function toggleRolePolicy(pol: string) {
  const idx = roleForm.allowedPolicies.indexOf(pol)
  if (idx >= 0 && roleForm.allowedPolicies.length > 1) roleForm.allowedPolicies.splice(idx, 1)
  else if (idx < 0) roleForm.allowedPolicies.push(pol)
}

async function saveRole() {
  if (!roleForm.roleId.trim() || !roleForm.name.trim()) {
    notify('Informe ID e Nome do cargo', undefined, 'warning')
    return
  }
  savingRole.value = true
  try {
    await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/access/roles/${encodeURIComponent(roleForm.roleId.trim())}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          name: roleForm.name.trim(),
          description: roleForm.description.trim(),
          permissions: roleForm.permissions,
          allowedPolicies: roleForm.allowedPolicies
        })
      }
    )
    notify('Cargo salvo', `${roleForm.name} atualizado com ${roleForm.permissions.length} permissões.`)
    roleModalOpen.value = false
    await loadAccessData()
  } catch (err) {
    notify('Erro ao salvar cargo', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingRole.value = false
  }
}

async function deleteRole(roleId: string) {
  try {
    await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/access/roles/${encodeURIComponent(roleId)}`,
      { method: 'DELETE' }
    )
    notify('Cargo excluído', roleId, 'warning')
    await loadAccessData()
  } catch (err) {
    notify('Erro ao excluir cargo', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function loadAccessData() {
  loading.value = true
  accessError.value = null
  const pid = encodeURIComponent(projectId.value)
  try {
    const [rRes, uRes, aRes, gRes, pRes] = await Promise.allSettled([
      apiFetch<{ roles: RoleItem[] }>(`/v1/projects/${pid}/access/roles`),
      apiFetch<{ users: RegisteredUser[] }>(`/v1/projects/${pid}/access/users`),
      apiFetch<{ assignments: AssignmentItem[] }>(`/v1/projects/${pid}/access/assignments`),
      apiFetch<{ grants: GrantItem[] }>(`/v1/projects/${pid}/access/grants`),
      apiFetch<{ permissions: typeof permissionCatalog.value }>(`/v1/projects/${pid}/access/permissions`)
    ])
    if (rRes.status === 'fulfilled') rolesList.value = rRes.value.roles ?? []
    else accessError.value = rRes.reason instanceof Error ? rRes.reason.message : String(rRes.reason)
    if (uRes.status === 'fulfilled') usersList.value = uRes.value.users ?? []
    else if (!accessError.value) accessError.value = uRes.reason instanceof Error ? uRes.reason.message : String(uRes.reason)
    if (aRes.status === 'fulfilled') assignmentsList.value = aRes.value.assignments ?? []
    if (gRes.status === 'fulfilled') grantsList.value = gRes.value.grants ?? []
    if (pRes.status === 'fulfilled') permissionCatalog.value = pRes.value.permissions ?? []
  } finally {
    loading.value = false
  }
}

onMounted(loadAccessData)
watch(projectId, loadAccessData)

const userSelectItems = computed(() =>
  usersList.value.map(u => ({
    label: u.email ? `${u.name} (${u.email})` : `${u.name} — ${u.id}`,
    value: u.id
  }))
)

const roleSelectItems = computed(() =>
  rolesList.value.length > 0
    ? rolesList.value.map(r => ({ label: `${r.name} (${r.roleId})`, value: r.roleId }))
    : [
        { label: 'Administrador (admin)', value: 'admin' },
        { label: 'Tech Lead (tech-lead)', value: 'tech-lead' },
        { label: 'Desenvolvedor (developer)', value: 'developer' },
        { label: 'Visualizador (viewer)', value: 'viewer' }
      ]
)

const knownAgents = ['cursor-mcp', 'claude-code', 'brain-runner', 'ci-bot']
const allPolicies = ['public-org', 'internal-project', 'confidential-business', 'restricted-security']

function resolveUserDisplay(userId: string) {
  const found = usersList.value.find(u => u.id === userId)
  if (!found) return { name: userId, email: undefined }
  return { name: found.name, email: found.email }
}

// Assignment Zod Form
const customUserMode = ref(false)
const assignSchema = z.object({
  userId: z.string().min(1, 'Selecione ou informe o usuário'),
  roleId: z.string().min(1, 'Cargo obrigatório'),
  inheritUserPermissions: z.boolean()
})
const assignState = reactive({
  userId: '',
  roleId: 'developer',
  linkedAgents: [] as string[],
  customAgentInput: '',
  inheritUserPermissions: true,
  extraPermissions: [] as string[],
  deniedPermissions: [] as string[]
})
const savingAssign = ref(false)

watch(() => assignState.userId, (uid) => {
  if (!uid) return
  const existing = assignmentsList.value.find(a => a.userId === uid)
  if (existing) {
    assignState.roleId = existing.roleIds[0] || 'developer'
    assignState.linkedAgents = [...existing.linkedAgentIds]
    assignState.inheritUserPermissions = existing.inheritUserPermissions
    assignState.extraPermissions = [...(existing.extraPermissions ?? [])]
    assignState.deniedPermissions = [...(existing.deniedPermissions ?? [])]
    return
  }
  const user = usersList.value.find(u => u.id === uid)
  if (user) {
    assignState.roleId = user.roles[0] || 'developer'
    assignState.linkedAgents = [...(user.linkedAgentIds ?? [])]
    assignState.extraPermissions = []
    assignState.deniedPermissions = []
  }
})

function toggleAssignExtraPerm(permId: string) {
  const idx = assignState.extraPermissions.indexOf(permId)
  if (idx >= 0) {
    assignState.extraPermissions.splice(idx, 1)
  } else {
    assignState.extraPermissions.push(permId)
    const deniedIdx = assignState.deniedPermissions.indexOf(permId)
    if (deniedIdx >= 0) assignState.deniedPermissions.splice(deniedIdx, 1)
  }
}

function toggleAssignDeniedPerm(permId: string) {
  const idx = assignState.deniedPermissions.indexOf(permId)
  if (idx >= 0) {
    assignState.deniedPermissions.splice(idx, 1)
  } else {
    assignState.deniedPermissions.push(permId)
    const extraIdx = assignState.extraPermissions.indexOf(permId)
    if (extraIdx >= 0) assignState.extraPermissions.splice(extraIdx, 1)
  }
}

function toggleAgentChip(agent: string) {
  const idx = assignState.linkedAgents.indexOf(agent)
  if (idx >= 0) assignState.linkedAgents.splice(idx, 1)
  else assignState.linkedAgents.push(agent)
}

function addCustomAgent() {
  const val = assignState.customAgentInput.trim()
  if (!val) return
  if (!assignState.linkedAgents.includes(val)) assignState.linkedAgents.push(val)
  assignState.customAgentInput = ''
}

async function onSaveAssignment() {
  savingAssign.value = true
  try {
    await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/access/assignments/${encodeURIComponent(assignState.userId.trim())}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          roleIds: [assignState.roleId],
          linkedAgentIds: assignState.linkedAgents,
          inheritUserPermissions: assignState.inheritUserPermissions,
          extraPermissions: assignState.extraPermissions,
          deniedPermissions: assignState.deniedPermissions
        })
      }
    )
    const display = resolveUserDisplay(assignState.userId)
    notify('Atribuição salva', `${display.name} atualizado com cargo ${assignState.roleId}.`)
    await loadAccessData()
  } catch (err) {
    notify('Erro ao salvar atribuição', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingAssign.value = false
  }
}

async function deleteAssignment(userId: string) {
  try {
    await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/access/assignments/${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    )
    notify('Atribuição removida', resolveUserDisplay(userId).name, 'warning')
    await loadAccessData()
  } catch (err) {
    notify('Erro ao remover atribuição', err instanceof Error ? err.message : String(err), 'error')
  }
}

// Temporary Grant Zod Form
const customGrantActorMode = ref(false)
const grantActorOptions = computed(() => [
  ...userSelectItems.value,
  ...knownAgents.map(a => ({ label: `Agente: ${a}`, value: a }))
])

const grantSchema = z.object({
  actorId: z.string().min(1, 'Selecione ou informe o ator'),
  role: z.string().min(1),
  ttlMinutes: z.number().min(5).max(10080)
})
const grantState = reactive({
  actorId: '',
  role: 'developer',
  policyIds: ['public-org', 'internal-project'] as string[],
  ttlMinutes: 60
})
const savingGrant = ref(false)

function toggleGrantPolicy(pol: string) {
  const idx = grantState.policyIds.indexOf(pol)
  if (idx >= 0 && grantState.policyIds.length > 1) grantState.policyIds.splice(idx, 1)
  else if (idx < 0) grantState.policyIds.push(pol)
}

async function onCreateGrant() {
  savingGrant.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/access/grants`, {
      method: 'POST',
      body: JSON.stringify({
        actorId: grantState.actorId.trim(),
        roles: [grantState.role],
        policyIds: grantState.policyIds,
        ttlMinutes: grantState.ttlMinutes
      })
    })
    notify('Concessão temporária emitida', `Expira em ${grantState.ttlMinutes} min.`)
    grantState.actorId = ''
    await loadAccessData()
  } catch (err) {
    notify('Erro ao emitir grant', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingGrant.value = false
  }
}

async function revokeGrant(grantId: string) {
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/access/grants/${encodeURIComponent(grantId)}`, {
      method: 'DELETE'
    })
    notify('Concessão revogada', grantId, 'warning')
    await loadAccessData()
  } catch (err) {
    notify('Erro ao revogar grant', err instanceof Error ? err.message : String(err), 'error')
  }
}

function formatRemaining(expiresAt: string) {
  const diffMin = Math.round((Date.parse(expiresAt) - Date.now()) / 60_000)
  if (diffMin <= 0) return 'Expirado'
  if (diffMin < 60) return `${diffMin} min restantes`
  return `${Math.floor(diffMin / 60)}h ${diffMin % 60}m restantes`
}
</script>

<template>
  <div>
    <UiPageHeader
      title="Acesso, CASL & Políticas"
      description="Selecione usuários registrados, vincule cargos RBAC e agentes Human-in-the-Loop ou emita acessos Just-In-Time"
      icon="i-lucide-shield"
    >
      <template #actions>
        <UButton size="sm" variant="soft" icon="i-lucide-refresh-cw" :loading="loading" @click="loadAccessData">
          Atualizar
        </UButton>
      </template>
    </UiPageHeader>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <UiStatCard label="Usuários & Atores" :value="usersList.length" icon="i-lucide-user-check" tone="primary" :loading="loading" />
      <UiStatCard label="Cargos CASL" :value="rolesList.length" icon="i-lucide-shield-check" tone="info" :loading="loading" />
      <UiStatCard label="Atribuições Ativas" :value="assignmentsList.length" icon="i-lucide-users" tone="success" :loading="loading" />
      <UiStatCard label="Grants Just-In-Time" :value="grantsList.length" icon="i-lucide-clock" tone="warning" :loading="loading" />
    </div>

    <div class="space-y-6">
      <UAlert
        v-if="accessError"
        color="error"
        variant="subtle"
        icon="i-lucide-shield-alert"
        title="Erro ao carregar permissões de acesso"
        :description="accessError"
      />

      <UiSegmentedTabs v-model="activeTab" :items="tabs" />

      <!-- ASSIGNMENTS & AGENTS -->
      <div v-if="activeTab === 'assignments'" class="space-y-6">
        <UCard>
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 class="font-semibold text-sm">Vincular Usuário, Cargo e Agentes (Human-in-the-Loop)</h3>
                <p class="text-xs text-muted">Escolha um usuário já registrado no sistema sem precisar digitar IDs manualmente</p>
              </div>
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                @click="customUserMode = !customUserMode; assignState.userId = ''"
              >
                {{ customUserMode ? 'Selecionar da lista' : 'Digitar ID externo' }}
              </UButton>
            </div>
          </template>

          <UForm :schema="assignSchema" :state="assignState" class="space-y-4" @submit="onSaveAssignment">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <UFormField label="Usuário Registrado" name="userId">
                <USelect
                  v-if="!customUserMode"
                  v-model="assignState.userId"
                  :items="userSelectItems"
                  placeholder="Selecione um usuário..."
                  class="w-full"
                />
                <UInput
                  v-else
                  v-model="assignState.userId"
                  placeholder="ID do usuário ou serviço externo..."
                  class="w-full font-mono"
                />
              </UFormField>

              <UFormField label="Cargo Base (RBAC / CASL)" name="roleId">
                <USelect v-model="assignState.roleId" :items="roleSelectItems" class="w-full" />
              </UFormField>
            </div>

            <div class="space-y-2">
              <div class="text-xs font-medium text-highlighted">Agentes Vinculados (clique para selecionar)</div>
              <div class="flex flex-wrap items-center gap-2">
                <UButton
                  v-for="agent in knownAgents"
                  :key="agent"
                  size="xs"
                  :variant="assignState.linkedAgents.includes(agent) ? 'solid' : 'outline'"
                  :color="assignState.linkedAgents.includes(agent) ? 'primary' : 'neutral'"
                  icon="i-lucide-bot"
                  @click="toggleAgentChip(agent)"
                >
                  {{ agent }}
                </UButton>
                <div class="flex items-center gap-1.5 ml-auto">
                  <UInput
                    v-model="assignState.customAgentInput"
                    placeholder="Outro agente..."
                    size="xs"
                    class="w-36 font-mono"
                    @keyup.enter.prevent="addCustomAgent"
                  />
                  <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="addCustomAgent">Adicionar</UButton>
                </div>
              </div>
              <div v-if="assignState.linkedAgents.length" class="flex flex-wrap gap-1 pt-1">
                <UBadge
                  v-for="ag in assignState.linkedAgents"
                  :key="ag"
                  color="primary"
                  variant="subtle"
                  size="xs"
                  class="font-mono cursor-pointer"
                  @click="toggleAgentChip(ag)"
                >
                  {{ ag }} ×
                </UBadge>
              </div>
            </div>

            <div v-if="permissionCatalog.length > 0" class="space-y-2 pt-2 border-t border-default">
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium text-highlighted">Permissões Personalizadas do Usuário (Extras / Negadas)</span>
                <span class="text-[11px] text-muted">
                  +{{ assignState.extraPermissions.length }} extras · -{{ assignState.deniedPermissions.length }} negadas
                </span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-48 overflow-y-auto p-2 rounded-lg border border-default bg-elevated/30">
                <div
                  v-for="perm in permissionCatalog"
                  :key="perm.id"
                  class="flex items-center justify-between gap-2 text-xs px-2 py-1 rounded border border-default/60 bg-default/40"
                >
                  <span class="truncate" :title="perm.id">{{ perm.label }}</span>
                  <div class="flex items-center gap-1 shrink-0">
                    <UButton
                      size="xs"
                      :variant="assignState.extraPermissions.includes(perm.id) ? 'solid' : 'ghost'"
                      color="success"
                      title="Conceder permissão extra"
                      @click="toggleAssignExtraPerm(perm.id)"
                    >
                      +
                    </UButton>
                    <UButton
                      size="xs"
                      :variant="assignState.deniedPermissions.includes(perm.id) ? 'solid' : 'ghost'"
                      color="error"
                      title="Negar permissão"
                      @click="toggleAssignDeniedPerm(perm.id)"
                    >
                      -
                    </UButton>
                  </div>
                </div>
              </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-default">
              <UCheckbox
                v-model="assignState.inheritUserPermissions"
                label="Agentes vinculados herdam permissões do usuário (Human-in-the-Loop)"
              />
              <UButton type="submit" :loading="savingAssign" icon="i-lucide-save">Salvar Atribuição</UButton>
            </div>
          </UForm>
        </UCard>

        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="font-semibold text-sm">Usuários Registrados</h3>
              <UBadge color="primary" variant="subtle" size="xs">{{ usersList.length }} usuários</UBadge>
            </div>
          </template>
          <UiEmptyState
            v-if="usersList.length === 0"
            compact
            icon="i-lucide-user-x"
            title="Nenhum usuário encontrado"
            description="Verifique se você tem permissão roles:view ou cadastre um novo usuário."
          />
          <UTable
            v-else
            :data="usersList"
            :columns="[
              { accessorKey: 'name', header: 'Usuário' },
              { accessorKey: 'roles', header: 'Cargos' },
              { accessorKey: 'source', header: 'Origem' },
              { id: 'actions', header: '' }
            ]"
          >
            <template #name-cell="{ row }">
              <div>
                <div class="font-medium text-sm">{{ row.original.name }}</div>
                <div class="text-[11px] text-muted font-mono">{{ row.original.email || row.original.id }}</div>
              </div>
            </template>
            <template #roles-cell="{ row }">
              <div class="flex flex-wrap gap-1">
                <UBadge v-for="r in row.original.roles" :key="r" size="xs" variant="subtle">{{ r }}</UBadge>
              </div>
            </template>
            <template #source-cell="{ row }">
              <UBadge color="neutral" variant="outline" size="xs">{{ row.original.source }}</UBadge>
            </template>
            <template #actions-cell="{ row }">
              <UButton size="xs" variant="soft" icon="i-lucide-user-cog" @click="assignState.userId = row.original.id">
                Configurar Acesso
              </UButton>
            </template>
          </UTable>
        </UCard>

        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <h3 class="font-semibold text-sm">Atribuições no Projeto</h3>
              <UBadge color="neutral" variant="subtle" size="xs">{{ assignmentsList.length }} registros</UBadge>
            </div>
          </template>
          <UiEmptyState
            v-if="assignmentsList.length === 0"
            compact
            icon="i-lucide-users"
            title="Nenhuma atribuição específica ainda"
            description="Selecione um usuário acima para definir cargo e agentes vinculados."
          />
          <UTable
            v-else
            :data="assignmentsList"
            :columns="[
              { accessorKey: 'userId', header: 'Usuário' },
              { accessorKey: 'roleIds', header: 'Cargos' },
              { accessorKey: 'linkedAgentIds', header: 'Agentes Vinculados' },
              { accessorKey: 'inheritUserPermissions', header: 'Herança' },
              { id: 'actions', header: '' }
            ]"
          >
            <template #userId-cell="{ row }">
              <div>
                <div class="font-medium text-sm">{{ resolveUserDisplay(row.original.userId).name }}</div>
                <div class="text-[11px] text-muted font-mono">
                  {{ resolveUserDisplay(row.original.userId).email || row.original.userId }}
                </div>
              </div>
            </template>
            <template #roleIds-cell="{ row }">
              <div class="flex gap-1"><UBadge v-for="r in row.original.roleIds" :key="r" size="xs" variant="subtle">{{ r }}</UBadge></div>
            </template>
            <template #linkedAgentIds-cell="{ row }">
              <div class="flex flex-wrap gap-1">
                <UBadge v-for="a in row.original.linkedAgentIds" :key="a" color="neutral" variant="outline" size="xs" class="font-mono">
                  {{ a }}
                </UBadge>
                <span v-if="!row.original.linkedAgentIds.length" class="text-xs text-muted">—</span>
              </div>
            </template>
            <template #inheritUserPermissions-cell="{ row }">
              <UBadge :color="row.original.inheritUserPermissions ? 'success' : 'neutral'" variant="subtle" size="xs">
                {{ row.original.inheritUserPermissions ? 'Ativa' : 'Inativa' }}
              </UBadge>
            </template>
            <template #actions-cell="{ row }">
              <div class="flex justify-end gap-1">
                <UButton size="xs" variant="ghost" icon="i-lucide-pencil" @click="assignState.userId = row.original.userId" />
                <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" @click="deleteAssignment(row.original.userId)" />
              </div>
            </template>
          </UTable>
        </UCard>
      </div>

      <!-- ROLES -->
      <div v-else-if="activeTab === 'roles'" class="space-y-4">
        <div class="flex items-center justify-between">
          <p class="text-xs text-muted">Configure quais guias (<code>menu:*</code>) e ações cada cargo pode acessar</p>
          <UButton
            v-if="hasPermission('roles:manage')"
            size="sm"
            variant="soft"
            icon="i-lucide-plus"
            @click="openRoleEditor()"
          >
            Novo Cargo
          </UButton>
        </div>

        <UiEmptyState v-if="rolesList.length === 0" icon="i-lucide-shield-off" title="Sem cargos disponíveis ou sem permissão de visualização" />
        <div v-else v-auto-animate class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <UCard v-for="role in rolesList" :key="role.roleId" variant="subtle">
            <div class="space-y-3">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <h3 class="font-semibold text-sm">{{ role.name }}</h3>
                  <code class="text-xs text-muted">{{ role.roleId }}</code>
                </div>
                <div class="flex items-center gap-1.5">
                  <UBadge color="primary" variant="subtle" size="xs">{{ role.permissions.length }} permissões</UBadge>
                  <UButton
                    v-if="hasPermission('roles:manage')"
                    size="xs"
                    variant="ghost"
                    icon="i-lucide-pencil"
                    @click="openRoleEditor(role)"
                  />
                  <UButton
                    v-if="hasPermission('roles:manage') && !['admin', 'tech-lead', 'developer', 'viewer'].includes(role.roleId)"
                    size="xs"
                    color="error"
                    variant="ghost"
                    icon="i-lucide-trash-2"
                    @click="deleteRole(role.roleId)"
                  />
                </div>
              </div>
              <p class="text-xs text-muted leading-relaxed">{{ role.description }}</p>
              <div class="flex flex-wrap gap-1 pt-2 border-t border-default">
                <UBadge v-for="pol in role.allowedPolicies" :key="pol" color="neutral" variant="outline" size="xs">{{ pol }}</UBadge>
              </div>
            </div>
          </UCard>
        </div>
      </div>

      <!-- TEMPORARY GRANTS -->
      <div v-else-if="activeTab === 'grants'" class="space-y-6">
        <UCard>
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 class="font-semibold text-sm">Emitir Acesso Temporário (Just-In-Time)</h3>
                <p class="text-xs text-muted">Conceda acesso temporário com expiração automática para usuários ou agentes</p>
              </div>
              <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                @click="customGrantActorMode = !customGrantActorMode; grantState.actorId = ''"
              >
                {{ customGrantActorMode ? 'Selecionar da lista' : 'Digitar ID externo' }}
              </UButton>
            </div>
          </template>

          <UForm :schema="grantSchema" :state="grantState" class="space-y-4" @submit="onCreateGrant">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
              <UFormField label="Usuário ou Agente" name="actorId">
                <USelect
                  v-if="!customGrantActorMode"
                  v-model="grantState.actorId"
                  :items="grantActorOptions"
                  placeholder="Selecione o ator..."
                  class="w-full"
                />
                <UInput v-else v-model="grantState.actorId" placeholder="ID do ator..." class="w-full font-mono" />
              </UFormField>

              <UFormField label="Cargo Temporário" name="role">
                <USelect v-model="grantState.role" :items="roleSelectItems" class="w-full" />
              </UFormField>

              <UFormField label="Duração (minutos)" name="ttlMinutes">
                <div class="flex gap-1.5">
                  <UInput v-model.number="grantState.ttlMinutes" type="number" min="5" max="10080" class="w-24" />
                  <UButton
                    v-for="preset in [{ l: '15m', v: 15 }, { l: '1h', v: 60 }, { l: '4h', v: 240 }, { l: '24h', v: 1440 }]"
                    :key="preset.v"
                    size="xs"
                    :variant="grantState.ttlMinutes === preset.v ? 'solid' : 'outline'"
                    color="neutral"
                    @click="grantState.ttlMinutes = preset.v"
                  >
                    {{ preset.l }}
                  </UButton>
                </div>
              </UFormField>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-default">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="text-xs text-muted mr-1">Políticas:</span>
                <UButton
                  v-for="pol in allPolicies"
                  :key="pol"
                  size="xs"
                  :variant="grantState.policyIds.includes(pol) ? 'soft' : 'outline'"
                  :color="grantState.policyIds.includes(pol) ? 'primary' : 'neutral'"
                  @click="toggleGrantPolicy(pol)"
                >
                  {{ pol }}
                </UButton>
              </div>
              <UButton type="submit" :loading="savingGrant" icon="i-lucide-clock">Conceder Acesso</UButton>
            </div>
          </UForm>
        </UCard>

        <UCard>
          <UiEmptyState v-if="grantsList.length === 0" compact icon="i-lucide-clock" title="Nenhuma concessão temporária ativa" />
          <UTable
            v-else
            :data="grantsList"
            :columns="[
              { accessorKey: 'actorId', header: 'Ator' },
              { accessorKey: 'roles', header: 'Cargos' },
              { accessorKey: 'policyIds', header: 'Políticas' },
              { accessorKey: 'expiresAt', header: 'Expiração' },
              { id: 'actions', header: '' }
            ]"
          >
            <template #actorId-cell="{ row }">
              <div>
                <div class="font-medium text-sm">{{ resolveUserDisplay(row.original.actorId).name }}</div>
                <div class="text-[11px] text-muted font-mono">{{ row.original.actorId }}</div>
              </div>
            </template>
            <template #roles-cell="{ row }">
              <div class="flex gap-1"><UBadge v-for="r in row.original.roles" :key="r" size="xs" variant="subtle">{{ r }}</UBadge></div>
            </template>
            <template #policyIds-cell="{ row }">
              <div class="flex flex-wrap gap-1">
                <UBadge v-for="p in row.original.policyIds" :key="p" color="neutral" variant="outline" size="xs">{{ p }}</UBadge>
              </div>
            </template>
            <template #expiresAt-cell="{ row }">
              <div>
                <UBadge color="warning" variant="subtle" size="xs">{{ formatRemaining(row.original.expiresAt) }}</UBadge>
                <div class="text-[11px] text-muted mt-0.5">{{ new Date(row.original.expiresAt).toLocaleString('pt-BR') }}</div>
              </div>
            </template>
            <template #actions-cell="{ row }">
              <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" @click="revokeGrant(row.original.grantId)">
                Revogar
              </UButton>
            </template>
          </UTable>
        </UCard>
      </div>
    </div>

    <!-- Role Editor Modal -->
    <UModal v-model:open="roleModalOpen" :title="roleForm.isNew ? 'Criar Cargo Personalizado' : `Editar Cargo: ${roleForm.name}`">
      <template #body>
        <div class="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="Slug (ID)">
              <UInput v-model="roleForm.roleId" :disabled="!roleForm.isNew" placeholder="ex: qa-reviewer" class="w-full font-mono" />
            </UFormField>
            <UFormField label="Nome">
              <UInput v-model="roleForm.name" placeholder="Revisor de QA" class="w-full" />
            </UFormField>
          </div>
          <UFormField label="Descrição">
            <UInput v-model="roleForm.description" placeholder="Escopo de acesso deste cargo..." class="w-full" />
          </UFormField>

          <div class="space-y-1.5">
            <div class="text-xs font-medium">Políticas de Conhecimento Permitidas</div>
            <div class="flex flex-wrap gap-1.5">
              <UButton
                v-for="pol in allPolicies"
                :key="pol"
                size="xs"
                :variant="roleForm.allowedPolicies.includes(pol) ? 'soft' : 'outline'"
                :color="roleForm.allowedPolicies.includes(pol) ? 'primary' : 'neutral'"
                @click="toggleRolePolicy(pol)"
              >
                {{ pol }}
              </UButton>
            </div>
          </div>

          <div v-for="grp in permissionGroups" :key="grp.group" class="space-y-2 pt-2 border-t border-default">
            <div class="text-xs font-semibold text-primary">{{ grp.group }}</div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
              <label
                v-for="perm in grp.items"
                :key="perm.id"
                class="flex items-center gap-2 text-xs p-1.5 rounded-lg border border-default cursor-pointer hover:bg-elevated/60"
              >
                <input
                  type="checkbox"
                  :checked="roleForm.permissions.includes(perm.id)"
                  class="accent-indigo-500"
                  @change="toggleRolePerm(perm.id)"
                >
                <span class="truncate">{{ perm.label }}</span>
              </label>
            </div>
          </div>

          <div class="flex justify-end gap-2 pt-3 border-t border-default">
            <UButton color="neutral" variant="ghost" @click="roleModalOpen = false">Cancelar</UButton>
            <UButton :loading="savingRole" icon="i-lucide-save" @click="saveRole">Salvar Cargo</UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
