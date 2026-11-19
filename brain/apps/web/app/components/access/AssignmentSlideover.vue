<script setup lang="ts">
import { z } from 'zod'
import { KNOWN_AGENTS, type AssignmentItem, type PermissionItem, type RegisteredUser } from './types'

const props = defineProps<{
  open: boolean
  userId?: string
  users: RegisteredUser[]
  assignments: AssignmentItem[]
  roleOptions: Array<{ label: string; value: string }>
  permissionCatalog: PermissionItem[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  saved: []
}>()

const { projectId, apiFetch, notify } = useBrainApi()

const customUserMode = ref(false)
const showCustomPerms = ref(false)
const permSearch = ref('')
const saving = ref(false)

const assignSchema = z.object({
  userId: z.string().min(1, 'Selecione ou informe o usuário'),
  roleId: z.string().min(1, 'Cargo obrigatório'),
  inheritUserPermissions: z.boolean()
})

const state = reactive({
  userId: '',
  roleId: 'developer',
  linkedAgents: [] as string[],
  customAgentInput: '',
  inheritUserPermissions: true,
  extraPermissions: [] as string[],
  deniedPermissions: [] as string[]
})

const userSelectItems = computed(() =>
  props.users.map(u => ({
    label: u.email ? `${u.name} (${u.email})` : `${u.name} — ${u.id}`,
    value: u.id
  }))
)

const filteredPermissions = computed(() => {
  const q = permSearch.value.trim().toLowerCase()
  if (!q) return props.permissionCatalog
  return props.permissionCatalog.filter(
    p => p.id.toLowerCase().includes(q) || p.label.toLowerCase().includes(q) || p.group.toLowerCase().includes(q)
  )
})

function hydrateFromUser(uid: string) {
  if (!uid) {
    state.roleId = 'developer'
    state.linkedAgents = []
    state.inheritUserPermissions = true
    state.extraPermissions = []
    state.deniedPermissions = []
    return
  }
  const existing = props.assignments.find(a => a.userId === uid)
  if (existing) {
    state.roleId = existing.roleIds[0] || 'developer'
    state.linkedAgents = [...existing.linkedAgentIds]
    state.inheritUserPermissions = existing.inheritUserPermissions
    state.extraPermissions = [...(existing.extraPermissions ?? [])]
    state.deniedPermissions = [...(existing.deniedPermissions ?? [])]
    return
  }
  const user = props.users.find(u => u.id === uid)
  if (user) {
    state.roleId = user.roles[0] || 'developer'
    state.linkedAgents = [...(user.linkedAgentIds ?? [])]
    state.extraPermissions = []
    state.deniedPermissions = []
  }
}

watch(() => props.open, (isOpen) => {
  if (isOpen) {
    customUserMode.value = !props.userId
    state.userId = props.userId || ''
    showCustomPerms.value = false
    permSearch.value = ''
    hydrateFromUser(state.userId)
  }
})

watch(() => state.userId, hydrateFromUser)

function toggleAgentChip(agent: string) {
  const idx = state.linkedAgents.indexOf(agent)
  if (idx >= 0) state.linkedAgents.splice(idx, 1)
  else state.linkedAgents.push(agent)
}

function addCustomAgent() {
  const val = state.customAgentInput.trim()
  if (!val) return
  if (!state.linkedAgents.includes(val)) state.linkedAgents.push(val)
  state.customAgentInput = ''
}

function toggleExtraPerm(permId: string) {
  const idx = state.extraPermissions.indexOf(permId)
  if (idx >= 0) state.extraPermissions.splice(idx, 1)
  else {
    state.extraPermissions.push(permId)
    const deniedIdx = state.deniedPermissions.indexOf(permId)
    if (deniedIdx >= 0) state.deniedPermissions.splice(deniedIdx, 1)
  }
}

function toggleDeniedPerm(permId: string) {
  const idx = state.deniedPermissions.indexOf(permId)
  if (idx >= 0) state.deniedPermissions.splice(idx, 1)
  else {
    state.deniedPermissions.push(permId)
    const extraIdx = state.extraPermissions.indexOf(permId)
    if (extraIdx >= 0) state.extraPermissions.splice(extraIdx, 1)
  }
}

async function onSave() {
  saving.value = true
  try {
    await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/access/assignments/${encodeURIComponent(state.userId.trim())}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          roleIds: [state.roleId],
          linkedAgentIds: state.linkedAgents,
          inheritUserPermissions: state.inheritUserPermissions,
          extraPermissions: state.extraPermissions,
          deniedPermissions: state.deniedPermissions
        })
      }
    )
    notify('Atribuição salva', `${state.userId} atualizado com cargo ${state.roleId}.`)
    emit('update:open', false)
    emit('saved')
  } catch (err) {
    notify('Erro ao salvar atribuição', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <USlideover
    :open="open"
    :title="state.userId ? `Vínculo: ${state.userId}` : 'Vincular Usuário ou Agente'"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <template #body>
      <UForm :schema="assignSchema" :state="state" class="space-y-4" @submit="onSave">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-muted">Identidade</span>
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            @click="customUserMode = !customUserMode; state.userId = ''"
          >
            {{ customUserMode ? 'Selecionar registrado' : 'Digitar ID externo' }}
          </UButton>
        </div>

        <UFormField label="Usuário / Ator" name="userId">
          <USelect
            v-if="!customUserMode"
            v-model="state.userId"
            :items="userSelectItems"
            placeholder="Selecione um usuário..."
            class="w-full"
          />
          <UInput
            v-else
            v-model="state.userId"
            placeholder="ID do usuário ou agente externo..."
            class="w-full font-mono text-xs"
          />
        </UFormField>

        <UFormField label="Cargo Base (RBAC / CASL)" name="roleId">
          <USelect v-model="state.roleId" :items="roleOptions" class="w-full" />
        </UFormField>

        <div class="space-y-2 pt-2 border-t border-default">
          <div class="text-xs font-medium text-highlighted">Agentes Human-in-the-Loop</div>
          <div class="flex flex-wrap gap-1.5">
            <UButton
              v-for="agent in KNOWN_AGENTS"
              :key="agent"
              size="xs"
              :variant="state.linkedAgents.includes(agent) ? 'solid' : 'outline'"
              :color="state.linkedAgents.includes(agent) ? 'primary' : 'neutral'"
              icon="i-lucide-bot"
              @click="toggleAgentChip(agent)"
            >
              {{ agent }}
            </UButton>
          </div>
          <div class="flex items-center gap-1.5">
            <UInput
              v-model="state.customAgentInput"
              placeholder="Outro agente..."
              size="xs"
              class="flex-1 font-mono"
              @keyup.enter.prevent="addCustomAgent"
            />
            <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="addCustomAgent">Adicionar</UButton>
          </div>
        </div>

        <UCheckbox
          v-model="state.inheritUserPermissions"
          label="Agentes vinculados herdam permissões do usuário"
        />

        <div v-if="permissionCatalog.length > 0" class="space-y-2 pt-2 border-t border-default">
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            :icon="showCustomPerms ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            @click="showCustomPerms = !showCustomPerms"
          >
            Exceções de Permissão (+{{ state.extraPermissions.length }} / -{{ state.deniedPermissions.length }})
          </UButton>

          <div v-if="showCustomPerms" class="space-y-2">
            <UInput v-model="permSearch" size="xs" icon="i-lucide-search" placeholder="Filtrar permissões..." class="w-full" />
            <div class="space-y-1 max-h-56 overflow-y-auto pr-1">
              <div
                v-for="perm in filteredPermissions"
                :key="perm.id"
                class="flex items-center justify-between gap-2 text-xs px-2 py-1 rounded border border-default/60 bg-elevated/30"
              >
                <span class="truncate" :title="perm.id">{{ perm.label }}</span>
                <div class="flex items-center gap-1 shrink-0">
                  <UButton
                    size="xs"
                    :variant="state.extraPermissions.includes(perm.id) ? 'solid' : 'ghost'"
                    color="success"
                    @click="toggleExtraPerm(perm.id)"
                  >
                    +
                  </UButton>
                  <UButton
                    size="xs"
                    :variant="state.deniedPermissions.includes(perm.id) ? 'solid' : 'ghost'"
                    color="error"
                    @click="toggleDeniedPerm(perm.id)"
                  >
                    -
                  </UButton>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-3 border-t border-default">
          <UButton color="neutral" variant="ghost" @click="emit('update:open', false)">Cancelar</UButton>
          <UButton type="submit" :loading="saving" icon="i-lucide-save">Salvar Vínculo</UButton>
        </div>
      </UForm>
    </template>
  </USlideover>
</template>

