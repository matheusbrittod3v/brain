<script setup lang="ts">
const { projectId, apiFetch, notify } = useBrainApi()

const activeTab = ref<'radar' | 'debt' | 'compare'>('radar')
const ringFilter = ref<'all' | 'adopt' | 'trial' | 'assess' | 'hold'>('all')
const loading = ref(false)
const enterpriseData = ref<{
  techRadar: Array<{ technology: string; ring: string; projectsCount: number }>
  qaCoverage?: { coveragePercent: number; rows: Array<{ ruleId: string; title: string; covered: boolean; tests: string[] }> }
  health?: { healthScore: number; untestedRuleIds: string[]; staleItemIds: string[] }
} | null>(null)

// Tech Debt Radar
const loadingDebt = ref(false)
const techDebtData = ref<{
  debtHealthScore: number
  summary: {
    totalItems: number
    untestedRulesCount: number
    staleDecisionsCount: number
    activeRisksCount: number
    fragileDependenciesCount: number
  }
  untestedRules: Array<{ id: string; title: string }>
  staleDecisions: Array<{ id: string; title: string; daysSinceUpdate: number }>
  activeRisks: Array<{ id: string; title: string; status: string }>
  fragileDependencies: Array<{ id: string; title: string; type: string }>
} | null>(null)

async function loadTechDebt() {
  if (!projectId.value) return
  loadingDebt.value = true
  try {
    techDebtData.value = await apiFetch<typeof techDebtData.value>(
      `/v1/projects/${encodeURIComponent(projectId.value)}/intelligence/tech-debt-radar`
    )
  } catch (err) {
    notify('Erro ao carregar dívida técnica', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loadingDebt.value = false
  }
}

// Cross-Project Compare
const compareTarget = ref('brain')
const loadingCompare = ref(false)
const compareResult = ref<{
  sourceProjectId: string
  targetProjectId: string
  comparison: { sourceTotalItems: number; targetTotalItems: number; commonPatternsCount: number; reusableCandidatesCount: number }
  commonPatterns: string[]
  reusableCandidates: Array<{ id: string; title: string; type: string; policy: string }>
} | null>(null)

async function runCrossProjectCompare() {
  if (!projectId.value) return
  loadingCompare.value = true
  try {
    compareResult.value = await apiFetch<typeof compareResult.value>(
      `/v1/projects/${encodeURIComponent(projectId.value)}/intelligence/cross-project-compare`,
      {
        method: 'POST',
        body: JSON.stringify({ targetProjectId: compareTarget.value.trim() })
      }
    )
    notify('Comparação entre projetos concluída')
  } catch (err) {
    notify('Erro na comparação', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loadingCompare.value = false
  }
}

async function loadEnterprise() {
  if (!projectId.value) {
    enterpriseData.value = null
    return
  }
  loading.value = true
  try {
    enterpriseData.value = await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/enterprise/views`)
  } catch (err) {
    notify('Erro ao carregar visões corporativas', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}

onMounted(loadEnterprise)
watch(projectId, () => {
  loadEnterprise()
  if (activeTab.value === 'debt') loadTechDebt()
})
watch(activeTab, (tab) => {
  if (tab === 'debt' && !techDebtData.value) loadTechDebt()
  if (tab === 'compare' && !compareResult.value) runCrossProjectCompare()
})

const coverageRows = computed(() => enterpriseData.value?.qaCoverage?.rows ?? [])
const coveragePercent = computed(() => enterpriseData.value?.qaCoverage?.coveragePercent ?? 0)
const healthScore = computed(() => enterpriseData.value?.health?.healthScore ?? 100)

const filteredRadar = computed(() => {
  const list = enterpriseData.value?.techRadar ?? []
  if (ringFilter.value === 'all') return list
  return list.filter(t => t.ring.toLowerCase() === ringFilter.value)
})

function ringColor(ring: string) {
  const r = ring.toLowerCase()
  if (r === 'adopt') return 'success'
  if (r === 'trial') return 'primary'
  if (r === 'assess') return 'warning'
  return 'error'
}
</script>

<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Visões Corporativas, Dívida Técnica &amp; Governança"
      description="Rastreabilidade de regras, Tech Radar, painel de dívida técnica e comparação entre projetos"
      icon="i-lucide-radar"
    >
      <template #actions>
        <UButton size="sm" variant="soft" icon="i-lucide-refresh-cw" :loading="loading || loadingDebt" @click="activeTab === 'debt' ? loadTechDebt() : loadEnterprise()">
          Atualizar
        </UButton>
      </template>
    </UiPageHeader>

    <!-- Sub-tabs -->
    <div class="flex flex-wrap gap-2 border-b border-default pb-3">
      <UButton
        size="sm"
        :variant="activeTab === 'radar' ? 'solid' : 'soft'"
        color="primary"
        icon="i-lucide-cpu"
        @click="activeTab = 'radar'"
      >
        Tech Radar &amp; Cobertura QA
      </UButton>
      <UButton
        size="sm"
        :variant="activeTab === 'debt' ? 'solid' : 'soft'"
        color="primary"
        icon="i-lucide-alert-octagon"
        @click="activeTab = 'debt'"
      >
        Painel de Dívida Técnica &amp; Riscos
      </UButton>
      <UButton
        size="sm"
        :variant="activeTab === 'compare' ? 'solid' : 'soft'"
        color="primary"
        icon="i-lucide-git-compare"
        @click="activeTab = 'compare'"
      >
        Comparação entre Projetos (Multi-Project)
      </UButton>
    </div>

    <!-- TAB 1: TECH RADAR & QA -->
    <div v-if="activeTab === 'radar'" class="space-y-6">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <UiStatCard
          label="Cobertura Global de Regras"
          :value="`${coveragePercent}%`"
          icon="i-lucide-check-check"
          tone="primary"
          :loading="loading"
        >
          <UProgress :model-value="coveragePercent" color="primary" size="xs" class="mt-3" />
        </UiStatCard>

        <UiStatCard
          label="Saúde Arquitetural"
          :value="`${healthScore}%`"
          icon="i-lucide-heart-pulse"
          tone="success"
          :loading="loading"
          :hint="`${enterpriseData?.health?.untestedRuleIds?.length ?? 0} regras sem teste`"
        />

        <UiStatCard
          label="Tecnologias no Radar"
          :value="enterpriseData?.techRadar?.length ?? 0"
          icon="i-lucide-cpu"
          tone="info"
          :loading="loading"
        />
      </div>

      <div class="space-y-6">
        <!-- Rule Test Coverage -->
        <UCard>
          <template #header>
            <div class="flex items-center justify-between gap-4">
              <div>
                <h2 class="font-semibold text-sm">Cobertura de Regras por Testes (VERIFIED_BY)</h2>
                <p class="text-xs text-muted">Rastreabilidade direta entre regras de negócio e suítes de teste</p>
              </div>
              <UBadge :color="coveragePercent >= 80 ? 'success' : 'warning'" variant="subtle" size="sm">
                {{ coverageRows.filter(r => r.covered).length }} / {{ coverageRows.length }} cobertas
              </UBadge>
            </div>
          </template>

          <UiEmptyState
            v-if="coverageRows.length === 0"
            icon="i-lucide-check-check"
            title="Nenhuma regra registrada"
            description="Crie regras com type: 'business_rule' para visualizar a matriz de cobertura."
          />

          <UTable
            v-else
            :data="coverageRows"
            :columns="[
              { accessorKey: 'ruleId', header: 'ID da Regra' },
              { accessorKey: 'title', header: 'Regra de Negócio' },
              { id: 'status', header: 'Cobertura' },
              { id: 'tests', header: 'Testes Vinculados' }
            ]"
          >
            <template #ruleId-cell="{ row }">
              <span class="font-mono text-xs font-semibold">{{ row.original.ruleId }}</span>
            </template>
            <template #status-cell="{ row }">
              <UBadge :color="row.original.covered ? 'success' : 'error'" variant="subtle" size="xs">
                {{ row.original.covered ? 'Coberta' : 'Sem Teste' }}
              </UBadge>
            </template>
            <template #tests-cell="{ row }">
              <div v-if="row.original.tests?.length" class="flex flex-wrap gap-1">
                <UBadge v-for="t in row.original.tests" :key="t" color="neutral" variant="outline" size="xs" class="font-mono">
                  {{ t }}
                </UBadge>
              </div>
              <span v-else class="text-xs text-muted">Nenhum teste associado</span>
            </template>
          </UTable>
        </UCard>

        <!-- Tech Radar -->
        <UCard>
          <template #header>
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 class="font-semibold text-sm">Tech Radar Corporativo</h2>
                <p class="text-xs text-muted">Anéis de adoção tecnológica (Adopt, Trial, Assess, Hold)</p>
              </div>
              <div class="flex flex-wrap gap-1">
                <UButton
                  v-for="r in ['all', 'adopt', 'trial', 'assess', 'hold'] as const"
                  :key="r"
                  size="xs"
                  :variant="ringFilter === r ? 'solid' : 'ghost'"
                  :color="r === 'all' ? 'neutral' : ringColor(r)"
                  class="capitalize"
                  @click="ringFilter = r"
                >
                  {{ r }}
                </UButton>
              </div>
            </div>
          </template>

          <UiEmptyState
            v-if="filteredRadar.length === 0"
            icon="i-lucide-cpu"
            title="Nenhuma tecnologia no filtro"
            description="Alterne o filtro de anel para visualizar as tecnologias mapeadas."
          />

          <div v-else class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            <div
              v-for="item in filteredRadar"
              :key="item.technology"
              class="p-3 rounded-xl border border-default bg-elevated/40 flex items-center justify-between gap-2"
            >
              <div class="min-w-0">
                <div class="font-medium text-xs text-highlighted truncate">{{ item.technology }}</div>
                <div class="text-[11px] text-muted">{{ item.projectsCount }} projeto(s)</div>
              </div>
              <UBadge :color="ringColor(item.ring)" variant="subtle" size="xs" class="capitalize shrink-0">
                {{ item.ring }}
              </UBadge>
            </div>
          </div>
        </UCard>
      </div>
    </div>

    <!-- TAB 2: TECH DEBT & RISKS -->
    <div v-else-if="activeTab === 'debt'" class="space-y-6">
      <div v-if="techDebtData" class="space-y-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <UiStatCard
            label="Score de Saúde Técnica"
            :value="`${techDebtData.debtHealthScore}%`"
            icon="i-lucide-activity"
            :tone="techDebtData.debtHealthScore >= 80 ? 'success' : techDebtData.debtHealthScore >= 60 ? 'warning' : 'error'"
          />
          <UiStatCard
            label="Regras sem Testes"
            :value="techDebtData.summary.untestedRulesCount"
            icon="i-lucide-file-x"
            tone="error"
          />
          <UiStatCard
            label="Decisões Não Revisitadas"
            :value="techDebtData.summary.staleDecisionsCount"
            icon="i-lucide-clock"
            tone="warning"
          />
          <UiStatCard
            label="Riscos Ativos"
            :value="techDebtData.summary.activeRisksCount"
            icon="i-lucide-alert-triangle"
            tone="info"
          />
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <UCard>
            <template #header>
              <h3 class="text-xs font-semibold uppercase tracking-wider text-error">Regras sem Testes Vinculados ({{ techDebtData.untestedRules.length }})</h3>
            </template>
            <div v-if="!techDebtData.untestedRules.length" class="text-xs text-muted">Todas as regras possuem testes.</div>
            <div v-else class="space-y-2 max-h-72 overflow-y-auto">
              <div v-for="r in techDebtData.untestedRules" :key="r.id" class="p-2.5 rounded-lg border border-default bg-elevated/40 flex items-center justify-between">
                <span class="font-mono text-xs font-bold text-primary">{{ r.id }}</span>
                <span class="text-xs text-highlighted truncate max-w-xs">{{ r.title }}</span>
              </div>
            </div>
          </UCard>

          <UCard>
            <template #header>
              <h3 class="text-xs font-semibold uppercase tracking-wider text-warning">Decisões &amp; ADRs Antigos (>60 dias)</h3>
            </template>
            <div v-if="!techDebtData.staleDecisions.length" class="text-xs text-muted">Nenhum ADR desatualizado.</div>
            <div v-else class="space-y-2 max-h-72 overflow-y-auto">
              <div v-for="d in techDebtData.staleDecisions" :key="d.id" class="p-2.5 rounded-lg border border-default bg-elevated/40 flex items-center justify-between">
                <div>
                  <span class="font-mono text-xs font-bold">{{ d.id }}</span>
                  <div class="text-xs text-highlighted truncate max-w-xs">{{ d.title }}</div>
                </div>
                <UBadge color="warning" variant="subtle" size="xs">{{ d.daysSinceUpdate }}d atrás</UBadge>
              </div>
            </div>
          </UCard>
        </div>
      </div>
    </div>

    <!-- TAB 3: CROSS-PROJECT COMPARE -->
    <div v-else-if="activeTab === 'compare'" class="space-y-6">
      <UCard>
        <template #header>
          <h3 class="text-sm font-semibold">Comparação entre Projetos &amp; Reuso de Padrões</h3>
          <p class="text-xs text-muted">Identifique regras e contratos reutilizáveis para promover a projetos globais compartilhados</p>
        </template>
        <div class="flex items-end gap-3 max-w-md">
          <UFormField label="Projeto Alvo para Comparação" class="flex-1">
            <UInput v-model="compareTarget" placeholder="Ex.: brain ou outro projeto" />
          </UFormField>
          <UButton icon="i-lucide-git-compare" :loading="loadingCompare" @click="runCrossProjectCompare">
            Comparar
          </UButton>
        </div>
      </UCard>

      <div v-if="compareResult" class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <UiStatCard label="Padrões em Comum" :value="compareResult.comparison.commonPatternsCount" icon="i-lucide-check-check" tone="success" />
          <UiStatCard label="Candidatos a Reuso" :value="compareResult.comparison.reusableCandidatesCount" icon="i-lucide-share-2" tone="primary" />
          <UiStatCard label="Total no Alvo" :value="compareResult.comparison.targetTotalItems" icon="i-lucide-layers" tone="info" />
        </div>

        <UCard v-if="compareResult.reusableCandidates.length">
          <template #header>
            <h4 class="font-semibold text-sm">Artefatos Candidatos a Reuso do Projeto "{{ compareResult.targetProjectId }}"</h4>
          </template>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div v-for="c in compareResult.reusableCandidates" :key="c.id" class="p-3 rounded-xl border border-default bg-elevated/40 space-y-1">
              <div class="flex items-center justify-between">
                <span class="font-mono text-xs font-bold text-primary">{{ c.id }}</span>
                <UBadge color="neutral" variant="outline" size="xs">{{ c.type }}</UBadge>
              </div>
              <div class="text-xs font-medium text-highlighted">{{ c.title }}</div>
            </div>
          </div>
        </UCard>
      </div>
    </div>
  </div>
</template>
