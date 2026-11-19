<script setup lang="ts">
import type { RunnerMcpPreset, RunnerMcpServerItem } from './types'

const props = defineProps<{
  servers: RunnerMcpServerItem[]
  presets: RunnerMcpPreset[]
  loading: boolean
  testingServerId: string | null
}>()

const emit = defineEmits<{
  refresh: []
  edit: [server: RunnerMcpServerItem]
  toggle: [server: RunnerMcpServerItem]
  test: [server: RunnerMcpServerItem]
  remove: [server: RunnerMcpServerItem]
  installPreset: [preset: RunnerMcpPreset]
}>()

const search = ref('')
const installedIds = computed(() => new Set(props.servers.map(s => s.id)))

const filteredServers = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return props.servers
  return props.servers.filter(s =>
    s.id.toLowerCase().includes(q) ||
    s.name.toLowerCase().includes(q) ||
    (s.command || '').toLowerCase().includes(q) ||
    (s.url || '').toLowerCase().includes(q)
  )
})
</script>

<template>
  <div class="space-y-5">
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="font-semibold text-sm">Servidores MCP Conectados</h2>
            <p class="text-xs text-muted">Conecte servidores STDIO, HTTP ou SSE ao Brain Runner (compatível com formato mcpServers).</p>
          </div>
          <div class="flex items-center gap-2">
            <UInput v-model="search" size="xs" icon="i-lucide-search" placeholder="Filtrar MCPs..." class="w-48" />
            <UButton size="xs" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="emit('refresh')" />
          </div>
        </div>
      </template>

      <UiEmptyState
        v-if="filteredServers.length === 0"
        compact
        icon="i-lucide-plug-zap"
        title="Nenhum servidor MCP configurado"
        description="Importe os MCPs do Cursor/Claude/Antigravity, cole um JSON ou instale um preset abaixo."
      />

      <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div
          v-for="s in filteredServers"
          :key="s.id"
          class="p-3.5 rounded-xl border border-default bg-default flex flex-col justify-between gap-3"
          :class="!s.enabled ? 'opacity-60' : ''"
        >
          <div class="space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="font-semibold text-sm truncate">{{ s.name }}</span>
                <UBadge color="neutral" variant="outline" size="xs" class="uppercase font-mono">{{ s.transport }}</UBadge>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <UBadge v-if="s.lastTest" :color="s.lastTest.ok ? 'success' : 'error'" variant="subtle" size="xs">
                  {{ s.lastTest.ok ? `OK · ${s.lastTest.latencyMs}ms` : 'Erro' }}
                </UBadge>
                <UBadge :color="s.enabled ? 'primary' : 'neutral'" variant="soft" size="xs">
                  {{ s.enabled ? 'Ativo' : 'Desativado' }}
                </UBadge>
              </div>
            </div>

            <p v-if="s.description" class="text-xs text-muted line-clamp-2">{{ s.description }}</p>

            <div class="text-[11px] font-mono text-muted bg-elevated/60 px-2 py-1 rounded truncate">
              <span v-if="s.transport === 'stdio'">$ {{ s.command }} {{ (s.args || []).join(' ') }}</span>
              <span v-else>{{ s.url }}</span>
            </div>

            <div v-if="s.env && Object.keys(s.env).length > 0" class="flex flex-wrap gap-1 pt-0.5">
              <UBadge v-for="k in Object.keys(s.env)" :key="k" color="neutral" variant="subtle" size="xs" class="font-mono">
                {{ k }}
              </UBadge>
            </div>
            <div v-if="s.lastTest && !s.lastTest.ok && s.lastTest.error" class="text-[11px] text-error truncate">
              {{ s.lastTest.error }}
            </div>
          </div>

          <div class="flex items-center justify-between gap-2 pt-2 border-t border-default/60">
            <UButton size="xs" variant="outline" icon="i-lucide-activity" :loading="testingServerId === s.id" @click="emit('test', s)">
              Testar
            </UButton>
            <div class="flex items-center gap-1">
              <UButton size="xs" variant="ghost" icon="i-lucide-settings-2" title="Editar" @click="emit('edit', s)" />
              <UButton size="xs" variant="soft" :color="s.enabled ? 'neutral' : 'primary'" @click="emit('toggle', s)">
                {{ s.enabled ? 'Desativar' : 'Ativar' }}
              </UButton>
              <UButton size="xs" variant="ghost" color="error" icon="i-lucide-trash-2" title="Remover" @click="emit('remove', s)" />
            </div>
          </div>
        </div>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <div>
          <h2 class="font-semibold text-sm">Presets Populares de MCP</h2>
          <p class="text-xs text-muted">Adicione servidores MCP prontos em 1 clique e ajuste variáveis de ambiente se necessário.</p>
        </div>
      </template>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        <div
          v-for="preset in presets"
          :key="preset.id"
          class="p-3 rounded-xl border border-default bg-elevated/30 flex flex-col justify-between gap-2.5"
        >
          <div class="space-y-1">
            <div class="flex items-center justify-between gap-2">
              <span class="font-semibold text-xs">{{ preset.name }}</span>
              <UBadge v-if="installedIds.has(preset.id)" color="success" variant="subtle" size="xs">Instalado</UBadge>
            </div>
            <p class="text-[11px] text-muted line-clamp-2">{{ preset.description }}</p>
          </div>
          <UButton
            size="xs"
            :variant="installedIds.has(preset.id) ? 'ghost' : 'soft'"
            :color="installedIds.has(preset.id) ? 'neutral' : 'primary'"
            icon="i-lucide-plus"
            class="w-full justify-center"
            @click="emit('installPreset', preset)"
          >
            {{ installedIds.has(preset.id) ? 'Reinstalar' : 'Conectar' }}
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>

