<script setup lang="ts">
import type { RunnerPluginItem, RunnerPluginPreset } from './types'

const props = defineProps<{
  plugins: RunnerPluginItem[]
  presets: RunnerPluginPreset[]
  loading: boolean
}>()

const emit = defineEmits<{
  refresh: []
  inspect: [plugin: RunnerPluginItem]
  toggle: [plugin: RunnerPluginItem]
  uninstall: [plugin: RunnerPluginItem]
  installPreset: [preset: RunnerPluginPreset]
}>()

const search = ref('')
const installedIds = computed(() => new Set(props.plugins.map(p => p.id)))

const filteredPlugins = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.plugins
  return props.plugins.filter(p =>
    p.id.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q)
  )
})
</script>

<template>
  <div class="space-y-5">
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="font-semibold text-sm">Plugins Instalados no Runner</h2>
            <p class="text-xs text-muted">Gerencie extensões, skills, hooks e variáveis de configuração específicas de cada plugin.</p>
          </div>
          <div class="flex items-center gap-2">
            <UInput v-model="search" size="xs" icon="i-lucide-search" placeholder="Filtrar plugins..." class="w-48" />
            <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="emit('refresh')" />
          </div>
        </div>
      </template>

      <UiEmptyState
        v-if="filteredPlugins.length === 0"
        compact
        icon="i-lucide-blocks"
        title="Nenhum plugin instalado"
        description="Instale um plugin do catálogo abaixo ou adicione um plugin customizado."
      />

      <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div
          v-for="p in filteredPlugins"
          :key="p.id"
          class="p-3.5 rounded-xl border border-default bg-default flex flex-col justify-between gap-3"
          :class="!p.enabled ? 'opacity-60' : ''"
        >
          <div class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="font-semibold text-sm truncate">{{ p.name }}</span>
                <span class="text-[11px] font-mono text-muted">v{{ p.version }}</span>
                <UBadge color="neutral" variant="outline" size="xs">{{ p.source }}</UBadge>
              </div>
              <UBadge :color="p.enabled ? 'success' : 'neutral'" variant="subtle" size="xs">
                {{ p.enabled ? 'Ativo' : 'Desativado' }}
              </UBadge>
            </div>

            <p class="text-xs text-muted">{{ p.description }}</p>

            <div class="flex flex-wrap gap-1">
              <UBadge v-for="sk in p.skills" :key="`sk-${sk}`" color="primary" variant="soft" size="xs">
                skill: {{ sk }}
              </UBadge>
              <UBadge v-for="tl in p.tools" :key="`tl-${tl}`" color="info" variant="soft" size="xs">
                tool: {{ tl }}
              </UBadge>
              <UBadge v-for="hk in p.hooks" :key="`hk-${hk}`" color="warning" variant="soft" size="xs">
                hook: {{ hk }}
              </UBadge>
            </div>
          </div>

          <div class="flex items-center justify-between gap-2 pt-2 border-t border-default/60">
            <UButton size="xs" variant="outline" icon="i-lucide-sliders-horizontal" @click="emit('inspect', p)">
              Gerenciar
            </UButton>
            <div class="flex items-center gap-1">
              <UButton size="xs" variant="soft" :color="p.enabled ? 'neutral' : 'primary'" @click="emit('toggle', p)">
                {{ p.enabled ? 'Desativar' : 'Ativar' }}
              </UButton>
              <UButton size="xs" variant="ghost" color="error" icon="i-lucide-trash-2" title="Desinstalar" @click="emit('uninstall', p)" />
            </div>
          </div>
        </div>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <div>
          <h2 class="font-semibold text-sm">Catálogo de Plugins Recomendados</h2>
          <p class="text-xs text-muted">Extensões modulares inspiradas em OpenClaw / NanoClaw para turbinar o Brain Runner.</p>
        </div>
      </template>

      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        <div
          v-for="preset in presets"
          :key="preset.id"
          class="p-3.5 rounded-xl border border-default bg-elevated/30 flex flex-col justify-between gap-3"
        >
          <div class="space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <span class="font-semibold text-xs">{{ preset.name }}</span>
              <UBadge v-if="installedIds.has(preset.id)" color="success" variant="subtle" size="xs">Instalado</UBadge>
              <UBadge v-else color="neutral" variant="outline" size="xs">v{{ preset.version }}</UBadge>
            </div>
            <p class="text-[11px] text-muted">{{ preset.description }}</p>
          </div>
          <UButton
            size="xs"
            :variant="installedIds.has(preset.id) ? 'ghost' : 'soft'"
            :color="installedIds.has(preset.id) ? 'neutral' : 'primary'"
            icon="i-lucide-download"
            class="w-full justify-center"
            @click="emit('installPreset', preset)"
          >
            {{ installedIds.has(preset.id) ? 'Reinstalar' : 'Instalar Plugin' }}
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>

