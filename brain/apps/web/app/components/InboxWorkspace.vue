<script setup lang="ts">
interface ProposalItem {
  id: string
  title?: string
  type?: string
  status: string
  version?: number
  accessPolicyId?: string
  content?: string
  assignedTo?: string
  dueAt?: string
  overdue?: boolean
}

const props = defineProps<{
  proposals: ProposalItem[]
  loading?: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

const { projectId, apiFetch, notify, hasPermission } = useBrainApi()

const filterQuery = ref('')
const selectedId = ref<string | null>(null)
const comment = ref('')
const deciding = ref(false)

const filteredProposals = computed(() => {
  const q = filterQuery.value.trim().toLowerCase()
  if (!q) return props.proposals
  return props.proposals.filter(p => `${p.id} ${p.title ?? ''} ${p.type ?? ''}`.toLowerCase().includes(q))
})

const selectedProposal = computed(() =>
  filteredProposals.value.find(p => p.id === selectedId.value) ?? filteredProposals.value[0] ?? null
)

watch(() => props.proposals, (list) => {
  if (list.length > 0 && (!selectedId.value || !list.some(p => p.id === selectedId.value))) {
    selectedId.value = list[0]!.id
  }
}, { immediate: true })

async function submitDecision(decision: 'approve' | 'reject' | 'request_changes') {
  if (!selectedProposal.value) return
  deciding.value = true
  try {
    await apiFetch(
      `/v1/projects/${encodeURIComponent(projectId.value)}/approvals/${encodeURIComponent(selectedProposal.value.id)}/decision`,
      {
        method: 'POST',
        body: JSON.stringify({
          decision,
          proposalVersion: selectedProposal.value.version ?? 1,
          ...(comment.value.trim() ? { comment: comment.value.trim() } : {}),
          channel: 'web'
        })
      }
    )
    notify(
      decision === 'approve'
        ? 'Proposta aprovada'
        : decision === 'reject'
          ? 'Proposta rejeitada'
          : 'Revisão solicitada'
    )
    comment.value = ''
    emit('refresh')
  } catch (err) {
    notify('Erro na decisão', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    deciding.value = false
  }
}
</script>

<template>
  <div>
    <UiPageHeader
      title="Caixa de Entrada & Aprovações"
      description="Revise propostas pendentes em painel dividido, inspecione alterações e aprove com trilha de auditoria"
      icon="i-lucide-inbox"
    >
      <template #actions>
        <UBadge :color="proposals.length > 0 ? 'warning' : 'success'" variant="subtle" size="sm">
          {{ proposals.length }} pendente(s)
        </UBadge>
        <UButton size="sm" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="emit('refresh')">
          Atualizar
        </UButton>
      </template>
    </UiPageHeader>

    <UCard v-if="proposals.length === 0">
      <UiEmptyState
        icon="i-lucide-check-check"
        title="Caixa de Entrada limpa"
        description="Nenhuma proposta aguardando revisão humana neste projeto."
      />
    </UCard>

    <!-- Split-Pane Dashboard Inbox (nuxt-ui-templates/dashboard pattern) -->
    <div v-else class="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
      <!-- Left Pane: Proposal List -->
      <UCard class="lg:col-span-5" :ui="{ body: 'p-0' }">
        <template #header>
          <UInput v-model="filterQuery" placeholder="Filtrar propostas..." icon="i-lucide-search" size="sm" class="w-full" />
        </template>

        <div class="divide-y divide-default max-h-[540px] overflow-y-auto">
          <button
            v-for="p in filteredProposals"
            :key="p.id"
            type="button"
            class="w-full text-left p-3.5 transition-colors cursor-pointer hover:bg-elevated/60"
            :class="selectedProposal?.id === p.id ? 'bg-primary/10 border-l-2 border-primary' : ''"
            @click="selectedId = p.id"
          >
            <div class="flex items-start justify-between gap-2">
              <span class="font-semibold text-sm line-clamp-1">{{ p.title || p.id }}</span>
              <UBadge v-if="p.overdue" color="error" variant="subtle" size="xs">SLA</UBadge>
            </div>
            <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <UBadge color="neutral" variant="outline" size="xs" class="font-mono">{{ p.id }}</UBadge>
              <UBadge v-if="p.type" color="primary" variant="subtle" size="xs">{{ p.type }}</UBadge>
              <span class="text-[11px] text-muted ml-auto">v{{ p.version ?? 1 }}</span>
            </div>
          </button>
        </div>
      </UCard>

      <!-- Right Pane: Reader & Decision -->
      <UCard v-if="selectedProposal" class="lg:col-span-7">
        <template #header>
          <div class="space-y-1.5">
            <div class="flex items-start justify-between gap-2">
              <h3 class="font-bold text-base">{{ selectedProposal.title || selectedProposal.id }}</h3>
              <UBadge color="warning" variant="subtle" size="xs">{{ selectedProposal.status }}</UBadge>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span class="font-mono">{{ selectedProposal.id }}</span>
              <span>·</span>
              <span>Versão v{{ selectedProposal.version ?? 1 }}</span>
              <span>·</span>
              <span>Política: {{ selectedProposal.accessPolicyId || 'internal-project' }}</span>
              <span v-if="selectedProposal.assignedTo">· Responsável: {{ selectedProposal.assignedTo }}</span>
            </div>
          </div>
        </template>

        <div class="space-y-4">
          <pre class="text-xs whitespace-pre-wrap leading-relaxed bg-elevated/50 p-4 rounded-xl border border-default max-h-80 overflow-y-auto">{{ selectedProposal.content || 'Sem conteúdo textual anexado.' }}</pre>

          <div v-if="hasPermission('proposals:decide')" class="space-y-3 pt-3 border-t border-default">
            <UFormField label="Comentário da Revisão (opcional)">
              <UInput v-model="comment" placeholder="Motivo da aprovação, ajuste ou rejeição..." class="w-full" />
            </UFormField>

            <div class="flex flex-wrap items-center justify-end gap-2">
              <UButton
                size="sm"
                color="error"
                variant="ghost"
                icon="i-lucide-x"
                :loading="deciding"
                @click="submitDecision('reject')"
              >
                Rejeitar
              </UButton>
              <UButton
                size="sm"
                color="warning"
                variant="soft"
                icon="i-lucide-message-square-warning"
                :loading="deciding"
                @click="submitDecision('request_changes')"
              >
                Solicitar Ajustes
              </UButton>
              <UButton
                size="sm"
                color="success"
                variant="solid"
                icon="i-lucide-check"
                :loading="deciding"
                @click="submitDecision('approve')"
              >
                Aprovar Oficialmente
              </UButton>
            </div>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>

