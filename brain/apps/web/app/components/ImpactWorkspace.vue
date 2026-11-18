<script setup lang="ts">
import { z } from 'zod'

const props = defineProps<{
  knowledgeItems: Array<{ id: string; title: string; type: string }>
}>()

const { projectId, apiFetch, notify } = useBrainApi()

const schema = z.object({
  itemId: z.string().min(1, 'Selecione ou informe o ID do item')
})

const state = reactive({
  itemId: ''
})

interface TraversalHit {
  itemId: string
  projectId: string
  hops: number
  via: string
  isInferred: boolean
}

interface DistributedBlastRadius {
  contractId: string
  impactedProjects: string[]
  impactedServices: Array<{ projectId: string; service: string; relation: string }>
}

interface ImpactRuleRef {
  id: string
  title?: string
  priority: string
}

const loading = ref(false)
const impactResult = ref<{
  riskLevel?: string
  directImpacts?: TraversalHit[]
  transitiveImpacts?: TraversalHit[]
  confirmedImpacts?: TraversalHit[]
  hypotheses?: TraversalHit[]
  criticalRulesImpacted?: ImpactRuleRef[]
  crossServiceImpacts?: DistributedBlastRadius[]
} | null>(null)

async function analyzeImpact() {
  loading.value = true
  try {
    const res = await apiFetch<typeof impactResult.value>(
      `/v1/projects/${encodeURIComponent(projectId.value)}/change/impact`,
      {
        method: 'POST',
        body: JSON.stringify({ targetIds: [state.itemId.trim()] })
      }
    )
    impactResult.value = res
    notify('Análise de impacto concluída')
  } catch (err) {
    notify('Erro na análise de impacto', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}

const riskColor = computed(() => {
  const r = (impactResult.value?.riskLevel ?? '').toLowerCase()
  if (r === 'high' || r === 'critical') return 'error'
  if (r === 'medium') return 'warning'
  return 'success'
})
</script>

<template>
  <div>
    <UiPageHeader
      title="Análise de Impacto & Blast Radius"
      description="Calcule o raio de explosão direto, transitivo e cross-service antes de alterar regras ou contratos"
      icon="i-lucide-zap"
    />

    <div class="space-y-6">
      <UCard>
        <UForm :schema="schema" :state="state" class="grid grid-cols-1 md:grid-cols-12 gap-4 items-end" @submit="analyzeImpact">
          <UFormField label="Item ou Regra Alvo" name="itemId" class="md:col-span-6">
            <UInput v-model="state.itemId" placeholder="Ex.: BR-BRAIN-010 ou ID do item" class="w-full font-mono" />
          </UFormField>

          <UFormField label="Selecionar do Projeto" class="md:col-span-4">
            <USelect
              :items="props.knowledgeItems.map(k => ({ label: `${k.id} — ${k.title}`, value: k.id }))"
              placeholder="Escolher item indexado..."
              class="w-full"
              @update:model-value="(v: string) => { state.itemId = v }"
            />
          </UFormField>

          <div class="md:col-span-2">
            <UButton type="submit" block :loading="loading" icon="i-lucide-zap">
              Analisar
            </UButton>
          </div>
        </UForm>
      </UCard>

      <UiEmptyState
        v-if="!impactResult"
        icon="i-lucide-radar"
        title="Pronto para simular impacto"
        description="Informe ou selecione um ID acima para calcular impactos diretos, transitivos e contratos entre serviços."
      />

      <div v-else class="space-y-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <UiStatCard
            label="Nível de Risco"
            :value="(impactResult.riskLevel || 'low').toUpperCase()"
            icon="i-lucide-alert-triangle"
            :tone="riskColor === 'error' ? 'error' : riskColor === 'warning' ? 'warning' : 'success'"
          />
          <UiStatCard
            label="Impactos Diretos"
            :value="impactResult.directImpacts?.length ?? 0"
            icon="i-lucide-git-commit-horizontal"
            tone="primary"
          />
          <UiStatCard
            label="Impactos Transitivos"
            :value="impactResult.transitiveImpacts?.length ?? 0"
            icon="i-lucide-git-fork"
            tone="warning"
          />
          <UiStatCard
            label="Regras Críticas"
            :value="impactResult.criticalRulesImpacted?.length ?? 0"
            icon="i-lucide-shield-alert"
            tone="error"
          />
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <UCard>
            <template #header>
              <div class="flex items-center justify-between">
                <h3 class="font-semibold text-sm">Nós Diretamente Afetados</h3>
                <UBadge color="primary" variant="subtle" size="xs">{{ impactResult.directImpacts?.length ?? 0 }}</UBadge>
              </div>
            </template>
            <UiEmptyState v-if="!impactResult.directImpacts?.length" compact icon="i-lucide-check-circle" title="Nenhum impacto direto" />
            <div v-else class="space-y-2">
              <div
                v-for="hit in impactResult.directImpacts"
                :key="`${hit.itemId}-${hit.via}`"
                class="flex items-center justify-between p-2.5 rounded-lg border border-default bg-elevated/40"
              >
                <span class="font-mono text-xs font-semibold">{{ hit.itemId }}</span>
                <div class="flex items-center gap-1.5">
                  <UBadge color="neutral" variant="outline" size="xs">{{ hit.via }}</UBadge>
                  <UBadge :color="hit.isInferred ? 'warning' : 'success'" variant="subtle" size="xs">
                    {{ hit.isInferred ? 'Hipótese' : 'Confirmado' }}
                  </UBadge>
                </div>
              </div>
            </div>
          </UCard>

          <UCard>
            <template #header>
              <div class="flex items-center justify-between">
                <h3 class="font-semibold text-sm">Impactos Transitivos</h3>
                <UBadge color="warning" variant="subtle" size="xs">{{ impactResult.transitiveImpacts?.length ?? 0 }}</UBadge>
              </div>
            </template>
            <UiEmptyState v-if="!impactResult.transitiveImpacts?.length" compact icon="i-lucide-check-circle" title="Nenhum impacto transitivo" />
            <div v-else class="space-y-2">
              <div
                v-for="hit in impactResult.transitiveImpacts"
                :key="`${hit.itemId}-${hit.hops}`"
                class="flex items-center justify-between p-2.5 rounded-lg border border-default bg-elevated/40"
              >
                <span class="font-mono text-xs font-semibold">{{ hit.itemId }}</span>
                <div class="flex items-center gap-1.5">
                  <UBadge color="warning" variant="subtle" size="xs">{{ hit.hops }} hops</UBadge>
                  <UBadge color="neutral" variant="outline" size="xs">{{ hit.via }}</UBadge>
                </div>
              </div>
            </div>
          </UCard>
        </div>

        <UCard v-if="impactResult.crossServiceImpacts?.length">
          <template #header>
            <h3 class="font-semibold text-sm">Blast Radius Cross-Service</h3>
          </template>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div
              v-for="cs in impactResult.crossServiceImpacts"
              :key="cs.contractId"
              class="p-3 rounded-xl border border-default bg-elevated/40 space-y-2"
            >
              <div class="font-mono text-xs font-semibold text-primary">{{ cs.contractId }}</div>
              <div class="flex flex-wrap gap-1">
                <UBadge v-for="proj in cs.impactedProjects" :key="proj" color="warning" variant="subtle" size="xs">
                  {{ proj }}
                </UBadge>
              </div>
            </div>
          </div>
        </UCard>
      </div>
    </div>
  </div>
</template>
