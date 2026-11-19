<script setup lang="ts">
import { CATEGORY_TABS, categoryColor, categoryLabel, type RunnerProviderItem } from './types'

const props = defineProps<{
  providers: RunnerProviderItem[]
  primaryProvider: string
  loadingProviders: boolean
  probing: boolean
  importingLocal: boolean
  probingProvider: string | null
  oauthLoading: boolean
}>()

const emit = defineEmits<{
  importLocal: [providerId?: string]
  probeAll: []
  openCustomProvider: []
  refreshProvider: [providerId: string]
  openOAuth: [providerId: string]
  disconnect: [providerId: string]
  openConfig: [provider: RunnerProviderItem]
  selectPrimary: [providerId: string, modelId?: string]
  selectSecondary: [providerId: string, modelId?: string]
}>()

const categoryFilter = ref<'all' | 'free' | 'local' | 'cloud' | 'gateway' | 'cli'>('all')

const filteredProviders = computed(() => {
  if (categoryFilter.value === 'all') return props.providers
  if (categoryFilter.value === 'free') return props.providers.filter(p => p.hasFree)
  return props.providers.filter(p => p.category === categoryFilter.value)
})
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <UiSegmentedTabs v-model="categoryFilter" :items="CATEGORY_TABS" />
        <div class="flex flex-wrap items-center gap-2">
          <UButton size="xs" variant="outline" icon="i-lucide-key-round" :loading="importingLocal" @click="emit('importLocal')">
            Importar Auth Local
          </UButton>
          <UButton size="xs" variant="outline" icon="i-lucide-radar" :loading="probing" @click="emit('probeAll')">
            Detectar Locais
          </UButton>
          <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="emit('openCustomProvider')">
            Novo Provedor
          </UButton>
        </div>
      </div>
    </template>

    <div v-if="loadingProviders" class="text-xs text-muted py-6 text-center">Carregando conexões...</div>
    <div v-else class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      <div
        v-for="p in filteredProviders"
        :key="p.id"
        class="p-3.5 rounded-xl border border-default flex flex-col justify-between gap-3 bg-default"
        :class="primaryProvider === p.id ? 'ring-1 ring-primary' : ''"
      >
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="font-semibold text-sm truncate">{{ p.id }}</span>
              <UBadge :color="categoryColor(p.category)" variant="subtle" size="xs">{{ categoryLabel(p.category) }}</UBadge>
            </div>
            <UBadge
              :color="p.online ? 'success' : p.configured ? 'info' : 'neutral'"
              variant="soft"
              size="xs"
            >
              {{ p.online ? 'Online' : p.configured ? 'Configurado' : 'Sem chave' }}
            </UBadge>
          </div>

          <div class="text-[11px] font-mono text-muted truncate">
            <span v-if="p.mode === 'cli'">$ {{ (p.cliCommand || []).join(' ') }}</span>
            <span v-else>{{ p.baseUrl || 'Endpoint padrão SDK' }}</span>
          </div>

          <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
            <UBadge v-if="p.hasFree" color="success" variant="subtle" size="xs">Grátis</UBadge>
            <UBadge v-if="p.connectedAccount" color="primary" variant="soft" size="xs">
              {{ p.connectedAccount.email || p.connectedAccount.authType }}
              <span v-if="p.connectedAccount.planType"> ({{ p.connectedAccount.planType }})</span>
            </UBadge>
            <span class="text-muted">{{ p.models.length }} modelo(s)</span>
            <span v-if="!p.online && p.connectionError" class="text-warning truncate">· {{ p.connectionError }}</span>
          </div>

          <div v-if="p.discoveredModels.length > 0" class="flex flex-wrap items-center gap-1 pt-1">
            <UButton
              v-for="m in p.discoveredModels.slice(0, 4)"
              :key="m"
              size="xs"
              variant="soft"
              color="neutral"
              class="font-mono text-[10px]"
              @click="emit('selectPrimary', p.id, m)"
            >
              {{ m }}
            </UButton>
            <span v-if="p.discoveredModels.length > 4" class="text-[10px] text-muted px-1">
              +{{ p.discoveredModels.length - 4 }}
            </span>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-1 pt-2 border-t border-default/60">
          <div class="flex items-center gap-1">
            <UButton v-if="p.supportsOAuth" size="xs" variant="soft" color="primary" icon="i-lucide-log-in" :loading="oauthLoading" @click="emit('openOAuth', p.id)">
              OAuth
            </UButton>
            <UButton v-if="p.supportsLocalImport && !p.connectedAccount" size="xs" variant="ghost" icon="i-lucide-download" @click="emit('importLocal', p.id)">
              Importar
            </UButton>
            <UButton v-if="p.connectedAccount" size="xs" variant="ghost" color="error" icon="i-lucide-unlink" title="Desconectar" @click="emit('disconnect', p.id)" />
          </div>

          <div class="flex items-center gap-1">
            <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" title="Carregar modelos" :loading="probingProvider === p.id" @click="emit('refreshProvider', p.id)" />
            <UButton size="xs" variant="ghost" icon="i-lucide-settings-2" title="Configurar" @click="emit('openConfig', p)" />
            <UButton size="xs" variant="soft" color="info" @click="emit('selectSecondary', p.id, p.discoveredModels[0] || p.models[0]?.id)">
              Sub
            </UButton>
            <UButton size="xs" variant="soft" color="primary" @click="emit('selectPrimary', p.id, p.discoveredModels[0] || p.models[0]?.id)">
              Usar
            </UButton>
          </div>
        </div>
      </div>
    </div>
  </UCard>
</template>

