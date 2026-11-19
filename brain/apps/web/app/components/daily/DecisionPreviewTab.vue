<script setup lang="ts">
const props = defineProps<{
  projectId: string
}>()

const { apiFetch, notify } = useBrainApi()

const optA = reactive({ title: 'Adotar cache distribuído Valkey', description: 'Centralizar cache de busca vetorial e context packs em cluster Valkey 8 com failover' })
const optB = reactive({ title: 'Manter cache em memória LRU local', description: 'Usar cache em memória por nó com replicação periódica' })
const loading = ref(false)
const previewResult = ref<{
  projectId: string
  comparison: {
    optionA: { title: string; riskScore: string; affectedRulesCount: number; affectedRules: string[]; impactedServicesCount: number; pros: string[]; cons: string[] }
    optionB: { title: string; riskScore: string; affectedRulesCount: number; affectedRules: string[]; impactedServicesCount: number; pros: string[]; cons: string[] }
  }
  recommendation: string
  rationale: string
} | null>(null)

async function compareDecisions() {
  if (!props.projectId) return
  loading.value = true
  try {
    previewResult.value = await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/daily/decision-preview`, {
      method: 'POST',
      body: JSON.stringify({ optionA: optA, optionB: optB })
    })
    notify('Prévia de decisão calculada!')
  } catch (err) {
    notify('Erro ao comparar decisões', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <UCard>
      <template #header>
        <div class="space-y-1">
          <h3 class="font-semibold text-sm">Prévia do Impacto de uma Decisão Arquitetural</h3>
          <p class="text-xs text-muted">Compare duas alternativas antes de tomar uma decisão. O Brain mapeia serviços, regras e contratos afetados por cada opção.</p>
        </div>
      </template>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- Option A -->
        <div class="p-3.5 rounded-xl border border-default bg-elevated/40 space-y-2.5">
          <span class="text-xs font-semibold text-primary">Opção A</span>
          <UInput v-model="optA.title" placeholder="Título da Opção A..." size="sm" />
          <UTextarea v-model="optA.description" :rows="3" placeholder="Descrição e proposta técnica..." class="text-xs" />
        </div>

        <!-- Option B -->
        <div class="p-3.5 rounded-xl border border-default bg-elevated/40 space-y-2.5">
          <span class="text-xs font-semibold text-info">Opção B</span>
          <UInput v-model="optB.title" placeholder="Título da Opção B..." size="sm" />
          <UTextarea v-model="optB.description" :rows="3" placeholder="Descrição e proposta técnica..." class="text-xs" />
        </div>
      </div>

      <div class="flex justify-end pt-4">
        <UButton color="primary" icon="i-lucide-git-compare" :loading="loading" @click="compareDecisions">
          Simular &amp; Comparar Impacto
        </UButton>
      </div>
    </UCard>

    <!-- Comparison Results -->
    <div v-if="previewResult" class="space-y-4">
      <div class="p-4 rounded-xl border border-success/30 bg-success/5 space-y-1">
        <div class="flex items-center gap-1.5 text-xs font-semibold text-success">
          <UIcon name="i-lucide-check-check" class="size-4" />
          <span>Opção Recomendada: {{ previewResult.recommendation }}</span>
        </div>
        <p class="text-xs text-highlighted">{{ previewResult.rationale }}</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- Result A -->
        <div class="p-4 rounded-xl border border-default bg-elevated/50 space-y-3 text-xs">
          <div class="flex items-center justify-between">
            <span class="font-bold text-primary">{{ previewResult.comparison.optionA.title }}</span>
            <UBadge
              :color="previewResult.comparison.optionA.riskScore === 'high' ? 'error' : previewResult.comparison.optionA.riskScore === 'medium' ? 'warning' : 'success'"
              variant="subtle"
              size="xs"
            >
              Risco: {{ previewResult.comparison.optionA.riskScore }}
            </UBadge>
          </div>
          <div class="space-y-1">
            <span class="text-[11px] font-semibold text-muted">Regras Afetadas ({{ previewResult.comparison.optionA.affectedRulesCount }}):</span>
            <p v-if="previewResult.comparison.optionA.affectedRules.length === 0" class="text-[11px] text-muted">Nenhuma regra ativa entra em conflito direto.</p>
            <ul v-else class="space-y-0.5">
              <li v-for="(r, idx) in previewResult.comparison.optionA.affectedRules" :key="idx" class="text-[11px] text-highlighted">• {{ r }}</li>
            </ul>
          </div>
          <div class="space-y-1">
            <span class="text-[11px] font-semibold text-muted">Pontos Fortes:</span>
            <ul class="space-y-0.5">
              <li v-for="(p, idx) in previewResult.comparison.optionA.pros" :key="idx" class="text-[11px] text-success">✓ {{ p }}</li>
            </ul>
          </div>
        </div>

        <!-- Result B -->
        <div class="p-4 rounded-xl border border-default bg-elevated/50 space-y-3 text-xs">
          <div class="flex items-center justify-between">
            <span class="font-bold text-info">{{ previewResult.comparison.optionB.title }}</span>
            <UBadge
              :color="previewResult.comparison.optionB.riskScore === 'high' ? 'error' : previewResult.comparison.optionB.riskScore === 'medium' ? 'warning' : 'success'"
              variant="subtle"
              size="xs"
            >
              Risco: {{ previewResult.comparison.optionB.riskScore }}
            </UBadge>
          </div>
          <div class="space-y-1">
            <span class="text-[11px] font-semibold text-muted">Regras Afetadas ({{ previewResult.comparison.optionB.affectedRulesCount }}):</span>
            <p v-if="previewResult.comparison.optionB.affectedRules.length === 0" class="text-[11px] text-muted">Nenhuma regra ativa entra em conflito direto.</p>
            <ul v-else class="space-y-0.5">
              <li v-for="(r, idx) in previewResult.comparison.optionB.affectedRules" :key="idx" class="text-[11px] text-highlighted">• {{ r }}</li>
            </ul>
          </div>
          <div class="space-y-1">
            <span class="text-[11px] font-semibold text-muted">Pontos Fortes:</span>
            <ul class="space-y-0.5">
              <li v-for="(p, idx) in previewResult.comparison.optionB.pros" :key="idx" class="text-[11px] text-info">✓ {{ p }}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
