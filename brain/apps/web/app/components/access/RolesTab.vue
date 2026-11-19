<script setup lang="ts">
import { SYSTEM_ROLE_IDS, type RoleItem } from './types'

const props = defineProps<{
  roles: RoleItem[]
  canManage: boolean
}>()

const emit = defineEmits<{
  create: []
  edit: [role: RoleItem]
  delete: [roleId: string]
}>()

const search = ref('')

const filteredRoles = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.roles
  return props.roles.filter(
    r => r.roleId.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
  )
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <UInput
        v-model="search"
        size="xs"
        icon="i-lucide-search"
        placeholder="Filtrar cargos por nome ou ID..."
        class="w-64"
      />
      <UButton
        v-if="canManage"
        size="sm"
        variant="soft"
        icon="i-lucide-plus"
        @click="emit('create')"
      >
        Novo Cargo
      </UButton>
    </div>

    <UiEmptyState v-if="filteredRoles.length === 0" icon="i-lucide-shield-off" title="Nenhum cargo encontrado" />
    <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      <div
        v-for="role in filteredRoles"
        :key="role.roleId"
        class="p-4 rounded-xl border border-default bg-default flex flex-col justify-between gap-3"
      >
        <div class="space-y-2">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <h3 class="font-semibold text-sm truncate">{{ role.name }}</h3>
              <code class="text-[11px] text-muted">{{ role.roleId }}</code>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <UBadge color="primary" variant="subtle" size="xs">{{ role.permissions.length }}</UBadge>
              <UButton
                v-if="canManage"
                size="xs"
                variant="ghost"
                icon="i-lucide-pencil"
                title="Editar cargo"
                @click="emit('edit', role)"
              />
              <UButton
                v-if="canManage && !SYSTEM_ROLE_IDS.has(role.roleId)"
                size="xs"
                color="error"
                variant="ghost"
                icon="i-lucide-trash-2"
                title="Excluir cargo"
                @click="emit('delete', role.roleId)"
              />
            </div>
          </div>
          <p class="text-xs text-muted leading-relaxed line-clamp-2">{{ role.description }}</p>
        </div>
        <div class="flex flex-wrap gap-1 pt-2 border-t border-default/60">
          <UBadge v-for="pol in role.allowedPolicies" :key="pol" color="neutral" variant="outline" size="xs">
            {{ pol }}
          </UBadge>
        </div>
      </div>
    </div>
  </div>
</template>

