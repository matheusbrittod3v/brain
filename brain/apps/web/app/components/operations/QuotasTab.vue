<script setup lang="ts">
import { z } from 'zod'
import { formatCompactNumber, type FinOpsDepartmentQuota } from './types'

const props = defineProps<{
  quotas: FinOpsDepartmentQuota[]
  providerCost: number
  initialDowngradeModel?: string
}>()

const emit = defineEmits<{
  refresh: []
}>()

const { projectId, apiFetch, notify } = useBrainApi()

const quotaSchema = z.object({
  department: z.string().min(2, 'Departamento obrigatório'),
  monthlyTokenLimit: z.number().min(0, 'Mínimo 0'),
  monthlyUsdLimit: z.number().min(0, 'Mínimo 0'),
  downgradeModel: z.string().min(1)
})

const quotaState = reactive({
  department: 'engineering',
  monthlyTokenLimit: 1000000,
  monthlyUsdLimit: 100,
  downgradeModel: props.initialDowngradeModel || 'antigravity-cli:gemini-3.8-flash-medium'
})

watch(() => props.initialDowngradeModel, (val) => {
  if (val) quotaState.downgradeModel = val
})

const savingQuota = ref(false)
const customModelMode = ref(false)

const downgradeOptions = [
  'antigravity-cli:gemini-3.8-flash-medium',
  'kimi-coding:kimi-for-coding',
  'ollama:qwen2.5-coder:7b',
  'ollama:llama3.2',
  'gpt-4o-mini',
  'claude-3-5-haiku'
]

async function onSaveQuota() {
  savingQuota.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/finops/quotas`, {
      method: 'PUT',
      body: JSON.stringify(quotaState)
    })
    notify('Cota FinOps salva', `Departamento ${quotaState.department} atualizado.`)
    emit('refresh')
  } catch (err) {
    notify('Erro ao salvar cota', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingQuota.value = false
  }
}

// ROI Simulator
const simLocalPct = ref(40)
const simCachePct = ref(30)
const simMonthlySavings = computed(() => {
  const base = props.providerCost > 0 ? props.providerCost : 12.5
  const local = base * (simLocalPct.value / 100) * 0.92
  const cache = (base - local) * (simCachePct.value / 100) * 0.65
  return (local + cache).toFixed(2)
})
</script>

<template>
  <div class="space-y-5">
    <div v-if="quotas.length > 0" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <UCard v-for="q in quotas" :key="q.department" variant="subtle">
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <span class="font-semibold capitalize">{{ q.department }}</span>
            <UBadge :color="q.withinQuota ? 'success' : 'error'" variant="subtle" size="xs">
              {{ q.withinQuota ? 'Em Conformidade' : 'Downgrade Ativo' }}
            </UBadge>
          </div>

          <div>
            <div class="flex justify-between text-xs text-muted mb-1">
              <span>Tokens</span>
              <span>{{ formatCompactNumber(q.usedTokens ?? 0) }} / {{ formatCompactNumber(q.monthlyTokenLimit) }}</span>
            </div>
            <UProgress
              :model-value="Math.min(100, ((q.usedTokens ?? 0) / Math.max(1, q.monthlyTokenLimit)) * 100)"
              :color="q.withinQuota ? 'primary' : 'error'"
              size="sm"
            />
          </div>

          <div>
            <div class="flex justify-between text-xs text-muted mb-1">
              <span>Orçamento USD</span>
              <span>${{ (q.usedUsd ?? 0).toFixed(2) }} / ${{ q.monthlyUsdLimit.toFixed(2) }}</span>
            </div>
            <UProgress
              :model-value="Math.min(100, ((q.usedUsd ?? 0) / Math.max(1, q.monthlyUsdLimit)) * 100)"
              color="success"
              size="sm"
            />
          </div>

          <div class="text-xs text-muted flex justify-between pt-2 border-t border-default">
            <span>Fallback:</span>
            <code class="text-xs">{{ q.downgradeModel || q.recommendedDowngradeModel || 'ollama:qwen2.5-coder:7b' }}</code>
          </div>
        </div>
      </UCard>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <UCard class="lg:col-span-2">
        <template #header>
          <div class="flex items-center justify-between">
            <div>
              <h3 class="font-semibold text-sm">Configurar Cota por Departamento</h3>
              <p class="text-xs text-muted">Define limites mensais e o modelo econômico de downgrade automático.</p>
            </div>
            <UButton size="xs" variant="ghost" color="neutral" @click="customModelMode = !customModelMode">
              {{ customModelMode ? 'Lista padrão' : 'Modelo customizado' }}
            </UButton>
          </div>
        </template>

        <UForm :schema="quotaSchema" :state="quotaState" class="grid grid-cols-1 sm:grid-cols-2 gap-4" @submit="onSaveQuota">
          <UFormField label="Departamento" name="department">
            <UInput v-model="quotaState.department" placeholder="engineering" class="w-full" />
          </UFormField>
          <UFormField label="Modelo de Downgrade" name="downgradeModel">
            <USelect
              v-if="!customModelMode"
              v-model="quotaState.downgradeModel"
              :items="downgradeOptions"
              class="w-full font-mono text-xs"
            />
            <UInput
              v-else
              v-model="quotaState.downgradeModel"
              placeholder="provider:model"
              class="w-full font-mono text-xs"
            />
          </UFormField>
          <UFormField label="Limite Mensal de Tokens" name="monthlyTokenLimit">
            <UInput v-model.number="quotaState.monthlyTokenLimit" type="number" class="w-full" />
          </UFormField>
          <UFormField label="Limite Mensal (USD)" name="monthlyUsdLimit">
            <UInput v-model.number="quotaState.monthlyUsdLimit" type="number" step="0.01" class="w-full" />
          </UFormField>
          <div class="sm:col-span-2 flex justify-end pt-1">
            <UButton type="submit" :loading="savingQuota" icon="i-lucide-save">Salvar Cota</UButton>
          </div>
        </UForm>
      </UCard>

      <!-- Simulador ROI Compacto -->
      <UCard>
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-calculator" class="size-4 text-primary" />
            <h3 class="font-semibold text-sm">Simulador ROI</h3>
          </div>
        </template>

        <div class="space-y-4">
          <div>
            <div class="flex justify-between text-xs font-medium mb-1.5">
              <span>Modelos Locais / CLI</span>
              <span class="text-primary font-bold">{{ simLocalPct }}%</span>
            </div>
            <USlider v-model="simLocalPct" :min="0" :max="100" />
          </div>
          <div>
            <div class="flex justify-between text-xs font-medium mb-1.5">
              <span>Prompt Caching</span>
              <span class="text-info font-bold">{{ simCachePct }}%</span>
            </div>
            <USlider v-model="simCachePct" :min="0" :max="80" />
          </div>

          <div class="grid grid-cols-2 gap-2.5 pt-2 border-t border-default">
            <div class="p-2.5 rounded-lg border border-default bg-elevated/40">
              <div class="text-[11px] text-muted">Economia / Mês</div>
              <div class="text-lg font-bold text-success mt-0.5">${{ simMonthlySavings }}</div>
            </div>
            <div class="p-2.5 rounded-lg border border-default bg-elevated/40">
              <div class="text-[11px] text-muted">Economia / Ano</div>
              <div class="text-lg font-bold text-primary mt-0.5">${{ (Number(simMonthlySavings) * 12).toFixed(2) }}</div>
            </div>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>

