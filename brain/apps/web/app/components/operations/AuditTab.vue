<script setup lang="ts">
import type { AuditLogItem } from './types'

const props = defineProps<{
  auditLogs: AuditLogItem[]
}>()

const auditSearch = ref('')
const actorFilter = ref<'all' | 'agent' | 'human'>('all')
const inspectedLog = ref<AuditLogItem | null>(null)
const copied = ref(false)

const filteredAuditLogs = computed(() => {
  return props.auditLogs.filter((log) => {
    const isAgent = log.actorType === 'agent' || log.actorId.toLowerCase().includes('agent')
    if (actorFilter.value === 'agent' && !isAgent) return false
    if (actorFilter.value === 'human' && isAgent) return false
    if (auditSearch.value.trim()) {
      const q = auditSearch.value.trim().toLowerCase()
      return `${log.actorId} ${log.action} ${log.targetType} ${log.targetId}`.toLowerCase().includes(q)
    }
    return true
  })
})

const auditColumns = [
  { accessorKey: 'createdAt', header: 'Quando' },
  { accessorKey: 'actorId', header: 'Ator' },
  { accessorKey: 'action', header: 'Ação' },
  { accessorKey: 'targetType', header: 'Alvo' },
  { accessorKey: 'targetId', header: 'ID' },
  { id: 'actions', header: '' }
]

function copyInspectedJson() {
  if (!inspectedLog.value || typeof navigator === 'undefined' || !navigator.clipboard) return
  navigator.clipboard.writeText(JSON.stringify(inspectedLog.value, null, 2))
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}
</script>

<template>
  <div>
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <UInput
            v-model="auditSearch"
            placeholder="Filtrar por ator, ação ou alvo..."
            icon="i-lucide-search"
            class="w-72"
            size="xs"
          />
          <UiSegmentedTabs
            v-model="actorFilter"
            :items="[
              { label: 'Todos', value: 'all' },
              { label: 'Agentes', value: 'agent', icon: 'i-lucide-bot' },
              { label: 'Humanos', value: 'human', icon: 'i-lucide-user' }
            ]"
          />
        </div>
      </template>

      <UiEmptyState
        v-if="filteredAuditLogs.length === 0"
        compact
        icon="i-lucide-scroll-text"
        title="Nenhum evento de auditoria encontrado"
      />

      <UTable v-else :data="filteredAuditLogs" :columns="auditColumns">
        <template #createdAt-cell="{ row }">
          <span class="text-xs text-muted">
            {{ new Date(row.original.createdAt || row.original.timestamp || '').toLocaleString('pt-BR') }}
          </span>
        </template>
        <template #actorId-cell="{ row }">
          <span class="font-mono text-xs">{{ row.original.actorId }}</span>
        </template>
        <template #action-cell="{ row }">
          <UBadge
            :color="/delete|reject|revoke/i.test(row.original.action) ? 'error' : /create|approve/i.test(row.original.action) ? 'success' : 'primary'"
            variant="subtle"
            size="xs"
          >
            {{ row.original.action }}
          </UBadge>
        </template>
        <template #targetId-cell="{ row }">
          <span class="font-mono text-xs text-muted">{{ row.original.targetId }}</span>
        </template>
        <template #actions-cell="{ row }">
          <UButton size="xs" variant="ghost" icon="i-lucide-eye" @click="inspectedLog = row.original">
            Inspecionar
          </UButton>
        </template>
      </UTable>
    </UCard>

    <USlideover
      :open="Boolean(inspectedLog)"
      title="Detalhes do Evento de Auditoria"
      @update:open="(val: boolean) => { if (!val) inspectedLog = null }"
    >
      <template #body>
        <div v-if="inspectedLog" class="space-y-3">
          <div class="flex justify-end">
            <UButton
              size="xs"
              variant="outline"
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              @click="copyInspectedJson"
            >
              {{ copied ? 'Copiado' : 'Copiar JSON' }}
            </UButton>
          </div>
          <pre class="text-xs font-mono bg-slate-950 p-4 rounded-lg border border-default overflow-auto">{{ JSON.stringify(inspectedLog, null, 2) }}</pre>
        </div>
      </template>
    </USlideover>
  </div>
</template>

