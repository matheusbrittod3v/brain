<script setup lang="ts">
import type { UnifiedUserRow } from './types'

const props = defineProps<{
  users: UnifiedUserRow[]
  roleOptions: Array<{ label: string; value: string }>
  canAssign: boolean
  currentUserId?: string
}>()

const emit = defineEmits<{
  editAssignment: [userId: string]
  editScopes: [user: UnifiedUserRow]
  quickGrant: [userId: string]
  deleteAssignment: [userId: string]
  deleteUser: [userId: string]
}>()

const confirmDeleteUserId = ref<string | null>(null)

const search = ref('')
const roleFilter = ref('all')

const roleFilterItems = computed(() => [
  { label: 'Todos os cargos', value: 'all' },
  ...props.roleOptions
])

const filteredUsers = computed(() => {
  const q = search.value.trim().toLowerCase()
  return props.users.filter((u) => {
    if (roleFilter.value !== 'all' && !u.effectiveRoles.includes(roleFilter.value)) return false
    if (!q) return true
    return (
      u.id.toLowerCase().includes(q) ||
      u.name.toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      u.effectiveRoles.some(r => r.toLowerCase().includes(q))
    )
  })
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 class="font-semibold text-sm">Usuários, Cargos &amp; Agentes Vinculados</h3>
          <p class="text-xs text-muted">Gerencie cargos RBAC, agentes Human-in-the-Loop, escopos de projeto ou acesso temporário.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UInput
            v-model="search"
            size="xs"
            icon="i-lucide-search"
            placeholder="Buscar usuário ou cargo..."
            class="w-48"
          />
          <USelect
            v-model="roleFilter"
            :items="roleFilterItems"
            size="xs"
            class="w-44"
          />
        </div>
      </div>
    </template>

    <UiEmptyState
      v-if="filteredUsers.length === 0"
      compact
      icon="i-lucide-user-x"
      title="Nenhum usuário encontrado"
      description="Ajuste os filtros ou vincule um ator externo pelo botão acima."
    />

    <UTable
      v-else
      :data="filteredUsers"
      :columns="[
        { accessorKey: 'name', header: 'Usuário' },
        { accessorKey: 'roles', header: 'Cargo(s)' },
        { accessorKey: 'agents', header: 'Agentes & Escopo' },
        { id: 'actions', header: '' }
      ]"
    >
      <template #name-cell="{ row }">
        <div>
          <div class="flex items-center gap-1.5">
            <span class="font-medium text-sm text-highlighted">{{ row.original.name }}</span>
            <UBadge v-if="row.original.source" size="xs" variant="outline" color="neutral">
              {{ row.original.source }}
            </UBadge>
          </div>
          <div class="text-[11px] text-muted font-mono">{{ row.original.email || row.original.id }}</div>
        </div>
      </template>

      <template #roles-cell="{ row }">
        <div class="flex flex-wrap items-center gap-1">
          <UBadge v-for="r in row.original.effectiveRoles" :key="r" size="xs" variant="subtle" color="primary">
            {{ r }}
          </UBadge>
          <UBadge v-if="row.original.assignment?.extraPermissions?.length" size="xs" variant="soft" color="success">
            +{{ row.original.assignment.extraPermissions.length }}
          </UBadge>
          <UBadge v-if="row.original.assignment?.deniedPermissions?.length" size="xs" variant="soft" color="error">
            -{{ row.original.assignment.deniedPermissions.length }}
          </UBadge>
        </div>
      </template>

      <template #agents-cell="{ row }">
        <div class="flex flex-wrap items-center gap-1">
          <UBadge
            v-for="ag in row.original.effectiveAgents"
            :key="ag"
            color="info"
            variant="soft"
            size="xs"
            class="font-mono"
          >
            {{ ag }}
          </UBadge>
          <UBadge
            v-if="row.original.allowedProjects?.length"
            color="neutral"
            variant="outline"
            size="xs"
          >
            {{ row.original.allowedProjects.length }} projeto(s)
          </UBadge>
          <span v-if="!row.original.effectiveAgents.length && !row.original.allowedProjects?.length" class="text-xs text-muted">
            Padrão da sessão
          </span>
        </div>
      </template>

      <template #actions-cell="{ row }">
        <div class="flex items-center justify-end gap-1">
          <UButton
            size="xs"
            variant="soft"
            icon="i-lucide-user-cog"
            @click="emit('editAssignment', row.original.id)"
          >
            Vínculo
          </UButton>
          <UButton
            v-if="canAssign"
            size="xs"
            variant="outline"
            icon="i-lucide-folder-lock"
            title="Projetos & Políticas"
            @click="emit('editScopes', row.original)"
          >
            Escopos
          </UButton>
          <UButton
            size="xs"
            variant="ghost"
            color="warning"
            icon="i-lucide-clock"
            title="Conceder acesso temporário Just-In-Time"
            @click="emit('quickGrant', row.original.id)"
          />
          <UButton
            v-if="row.original.assignment"
            size="xs"
            color="error"
            variant="ghost"
            icon="i-lucide-trash-2"
            title="Remover atribuição do projeto"
            @click="emit('deleteAssignment', row.original.id)"
          />
          <template v-if="canAssign && row.original.source === 'registered' && row.original.id !== currentUserId">
            <UButton
              v-if="confirmDeleteUserId === row.original.id"
              size="xs"
              color="error"
              variant="solid"
              icon="i-lucide-user-x"
              @click="confirmDeleteUserId = null; emit('deleteUser', row.original.id)"
            >
              Confirmar
            </UButton>
            <UButton
              v-else
              size="xs"
              color="error"
              variant="soft"
              icon="i-lucide-user-minus"
              title="Excluir usuário do sistema e revogar tokens"
              @click="confirmDeleteUserId = row.original.id"
            >
              Excluir
            </UButton>
          </template>
        </div>
      </template>
    </UTable>
  </UCard>
</template>

