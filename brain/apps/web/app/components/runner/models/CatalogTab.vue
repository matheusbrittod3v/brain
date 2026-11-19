<script setup lang="ts">
import type { ModelCatalogItem, RunnerProviderItem } from './types'

const props = defineProps<{
  rows: Array<{
    key: string
    provider: string
    category: RunnerProviderItem['category']
    online: boolean
    configured: boolean
    model: ModelCatalogItem
  }>
  providerFilterItems: Array<{ label: string; value: string }>
  modelTestState: Record<string, 'testing' | 'ok' | 'error'>
  copiedModel: string | null
}>()

const modelSearch = defineModel<string>('search', { required: true })
const modelProviderFilter = defineModel<string>('providerFilter', { required: true })
const onlyFreeModels = defineModel<boolean>('onlyFree', { required: true })

const emit = defineEmits<{
  openAddModel: []
  testModel: [providerId: string, modelId: string]
  copyModel: [key: string]
  toggleDisabled: [providerId: string, modelId: string, disabled: boolean]
  deleteCustom: [providerId: string, modelId: string]
  selectPrimary: [providerId: string, modelId: string]
  selectSecondary: [providerId: string, modelId: string]
  appendFallback: [providerId: string, modelId: string]
}>()
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="font-semibold text-sm">
            Catálogo de Modelos
            <UBadge color="primary" variant="subtle" size="xs" class="ml-1">{{ rows.length }}</UBadge>
          </h2>
          <p class="text-xs text-muted">Modelos descobertos pelas conexões ativas ou registrados manualmente.</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UInput v-model="modelSearch" size="xs" icon="i-lucide-search" placeholder="Filtrar modelos..." class="w-44" />
          <USelect v-model="modelProviderFilter" :items="providerFilterItems" size="xs" class="w-44" />
          <UButton
            size="xs"
            :variant="onlyFreeModels ? 'soft' : 'outline'"
            :color="onlyFreeModels ? 'success' : 'neutral'"
            icon="i-lucide-sparkles"
            @click="onlyFreeModels = !onlyFreeModels"
          >
            Gratuitos
          </UButton>
          <UButton size="xs" icon="i-lucide-plus" @click="emit('openAddModel')">Registrar Modelo</UButton>
        </div>
      </div>
    </template>

    <div v-if="rows.length === 0" class="text-xs text-muted py-6 text-center">
      Nenhum modelo encontrado para o filtro atual.
    </div>
    <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-2.5 max-h-[460px] overflow-y-auto pr-1">
      <div
        v-for="row in rows"
        :key="row.key"
        class="px-3 py-2.5 rounded-xl border flex flex-col gap-2 transition-colors"
        :class="[
          modelTestState[row.key] === 'ok' ? 'border-success/50 bg-success/5' :
          modelTestState[row.key] === 'error' ? 'border-error/50 bg-error/5' : 'border-default',
          row.model.disabled ? 'opacity-50' : ''
        ]"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 min-w-0">
            <code class="text-xs font-mono bg-elevated px-1.5 py-0.5 rounded truncate">{{ row.key }}</code>
            <UBadge v-if="row.model.free" color="success" variant="soft" size="xs">FREE</UBadge>
            <UBadge v-if="row.model.custom" color="primary" variant="soft" size="xs">CUSTOM</UBadge>
            <UBadge v-if="row.online" color="info" variant="subtle" size="xs">ONLINE</UBadge>
          </div>
          <div class="flex items-center gap-0.5 shrink-0">
            <UButton
              size="xs"
              variant="ghost"
              icon="i-lucide-flask-conical"
              :loading="modelTestState[row.key] === 'testing'"
              title="Testar modelo"
              @click="emit('testModel', row.provider, row.model.id)"
            />
            <UButton
              size="xs"
              variant="ghost"
              :icon="copiedModel === row.key ? 'i-lucide-check' : 'i-lucide-copy'"
              title="Copiar ID"
              @click="emit('copyModel', row.key)"
            />
            <UButton
              size="xs"
              variant="ghost"
              :color="row.model.disabled ? 'success' : 'neutral'"
              :icon="row.model.disabled ? 'i-lucide-eye' : 'i-lucide-eye-off'"
              :title="row.model.disabled ? 'Ativar modelo' : 'Desativar modelo'"
              @click="emit('toggleDisabled', row.provider, row.model.id, !row.model.disabled)"
            />
            <UButton
              v-if="row.model.custom"
              size="xs"
              color="error"
              variant="ghost"
              icon="i-lucide-x"
              title="Remover modelo customizado"
              @click="emit('deleteCustom', row.provider, row.model.id)"
            />
          </div>
        </div>

        <div class="flex items-center justify-between gap-2 text-[11px]">
          <span class="text-muted truncate">{{ row.model.name || row.model.id }}</span>
          <div class="flex items-center gap-1 shrink-0">
            <UButton size="xs" variant="soft" color="primary" @click="emit('selectPrimary', row.provider, row.model.id)">
              Primário
            </UButton>
            <UButton size="xs" variant="soft" color="info" @click="emit('selectSecondary', row.provider, row.model.id)">
              Submodelo
            </UButton>
            <UButton size="xs" variant="soft" color="neutral" @click="emit('appendFallback', row.provider, row.model.id)">
              + Fallback
            </UButton>
          </div>
        </div>
      </div>
    </div>
  </UCard>
</template>

