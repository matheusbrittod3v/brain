<script setup lang="ts">
import { ALL_POLICIES, type PermissionItem, type RoleItem } from './types'

const props = defineProps<{
  open: boolean
  role?: RoleItem | null
  permissionCatalog: PermissionItem[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  saved: []
}>()

const { projectId, apiFetch, notify } = useBrainApi()

const saving = ref(false)
const permSearch = ref('')

const form = reactive({
  roleId: '',
  name: '',
  description: '',
  permissions: [] as string[],
  allowedPolicies: ['public-org', 'internal-project'] as string[],
  isNew: true
})

watch(() => props.open, (isOpen) => {
  if (!isOpen) return
  permSearch.value = ''
  if (props.role) {
    form.roleId = props.role.roleId
    form.name = props.role.name
    form.description = props.role.description
    form.permissions = [...props.role.permissions]
    form.allowedPolicies = [...props.role.allowedPolicies]
    form.isNew = false
  } else {
    form.roleId = ''
    form.name = ''
    form.description = ''
    form.permissions = ['menu:projects', 'menu:knowledge', 'knowledge:view', 'knowledge:read']
    form.allowedPolicies = ['public-org', 'internal-project']
    form.isNew = true
  }
})

const permissionGroups = computed(() => {
  const q = permSearch.value.trim().toLowerCase()
  const map = new Map<string, Array<{ id: string; label: string }>>()
  for (const p of props.permissionCatalog) {
    if (q && !p.id.toLowerCase().includes(q) && !p.label.toLowerCase().includes(q) && !p.group.toLowerCase().includes(q)) {
      continue
    }
    const arr = map.get(p.group) ?? []
    arr.push({ id: p.id, label: p.label })
    map.set(p.group, arr)
  }
  return [...map.entries()].map(([group, items]) => ({ group, items }))
})

function togglePerm(permId: string) {
  const idx = form.permissions.indexOf(permId)
  if (idx >= 0) form.permissions.splice(idx, 1)
  else form.permissions.push(permId)
}

function toggleGroupPerms(items: Array<{ id: string }>) {
  const allSelected = items.every(i => form.permissions.includes(i.id))
  if (allSelected) {
    const removeSet = new Set(items.map(i => i.id))
    form.permissions = form.permissions.filter(p => !removeSet.has(p))
  } else {
    for (const item of items) {
      if (!form.permissions.includes(item.id)) form.permissions.push(item.id)
    }
  }
}

function togglePolicy(pol: string) {
  const idx = form.allowedPolicies.indexOf(pol)
  if (idx >= 0 && form.allowedPolicies.length > 1) form.allowedPolicies.splice(idx, 1)
  else if (idx < 0) form.allowedPolicies.push(pol)
}

async function saveRole() {
  if (!form.roleId.trim() || !form.name.trim()) {
    notify('Informe ID e Nome do cargo', undefined, 'warning')
    return
  }
  saving.value = true
  try {
    await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/access/roles/${encodeURIComponent(form.roleId.trim())}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim(),
          permissions: form.permissions,
          allowedPolicies: form.allowedPolicies
        })
      }
    )
    notify('Cargo salvo', `${form.name} atualizado com ${form.permissions.length} permissões.`)
    emit('update:open', false)
    emit('saved')
  } catch (err) {
    notify('Erro ao salvar cargo', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    :title="form.isNew ? 'Novo Cargo CASL' : `Editar Cargo: ${form.name}`"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <template #body>
      <div class="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <UFormField label="ID do Cargo (slug)">
            <UInput v-model="form.roleId" :disabled="!form.isNew" placeholder="ex: qa-reviewer" class="w-full font-mono text-xs" />
          </UFormField>
          <UFormField label="Nome">
            <UInput v-model="form.name" placeholder="Ex.: Revisor de QA" class="w-full text-xs" />
          </UFormField>
        </div>
        <UFormField label="Descrição">
          <UInput v-model="form.description" placeholder="O que este cargo pode fazer..." class="w-full text-xs" />
        </UFormField>

        <div class="space-y-1.5">
          <div class="text-xs font-medium text-muted">Políticas de Confidencialidade Permitidas</div>
          <div class="flex flex-wrap gap-1.5">
            <UButton
              v-for="pol in ALL_POLICIES"
              :key="pol"
              size="xs"
              :variant="form.allowedPolicies.includes(pol) ? 'soft' : 'outline'"
              :color="form.allowedPolicies.includes(pol) ? 'primary' : 'neutral'"
              @click="togglePolicy(pol)"
            >
              {{ pol }}
            </UButton>
          </div>
        </div>

        <UInput v-model="permSearch" size="xs" icon="i-lucide-search" placeholder="Filtrar permissões do cargo..." class="w-full" />

        <div v-for="grp in permissionGroups" :key="grp.group" class="space-y-2 pt-2 border-t border-default">
          <div class="flex items-center justify-between">
            <div class="text-xs font-semibold text-primary">{{ grp.group }}</div>
            <UButton size="xs" variant="ghost" color="neutral" @click="toggleGroupPerms(grp.items)">
              Alternar grupo
            </UButton>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            <label
              v-for="perm in grp.items"
              :key="perm.id"
              class="flex items-center gap-2 text-xs p-1.5 rounded-lg border border-default cursor-pointer hover:bg-elevated/60"
            >
              <input
                type="checkbox"
                :checked="form.permissions.includes(perm.id)"
                class="accent-indigo-500"
                @change="togglePerm(perm.id)"
              >
              <span class="truncate" :title="perm.id">{{ perm.label }}</span>
            </label>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-3 border-t border-default">
          <UButton color="neutral" variant="ghost" @click="emit('update:open', false)">Cancelar</UButton>
          <UButton :loading="saving" icon="i-lucide-save" @click="saveRole">Salvar Cargo</UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>

