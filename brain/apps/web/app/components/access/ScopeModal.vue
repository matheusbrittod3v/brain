<script setup lang="ts">
import { ALL_POLICIES, type RoleItem, type UnifiedUserRow } from './types'

const props = defineProps<{
  open: boolean
  user?: UnifiedUserRow | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  saved: []
}>()

const { projectId, currentUser, refreshAuthSession, apiFetch, notify } = useBrainApi()

const saving = ref(false)
const loadingOptions = ref(false)
const existingProjects = ref<Array<{ projectId: string; name: string }>>([])
const availableRoles = ref<RoleItem[]>([])
const customProjectInput = ref('')

const form = ref({
  userId: '',
  userName: '',
  allowedProjects: [] as string[],
  allowedPolicies: ['public-org', 'internal-project'] as string[],
  roles: [] as string[],
  revokeActiveSessions: true
})

async function loadOptions() {
  loadingOptions.value = true
  try {
    const pid = encodeURIComponent(projectId.value || '__global__')
    const [projRes, rolesRes] = await Promise.all([
      apiFetch<{ projects?: Array<{ projectId: string; name?: string }> }>('/v1/projects?scope=catalog').catch(() => ({ projects: [] })),
      apiFetch<{ roles?: RoleItem[] }>(`/v1/projects/${pid}/access/roles`).catch(() => ({ roles: [] }))
    ])
    existingProjects.value = (projRes.projects ?? []).map((p) => ({
      projectId: p.projectId,
      name: p.name || p.projectId
    }))
    availableRoles.value = rolesRes.roles ?? []
  } finally {
    loadingOptions.value = false
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen || !props.user) return
    form.value = {
      userId: props.user.id,
      userName: props.user.name,
      allowedProjects: [...(props.user.allowedProjects ?? [])],
      allowedPolicies: [...(props.user.allowedPolicies ?? ['public-org', 'internal-project'])],
      roles: [...(props.user.effectiveRoles ?? [])],
      revokeActiveSessions: true
    }
    customProjectInput.value = ''
    loadOptions()
  }
)

function toggleProject(pid: string) {
  const idx = form.value.allowedProjects.indexOf(pid)
  if (idx >= 0) form.value.allowedProjects.splice(idx, 1)
  else form.value.allowedProjects.push(pid)
}

function addCustomProject() {
  const slug = customProjectInput.value.trim().toLowerCase()
  if (!slug) return
  if (!form.value.allowedProjects.includes(slug)) {
    form.value.allowedProjects.push(slug)
  }
  customProjectInput.value = ''
}

function toggleRole(roleId: string) {
  const idx = form.value.roles.indexOf(roleId)
  if (idx >= 0) form.value.roles.splice(idx, 1)
  else form.value.roles.push(roleId)
}

function togglePolicy(pol: string) {
  const idx = form.value.allowedPolicies.indexOf(pol)
  if (idx >= 0) form.value.allowedPolicies.splice(idx, 1)
  else form.value.allowedPolicies.push(pol)
}

const allKnownProjectIds = computed(() => {
  const map = new Map<string, string>()
  for (const p of existingProjects.value) map.set(p.projectId, p.name)
  for (const pid of form.value.allowedProjects) {
    if (!map.has(pid)) map.set(pid, pid)
  }
  return Array.from(map.entries()).map(([id, name]) => ({ projectId: id, name }))
})

const allKnownRoleIds = computed(() => {
  const set = new Set<string>(['admin', 'tech-lead', 'developer', 'viewer'])
  for (const r of availableRoles.value) set.add(r.roleId)
  for (const r of form.value.roles) set.add(r)
  return Array.from(set)
})

async function saveScopes() {
  if (!form.value.userId) return
  saving.value = true
  try {
    const pid = encodeURIComponent(projectId.value || '__global__')
    const uid = encodeURIComponent(form.value.userId)
    await apiFetch(`/v1/projects/${pid}/access/users/${uid}/scopes`, {
      method: 'PUT',
      body: JSON.stringify({
        allowedProjects: form.value.allowedProjects,
        allowedPolicies: form.value.allowedPolicies,
        roles: form.value.roles.length > 0 ? form.value.roles : undefined,
        revokeActiveSessions: form.value.revokeActiveSessions
      })
    })
    if (currentUser.value?.id === form.value.userId) {
      await refreshAuthSession()
      projectId.value = form.value.allowedProjects[0] ?? ''
    }
    notify(
      'Escopos atualizados',
      form.value.allowedProjects.length > 0
        ? `${form.value.userName} (${form.value.allowedProjects.length} projeto(s) vinculado(s))`
        : `${form.value.userName} (sem projetos vinculados)`,
      'success'
    )
    emit('update:open', false)
    emit('saved')
  } catch (err) {
    notify('Erro ao atualizar escopos', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    :title="`Escopos & Projetos: ${form.userName}`"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <template #body>
      <div class="space-y-4">
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-highlighted">Projetos Existentes (clique nas tags para vincular)</span>
            <UButton
              v-if="form.allowedProjects.length > 0"
              size="xs"
              variant="ghost"
              color="neutral"
              @click="form.allowedProjects = []"
            >
              Limpar (acesso padrão)
            </UButton>
          </div>

          <div v-if="loadingOptions" class="text-xs text-muted">Carregando projetos existentes...</div>
          <div v-else class="flex flex-wrap gap-1.5">
            <UButton
              v-for="proj in allKnownProjectIds"
              :key="proj.projectId"
              size="xs"
              :icon="form.allowedProjects.includes(proj.projectId) ? 'i-lucide-check' : 'i-lucide-plus'"
              :variant="form.allowedProjects.includes(proj.projectId) ? 'solid' : 'outline'"
              :color="form.allowedProjects.includes(proj.projectId) ? 'primary' : 'neutral'"
              @click="toggleProject(proj.projectId)"
            >
              {{ proj.name !== proj.projectId ? `${proj.name} (${proj.projectId})` : proj.projectId }}
            </UButton>
          </div>

          <div class="flex gap-2 pt-1">
            <UInput
              v-model="customProjectInput"
              size="xs"
              placeholder="Adicionar slug de projeto (opcional)"
              class="flex-1 font-mono"
              @keyup.enter="addCustomProject"
            />
            <UButton size="xs" variant="soft" icon="i-lucide-tag" @click="addCustomProject">Adicionar Tag</UButton>
          </div>

          <p class="text-[11px] text-muted">
            {{
              form.allowedProjects.length === 0
                ? 'Sem restrição explícita: o usuário visualiza e acessa automaticamente os projetos existentes do tenant.'
                : `Vinculado explicitamente a ${form.allowedProjects.length} projeto(s).`
            }}
          </p>
        </div>

        <div class="space-y-1.5">
          <div class="text-xs font-medium text-highlighted">Cargos (clique nas tags)</div>
          <div class="flex flex-wrap gap-1.5">
            <UButton
              v-for="roleId in allKnownRoleIds"
              :key="roleId"
              size="xs"
              :icon="form.roles.includes(roleId) ? 'i-lucide-check' : undefined"
              :variant="form.roles.includes(roleId) ? 'solid' : 'outline'"
              :color="form.roles.includes(roleId) ? 'primary' : 'neutral'"
              @click="toggleRole(roleId)"
            >
              {{ roleId }}
            </UButton>
          </div>
        </div>

        <div class="space-y-1.5">
          <div class="text-xs font-medium text-highlighted">Políticas de Confidencialidade Permitidas</div>
          <div class="flex flex-wrap gap-1.5">
            <UButton
              v-for="pol in ALL_POLICIES"
              :key="pol"
              size="xs"
              :variant="form.allowedPolicies.includes(pol) ? 'solid' : 'outline'"
              :color="form.allowedPolicies.includes(pol) ? 'primary' : 'neutral'"
              @click="togglePolicy(pol)"
            >
              {{ pol }}
            </UButton>
          </div>
        </div>

        <UCheckbox
          v-model="form.revokeActiveSessions"
          label="Revogar sessões/tokens ativos do usuário imediatamente"
        />

        <div class="flex justify-end gap-2 pt-3 border-t border-default">
          <UButton color="neutral" variant="ghost" @click="emit('update:open', false)">Cancelar</UButton>
          <UButton :loading="saving" icon="i-lucide-shield-check" @click="saveScopes">
            Salvar Escopos
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
