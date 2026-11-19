<script setup lang="ts">
const props = defineProps<{
  projectId: string
}>()

const open = defineModel<boolean>('open', { default: false })
const { apiFetch, notify } = useBrainApi()

const period = ref<'24h' | '48h' | '7d'>('24h')
const loading = ref(false)
const data = ref<{
  period: string
  summary: string
  stats: { totalChanged: number; newOrUpdatedRules: number; decisionsChanged: number; docsChanged: number; auditEvents: number }
  rulesChanged: Array<{ id: string; title: string; status: string; updatedAt: string }>
  decisionsChanged: Array<{ id: string; title: string; status: string; updatedAt: string }>
  docsChanged: Array<{ id: string; title: string; type: string; updatedAt: string }>
  recentAuditActions: Array<{ action: string; actor: string; target: string; time: string }>
} | null>(null)

async function loadChanges() {
  if (!props.projectId) return
  loading.value = true
  try {
    data.value = await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/daily/what-changed?period=${period.value}`)
  } catch (err) {
    notify('Erro ao buscar mudanças diárias', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}

watch(period, () => {
  loadChanges()
})

watch(open, (isOpen) => {
  if (isOpen && !data.value) {
    loadChanges()
  }
})
</script>

<template>
  <UModal v-model:open="open" title="O que mudou no projeto?" class="max-w-3xl">
    <template #body>
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-3">
          <p class="text-xs text-muted">Resumo de alterações em regras, decisões, documentos e ações recentes.</p>
          <UiSegmentedTabs
            v-model="period"
            :items="[
              { label: 'Últimas 24h', value: '24h' },
              { label: '48h', value: '48h' },
              { label: '7 dias', value: '7d' }
            ]"
          />
        </div>

        <div v-if="loading" class="p-8 text-center text-xs text-muted">
          <UIcon name="i-lucide-loader-2" class="size-5 animate-spin mx-auto mb-2 text-primary" />
          Carregando mudanças...
        </div>

        <div v-else-if="data" class="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div class="p-3.5 rounded-xl border border-primary/20 bg-primary/5 text-xs text-highlighted">
            <span class="font-semibold text-primary">Resumo Executivo: </span>
            {{ data.summary }}
          </div>

          <!-- Cards de estatísticas -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div class="p-2.5 rounded-lg border border-default bg-elevated/40 text-center">
              <span class="text-[10px] text-muted uppercase">Total Alterado</span>
              <p class="text-lg font-bold text-primary">{{ data.stats.totalChanged }}</p>
            </div>
            <div class="p-2.5 rounded-lg border border-default bg-elevated/40 text-center">
              <span class="text-[10px] text-muted uppercase">Regras</span>
              <p class="text-lg font-bold text-warning">{{ data.stats.newOrUpdatedRules }}</p>
            </div>
            <div class="p-2.5 rounded-lg border border-default bg-elevated/40 text-center">
              <span class="text-[10px] text-muted uppercase">Decisões ADR</span>
              <p class="text-lg font-bold text-info">{{ data.stats.decisionsChanged }}</p>
            </div>
            <div class="p-2.5 rounded-lg border border-default bg-elevated/40 text-center">
              <span class="text-[10px] text-muted uppercase">Eventos</span>
              <p class="text-lg font-bold text-success">{{ data.stats.auditEvents }}</p>
            </div>
          </div>

          <!-- Regras alteradas -->
          <div v-if="data.rulesChanged.length > 0" class="space-y-1.5">
            <h4 class="text-xs font-semibold text-warning flex items-center gap-1.5">
              <UIcon name="i-lucide-shield-alert" class="size-3.5" />
              Regras Modificadas ({{ data.rulesChanged.length }})
            </h4>
            <div class="space-y-1">
              <div
                v-for="r in data.rulesChanged"
                :key="r.id"
                class="flex items-center justify-between text-xs p-2 rounded-lg border border-default bg-elevated/30"
              >
                <span class="truncate font-medium">{{ r.title }}</span>
                <UBadge color="warning" variant="subtle" size="xs">{{ r.status }}</UBadge>
              </div>
            </div>
          </div>

          <!-- Decisões alteradas -->
          <div v-if="data.decisionsChanged.length > 0" class="space-y-1.5">
            <h4 class="text-xs font-semibold text-info flex items-center gap-1.5">
              <UIcon name="i-lucide-git-commit" class="size-3.5" />
              Decisões de Arquitetura ({{ data.decisionsChanged.length }})
            </h4>
            <div class="space-y-1">
              <div
                v-for="d in data.decisionsChanged"
                :key="d.id"
                class="flex items-center justify-between text-xs p-2 rounded-lg border border-default bg-elevated/30"
              >
                <span class="truncate font-medium">{{ d.title }}</span>
                <UBadge color="info" variant="subtle" size="xs">{{ d.status }}</UBadge>
              </div>
            </div>
          </div>

          <!-- Ações Recentes -->
          <div v-if="data.recentAuditActions.length > 0" class="space-y-1.5">
            <h4 class="text-xs font-semibold text-muted flex items-center gap-1.5">
              <UIcon name="i-lucide-history" class="size-3.5" />
              Últimas Ações Registradas
            </h4>
            <div class="space-y-1">
              <div
                v-for="(a, idx) in data.recentAuditActions"
                :key="idx"
                class="flex items-center justify-between text-xs p-2 rounded-lg border border-default bg-elevated/20 font-mono text-[11px]"
              >
                <div class="flex items-center gap-2 truncate">
                  <UBadge size="xs" color="neutral" variant="outline">{{ a.action }}</UBadge>
                  <span class="truncate text-highlighted">{{ a.target }}</span>
                </div>
                <span class="text-muted shrink-0 text-[10px]">{{ a.actor }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
