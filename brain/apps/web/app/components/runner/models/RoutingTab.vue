<script setup lang="ts">
import type { RoutingTarget, RunnerProviderItem } from './types'

const props = defineProps<{
  primary: RoutingTarget
  secondary: RoutingTarget
  fallbacks: RoutingTarget[]
  providers: RunnerProviderItem[]
  providerOptions: Array<{ label: string; value: string }>
  testingPrimary: boolean
  testingSecondary: boolean
  secondaryTestResult: { ok: boolean; latencyMs?: number; preview?: string; error?: string } | null
}>()

const emit = defineEmits<{
  'update:primary': [value: RoutingTarget]
  'update:secondary': [value: RoutingTarget]
  'update:fallbacks': [value: RoutingTarget[]]
  testPrimary: []
  testSecondary: []
  swap: []
  selectSecondary: [providerId: string, modelId: string]
}>()

const newFallback = ref<RoutingTarget>({ provider: 'ollama', model: 'gemma2:2b' })
const manualModelMode = reactive({
  primary: false,
  secondary: false,
  newFallback: false
})

function modelsForProvider(providerId: string): string[] {
  const found = props.providers.find(p => p.id === providerId)
  if (!found) return []
  const list = (found.models || []).filter(m => !m.disabled).map(m => m.id)
  for (const d of found.discoveredModels || []) {
    if (!list.includes(d)) list.push(d)
  }
  return list
}

function addFallback() {
  if (!newFallback.value.provider || !newFallback.value.model) return
  emit('update:fallbacks', [...props.fallbacks, { ...newFallback.value }])
}

function moveFallback(index: number, delta: -1 | 1) {
  const target = index + delta
  if (target < 0 || target >= props.fallbacks.length) return
  const copy = [...props.fallbacks]
  const [item] = copy.splice(index, 1)
  if (item) copy.splice(target, 0, item)
  emit('update:fallbacks', copy)
}

function removeFallback(index: number) {
  const copy = [...props.fallbacks]
  copy.splice(index, 1)
  emit('update:fallbacks', copy)
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="font-semibold text-sm">Roteamento Ativo &amp; Cadeia de Fallback</h2>
          <p class="text-xs text-muted">Escolha o modelo principal, o submodelo auxiliar e a ordem automática de fallback.</p>
        </div>
        <UButton size="xs" variant="outline" icon="i-lucide-arrow-left-right" @click="emit('swap')">
          Inverter Principal ↔ Sub
        </UButton>
      </div>
    </template>

    <div class="space-y-5">
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- Principal -->
        <div class="p-3.5 rounded-xl border border-primary/40 bg-primary/5 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 text-xs font-semibold text-primary">
              <UIcon name="i-lucide-bot" class="size-4" />
              <span>Agente Principal (Primário)</span>
            </div>
            <UButton size="xs" variant="ghost" color="primary" icon="i-lucide-activity" :loading="testingPrimary" @click="emit('testPrimary')">
              Testar
            </UButton>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="Provedor">
              <USelect v-model="primary.provider" :items="providerOptions" class="w-full" />
            </UFormField>
            <UFormField label="Modelo">
              <div class="flex items-center gap-1">
                <USelect
                  v-if="modelsForProvider(primary.provider).length > 0 && !manualModelMode.primary"
                  v-model="primary.model"
                  :items="modelsForProvider(primary.provider)"
                  class="flex-1 font-mono text-xs"
                />
                <UInput
                  v-else
                  v-model="primary.model"
                  placeholder="Ex.: default, gpt-4o"
                  class="flex-1 font-mono text-xs"
                />
                <UButton
                  v-if="modelsForProvider(primary.provider).length > 0"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  :icon="manualModelMode.primary ? 'i-lucide-list' : 'i-lucide-pencil'"
                  :title="manualModelMode.primary ? 'Escolher da lista' : 'Digitar manualmente'"
                  @click="manualModelMode.primary = !manualModelMode.primary"
                />
              </div>
            </UFormField>
          </div>
        </div>

        <!-- Submodelo -->
        <div class="p-3.5 rounded-xl border border-info/30 bg-info/5 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 text-xs font-semibold text-info">
              <UIcon name="i-lucide-sparkles" class="size-4" />
              <span>Submodelo (Agente Secundário)</span>
            </div>
            <UButton size="xs" variant="ghost" color="info" icon="i-lucide-activity" :loading="testingSecondary" @click="emit('testSecondary')">
              Testar
            </UButton>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="Provedor">
              <USelect v-model="secondary.provider" :items="providerOptions" class="w-full" />
            </UFormField>
            <UFormField label="Modelo">
              <div class="flex items-center gap-1">
                <USelect
                  v-if="modelsForProvider(secondary.provider).length > 0 && !manualModelMode.secondary"
                  v-model="secondary.model"
                  :items="modelsForProvider(secondary.provider)"
                  class="flex-1 font-mono text-xs"
                />
                <UInput
                  v-else
                  v-model="secondary.model"
                  placeholder="Ex.: gemma2:2b, gemini-3.8-flash-medium"
                  class="flex-1 font-mono text-xs"
                />
                <UButton
                  v-if="modelsForProvider(secondary.provider).length > 0"
                  size="xs"
                  variant="ghost"
                  color="neutral"
                  :icon="manualModelMode.secondary ? 'i-lucide-list' : 'i-lucide-pencil'"
                  :title="manualModelMode.secondary ? 'Escolher da lista' : 'Digitar manualmente'"
                  @click="manualModelMode.secondary = !manualModelMode.secondary"
                />
              </div>
            </UFormField>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 pt-1 border-t border-info/15">
            <span class="text-[11px] text-muted mr-1">Atalhos rápidos:</span>
            <UButton size="xs" variant="soft" color="neutral" @click="emit('selectSecondary', 'antigravity-cli', 'gemini-3.8-flash-medium')">
              Antigravity Flash
            </UButton>
            <UButton size="xs" variant="soft" color="neutral" @click="emit('selectSecondary', 'kimi-coding', 'kimi-for-coding')">
              Kimi Coding
            </UButton>
            <UButton size="xs" variant="soft" color="neutral" @click="emit('selectSecondary', 'qwen', 'qwen3-coder-flash')">
              Qwen Flash
            </UButton>
            <UButton size="xs" variant="soft" color="neutral" @click="emit('selectSecondary', 'ollama', 'gemma2:2b')">
              Ollama Local
            </UButton>
          </div>
          <div
            v-if="secondaryTestResult"
            class="text-xs px-3 py-2 rounded-lg border"
            :class="secondaryTestResult.ok ? 'border-success/40 bg-success/10 text-success' : 'border-error/40 bg-error/10 text-error'"
          >
            <span v-if="secondaryTestResult.ok">Submodelo OK em {{ secondaryTestResult.latencyMs }}ms — "{{ secondaryTestResult.preview }}"</span>
            <span v-else>Falha ({{ secondaryTestResult.latencyMs }}ms): {{ secondaryTestResult.error }}</span>
          </div>
        </div>
      </div>

      <!-- Cadeia de Fallback -->
      <div class="space-y-2.5 pt-2 border-t border-default/60">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-highlighted">Cadeia de Fallback ({{ fallbacks.length }})</span>
          <span class="text-[11px] text-muted">Acionada em ordem se o primário falhar ou atingir rate-limit</span>
        </div>

        <div v-for="(fb, idx) in fallbacks" :key="`${fb.provider}-${idx}`" class="flex flex-wrap sm:flex-nowrap items-center gap-2 p-2.5 rounded-lg border border-default bg-default">
          <UBadge color="neutral" variant="subtle" size="xs">#{{ idx + 1 }}</UBadge>
          <USelect v-model="fb.provider" :items="providerOptions" size="xs" class="w-40" />
          <USelect
            v-if="modelsForProvider(fb.provider).length > 0"
            v-model="fb.model"
            :items="modelsForProvider(fb.provider)"
            size="xs"
            class="flex-1 min-w-44 font-mono"
          />
          <UInput v-else v-model="fb.model" size="xs" class="flex-1 min-w-44 font-mono" placeholder="modelo" />
          <div class="flex items-center gap-0.5 shrink-0">
            <UButton size="xs" variant="ghost" icon="i-lucide-arrow-up" :disabled="idx === 0" @click="moveFallback(idx, -1)" />
            <UButton size="xs" variant="ghost" icon="i-lucide-arrow-down" :disabled="idx === fallbacks.length - 1" @click="moveFallback(idx, 1)" />
            <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" @click="removeFallback(idx)" />
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 pt-1">
          <USelect v-model="newFallback.provider" :items="providerOptions" size="xs" class="w-40" />
          <USelect
            v-if="modelsForProvider(newFallback.provider).length > 0 && !manualModelMode.newFallback"
            v-model="newFallback.model"
            :items="modelsForProvider(newFallback.provider)"
            size="xs"
            class="flex-1 min-w-44 font-mono"
          />
          <UInput
            v-else
            v-model="newFallback.model"
            size="xs"
            class="flex-1 min-w-44 font-mono"
            placeholder="Ex.: llama3.2 ou sonnet"
          />
          <UButton
            v-if="modelsForProvider(newFallback.provider).length > 0"
            size="xs"
            variant="ghost"
            color="neutral"
            :icon="manualModelMode.newFallback ? 'i-lucide-list' : 'i-lucide-pencil'"
            :title="manualModelMode.newFallback ? 'Escolher da lista' : 'Digitar manualmente'"
            @click="manualModelMode.newFallback = !manualModelMode.newFallback"
          />
          <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="addFallback">Adicionar Fallback</UButton>
        </div>
      </div>
    </div>
  </UCard>
</template>

