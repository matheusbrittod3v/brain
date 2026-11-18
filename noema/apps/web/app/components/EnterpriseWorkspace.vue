<script setup lang="ts">
const { projectId, apiFetch, notify } = useNoemaApi()

const ringFilter = ref<'all' | 'adopt' | 'trial' | 'assess' | 'hold'>('all')
const loading = ref(false)
const enterpriseData = ref<{
  techRadar: Array<{ technology: string; ring: string; projectsCount: number }>
  qaCoverage?: { coveragePercent: number; rows: Array<{ ruleId: string; title: string; covered: boolean; tests: string[] }> }
  health?: { healthScore: number; untestedRuleIds: string[]; staleItemIds: string[] }
} | null>(null)

async function loadEnterprise() {
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
watch(projectId, loadEnterprise)

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
  <div>
    <UiPageHeader
      title="Visões Corporativas & Governança"
      description="Rastreabilidade de regras por testes (VERIFIED_BY), saúde arquitetural e Tech Radar"
      icon="i-lucide-radar"
    >
      <template #actions>
        <UButton size="sm" variant="soft" icon="i-lucide-refresh-cw" :loading="loading" @click="loadEnterprise">
          Atualizar
        </UButton>
      </template>
    </UiPageHeader>

    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
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
            <UBadge color="primary" variant="subtle" size="sm">{{ coverageRows.length }} regras</UBadge>
          </div>
        </template>

        <UiEmptyState
          v-if="coverageRows.length === 0"
          compact
          icon="i-lucide-file-check-2"
          title="Nenhuma regra de negócio catalogada"
          description="Adicione regras de negócio para acompanhar a cobertura por testes."
        />
        <UTable
          v-else
          :data="coverageRows"
          :columns="[
            { accessorKey: 'ruleId', header: 'Regra' },
            { accessorKey: 'title', header: 'Título' },
            { accessorKey: 'tests', header: 'Testes Vinculados' },
            { accessorKey: 'covered', header: 'Status' }
          ]"
        >
          <template #ruleId-cell="{ row }">
            <span class="font-mono text-xs font-semibold">{{ row.original.ruleId }}</span>
          </template>
          <template #tests-cell="{ row }">
            <div class="flex flex-wrap gap-1">
              <UBadge v-for="t in row.original.tests" :key="t" color="neutral" variant="outline" size="xs" class="font-mono">
                {{ t }}
              </UBadge>
              <span v-if="!row.original.tests?.length" class="text-xs text-muted">—</span>
            </div>
          </template>
          <template #covered-cell="{ row }">
            <UBadge :color="row.original.covered ? 'success' : 'error'" variant="subtle" size="xs">
              {{ row.original.covered ? 'Verificada' : 'Sem Teste' }}
            </UBadge>
          </template>
        </UTable>
      </UCard>

      <!-- Tech Radar -->
      <UCard>
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="font-semibold text-sm">Tech Radar Corporativo</h2>
              <p class="text-xs text-muted">Tags, frameworks e padrões extraídos dos itens do projeto</p>
            </div>
            <USelect v-model="ringFilter" :items="['all', 'adopt', 'trial', 'assess', 'hold']" size="sm" class="w-32" />
          </div>
        </template>

        <UiEmptyState
          v-if="filteredRadar.length === 0"
          compact
          icon="i-lucide-radar"
          title="Nenhum item no Tech Radar"
          description="Adicione tags às ADRs e documentos técnicos para popular o Tech Radar."
        />
        <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div
            v-for="item in filteredRadar"
            :key="item.technology"
            class="p-3.5 rounded-xl border border-default bg-elevated/40 flex items-center justify-between gap-3"
          >
            <div class="min-w-0">
              <div class="font-semibold text-sm truncate">{{ item.technology }}</div>
              <div class="text-xs text-muted mt-0.5">{{ item.projectsCount }} projeto(s)</div>
            </div>
            <UBadge :color="ringColor(item.ring)" variant="subtle" size="xs" class="uppercase shrink-0">
              {{ item.ring }}
            </UBadge>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>
