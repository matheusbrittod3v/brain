<script setup lang="ts">
import type {
  AssignmentItem,
  GrantItem,
  PermissionItem,
  RegisteredUser,
  RoleItem,
  UnifiedUserRow
} from './access/types'

const { projectId, apiFetch, notify, hasPermission } = useBrainApi()

const activeTab = ref('assignments')
const loading = ref(false)
const accessError = ref<string | null>(null)

const rolesList = ref<RoleItem[]>([])
const usersList = ref<RegisteredUser[]>([])
const assignmentsList = ref<AssignmentItem[]>([])
const grantsList = ref<GrantItem[]>([])
const permissionCatalog = ref<PermissionItem[]>([])

// Overlay states
const assignSlideoverOpen = ref(false)
const assignTargetUserId = ref<string | undefined>(undefined)

const roleModalOpen = ref(false)
const editingRole = ref<RoleItem | null>(null)

const scopeModalOpen = ref(false)
const scopeTargetUser = ref<UnifiedUserRow | null>(null)
const mcpTokenModalOpen = ref(false)

const grantPresetActorId = ref('')

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

const unifiedUsers = computed<UnifiedUserRow[]>(() => {
  const map = new Map<string, UnifiedUserRow>()

  for (const u of usersList.value) {
    map.set(u.id, {
      ...u,
      effectiveRoles: [...u.roles],
      effectiveAgents: [...(u.linkedAgentIds ?? [])]
    })
  }
  for (const a of assignmentsList.value) {
    const existing = map.get(a.userId)
    if (existing) {
      existing.assignment = a
      if (a.roleIds.length > 0) existing.effectiveRoles = [...a.roleIds]
      existing.effectiveAgents = [...a.linkedAgentIds]
    } else {
      map.set(a.userId, {
        id: a.userId,
        name: a.userId,
        roles: [...a.roleIds],
        linkedAgentIds: [...a.linkedAgentIds],
        source: 'atribuição',
        assignment: a,
        effectiveRoles: [...a.roleIds],
        effectiveAgents: [...a.linkedAgentIds]
      })
    }
  }
  return [...map.values()]
})

const tabs = computed(() => [
  { label: 'Usuários & Vínculos', value: 'assignments', icon: 'i-lucide-users', badge: unifiedUsers.value.length },
  { label: 'Cargos & Permissões', value: 'roles', icon: 'i-lucide-shield', badge: rolesList.value.length },
  { label: 'Acesso Just-In-Time', value: 'grants', icon: 'i-lucide-clock', badge: grantsList.value.length },
  { label: 'Explicador de Permissões', value: 'explain', icon: 'i-lucide-help-circle' }
])

// Explain Permissions in Plain Language
const explainForm = reactive({
  itemId: '',
  action: 'write'
})
const loadingExplain = ref(false)
const explainResult = ref<{
  targetItem: string
  action: string
  policyApplied: string
  allowedRoles: string[]
  whoCanPerform: string
  plainLanguageExplanation: string
  canCurrentUserPerform: boolean
} | null>(null)

async function runExplainPermissions() {
  loadingExplain.value = true
  try {
    explainResult.value = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value || 'brain')}/daily/explain-permissions`, {
      method: 'POST',
      body: JSON.stringify({ knowledgeItemId: explainForm.itemId.trim() || undefined, targetAction: explainForm.action })
    })
  } catch (err) {
    notify('Erro ao explicar permissão', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loadingExplain.value = false
  }
}

async function loadAccessData() {
  accessError.value = null
  loading.value = true
  const pid = encodeURIComponent(projectId.value || '__global__')
  try {
    const [rRes, uRes, aRes, gRes, pRes] = await Promise.allSettled([
      apiFetch<{ roles: RoleItem[] }>(`/v1/projects/${pid}/access/roles`),
      apiFetch<{ users: RegisteredUser[] }>(`/v1/projects/${pid}/access/users`),
      apiFetch<{ assignments: AssignmentItem[] }>(`/v1/projects/${pid}/access/assignments`),
      apiFetch<{ grants: GrantItem[] }>(`/v1/projects/${pid}/access/grants`),
      apiFetch<{ permissions: PermissionItem[] }>(`/v1/projects/${pid}/access/permissions`)
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

function openAssignSlideover(userId?: string) {
  assignTargetUserId.value = userId
  assignSlideoverOpen.value = true
}

function openRoleEditor(role?: RoleItem) {
  editingRole.value = role ?? null
  roleModalOpen.value = true
}

function openScopeEditor(user: UnifiedUserRow) {
  scopeTargetUser.value = user
  scopeModalOpen.value = true
}

function quickGrantForUser(userId: string) {
  grantPresetActorId.value = userId
  activeTab.value = 'grants'
}

async function deleteAssignment(userId: string) {
  try {
    await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/access/assignments/${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    )
    notify('Atribuição removida', userId, 'warning')
    await loadAccessData()
  } catch (err) {
    notify('Erro ao remover atribuição', err instanceof Error ? err.message : String(err), 'error')
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
</script>

<template>
  <div class="space-y-5">
    <UiPageHeader
      title="Acesso, CASL & Políticas"
      description="Gerencie usuários, cargos RBAC, agentes Human-in-the-Loop e acessos Just-In-Time"
      icon="i-lucide-shield"
    >
      <template #actions>
        <UButton
          v-if="hasPermission('users:assign_roles')"
          size="sm"
          variant="soft"
          icon="i-lucide-user-plus"
          @click="openAssignSlideover()"
        >
          Vincular Ator
        </UButton>
        <UButton
          v-if="hasPermission('roles:manage')"
          size="sm"
          icon="i-lucide-plus"
          @click="openRoleEditor()"
        >
          Novo Cargo
        </UButton>
        <UButton size="sm" variant="soft" color="info" icon="i-lucide-key-round" @click="mcpTokenModalOpen = true">
          Token MCP
        </UButton>
        <UButton size="sm" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="loadAccessData">
          Atualizar
        </UButton>
      </template>
    </UiPageHeader>

    <div class="rounded-xl border border-default bg-elevated/40 p-3.5">
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <div class="text-[11px] text-muted">Usuários &amp; Atores</div>
          <div class="text-sm font-semibold text-highlighted mt-0.5">{{ unifiedUsers.length }}</div>
        </div>
        <div>
          <div class="text-[11px] text-muted">Cargos CASL</div>
          <div class="text-sm font-semibold text-highlighted mt-0.5">{{ rolesList.length }}</div>
        </div>
        <div>
          <div class="text-[11px] text-muted">Vínculos no Projeto</div>
          <div class="text-sm font-semibold text-success mt-0.5">{{ assignmentsList.length }}</div>
        </div>
        <div>
          <div class="text-[11px] text-muted">Grants Just-In-Time</div>
          <div class="text-sm font-semibold text-warning mt-0.5">{{ grantsList.length }}</div>
        </div>
      </div>
    </div>

    <UAlert
      v-if="accessError"
      color="error"
      variant="subtle"
      icon="i-lucide-shield-alert"
      title="Erro ao carregar permissões de acesso"
      :description="accessError"
    />

    <UiSegmentedTabs v-model="activeTab" :items="tabs" />

    <AccessUsersTab
      v-if="activeTab === 'assignments'"
      :users="unifiedUsers"
      :role-options="roleSelectItems"
      :can-assign="hasPermission('users:assign_roles')"
      @edit-assignment="openAssignSlideover"
      @edit-scopes="openScopeEditor"
      @quick-grant="quickGrantForUser"
      @delete-assignment="deleteAssignment"
    />

    <AccessRolesTab
      v-else-if="activeTab === 'roles'"
      :roles="rolesList"
      :can-manage="hasPermission('roles:manage')"
      @create="openRoleEditor()"
      @edit="openRoleEditor"
      @delete="deleteRole"
    />

    <AccessGrantsTab
      v-else-if="activeTab === 'grants'"
      :grants="grantsList"
      :users="usersList"
      :role-options="roleSelectItems"
      :initial-actor-id="grantPresetActorId"
      @refresh="loadAccessData"
    />

    <!-- Explicador de Permissões em Linguagem Simples -->
    <div v-else-if="activeTab === 'explain'" class="space-y-5">
      <UCard>
        <template #header>
          <div class="space-y-1">
            <h3 class="font-semibold text-sm">Explicador de Permissões em Linguagem Simples</h3>
            <p class="text-xs text-muted">
              Descubra exatamente "quem pode alterar este conhecimento?" ou "por que tenho ou não acesso?", com justificativa técnica explicada de forma clara.
            </p>
          </div>
        </template>

        <div class="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
          <UFormField label="ID do Conhecimento (opcional)" class="md:col-span-6">
            <UInput v-model="explainForm.itemId" placeholder="Ex.: BR-BRAIN-001 ou deixe em branco para escopo geral..." class="w-full font-mono text-xs" />
          </UFormField>
          <UFormField label="Ação a Verificar" class="md:col-span-4">
            <USelect
              v-model="explainForm.action"
              :items="[
                { label: 'Escrita / Edição (write)', value: 'write' },
                { label: 'Leitura / Consulta (read)', value: 'read' },
                { label: 'Aprovação Formal (approve)', value: 'approve' },
                { label: 'Exclusão (delete)', value: 'delete' }
              ]"
              class="w-full text-xs"
            />
          </UFormField>
          <div class="md:col-span-2">
            <UButton block color="primary" icon="i-lucide-help-circle" :loading="loadingExplain" @click="runExplainPermissions">
              Explicar
            </UButton>
          </div>
        </div>
      </UCard>

      <div v-if="explainResult" class="p-4 rounded-xl border border-primary/20 bg-elevated/50 space-y-3 text-xs">
        <div class="flex items-center justify-between">
          <span class="font-bold text-primary">{{ explainResult.targetItem }}</span>
          <UBadge :color="explainResult.canCurrentUserPerform ? 'success' : 'warning'" size="xs" variant="subtle">
            {{ explainResult.canCurrentUserPerform ? 'Você tem permissão ativa' : 'Permissão restrita' }}
          </UBadge>
        </div>
        <p class="text-xs text-highlighted">{{ explainResult.plainLanguageExplanation }}</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-default/50">
          <div>
            <span class="text-[11px] font-semibold text-muted">Política CASL / RLS:</span>
            <p class="font-mono text-xs text-primary">{{ explainResult.policyApplied }}</p>
          </div>
          <div>
            <span class="text-[11px] font-semibold text-muted">Cargos que Podem Executar:</span>
            <div class="flex gap-1 mt-0.5">
              <UBadge v-for="r in explainResult.allowedRoles" :key="r" color="neutral" variant="outline" size="xs">
                {{ r }}
              </UBadge>
            </div>
          </div>
        </div>
      </div>
    </div>

    <AccessAssignmentSlideover
      v-model:open="assignSlideoverOpen"
      :user-id="assignTargetUserId"
      :users="usersList"
      :assignments="assignmentsList"
      :role-options="roleSelectItems"
      :permission-catalog="permissionCatalog"
      @saved="loadAccessData"
    />

    <AccessRoleModal
      v-model:open="roleModalOpen"
      :role="editingRole"
      :permission-catalog="permissionCatalog"
      @saved="loadAccessData"
    />

    <AccessScopeModal
      v-model:open="scopeModalOpen"
      :user="scopeTargetUser"
      @saved="loadAccessData"
    />

    <AccessMcpTokenModal v-model:open="mcpTokenModalOpen" />
  </div>
</template>
