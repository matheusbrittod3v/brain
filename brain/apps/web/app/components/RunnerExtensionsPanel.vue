<script setup lang="ts">
import McpServersTab from './runner/extensions/McpServersTab.vue'
import PluginsTab from './runner/extensions/PluginsTab.vue'
import ExtensionModals from './runner/extensions/ExtensionModals.vue'
import type { RunnerMcpPreset, RunnerMcpServerItem, RunnerPluginItem, RunnerPluginPreset } from './runner/extensions/types'

const { projectId, apiFetch, notify, hasPermission } = useBrainApi()

const subTab = ref<'mcps' | 'plugins'>('mcps')
const loading = ref(false)
const importingLocal = ref(false)
const testingServerId = ref<string | null>(null)

const servers = ref<RunnerMcpServerItem[]>([])
const mcpPresets = ref<RunnerMcpPreset[]>([])
const plugins = ref<RunnerPluginItem[]>([])
const pluginPresets = ref<RunnerPluginPreset[]>([])

const mcpModalOpen = ref(false)
const editingMcp = ref<RunnerMcpServerItem | null>(null)
const jsonModalOpen = ref(false)
const pluginModalOpen = ref(false)
const inspectedPlugin = ref<RunnerPluginItem | null>(null)

const activeMcpsCount = computed(() => servers.value.filter(s => s.enabled).length)
const activePluginsCount = computed(() => plugins.value.filter(p => p.enabled).length)
const activeCapabilitiesCount = computed(() =>
  plugins.value.filter(p => p.enabled).reduce((acc, p) => acc + p.skills.length + p.tools.length, 0)
)

async function loadAll() {
  if (!projectId.value) return
  loading.value = true
  try {
    const pid = encodeURIComponent(projectId.value)
    const [mcpRes, plugRes] = await Promise.all([
      apiFetch(`/v1/projects/${pid}/runner/mcp-servers`) as Promise<{ servers: RunnerMcpServerItem[]; presets: RunnerMcpPreset[] }>,
      apiFetch(`/v1/projects/${pid}/runner/plugins`) as Promise<{ installed: RunnerPluginItem[]; presets: RunnerPluginPreset[] }>
    ])
    servers.value = mcpRes.servers ?? []
    mcpPresets.value = mcpRes.presets ?? []
    plugins.value = plugRes.installed ?? []
    pluginPresets.value = plugRes.presets ?? []
  } catch (err) {
    notify('Erro ao carregar extensões', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}

async function importLocalMcps() {
  if (!projectId.value) return
  importingLocal.value = true
  try {
    const pid = encodeURIComponent(projectId.value)
    const res = await apiFetch(`/v1/projects/${pid}/runner/mcp-servers/import`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'local' })
    }) as { imported: RunnerMcpServerItem[]; sources: string[] }
    if (res.imported.length > 0) {
      notify(`${res.imported.length} MCP(s) importado(s)`, res.sources.join(', '), 'success')
    } else {
      notify('Nenhum MCP local encontrado', 'Verificados .mcp.json, ~/.cursor/mcp.json, ~/.claude.json e Antigravity.', 'warning')
    }
    await loadAll()
  } catch (err) {
    notify('Erro ao importar MCPs locais', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    importingLocal.value = false
  }
}

async function installMcpPreset(preset: RunnerMcpPreset) {
  if (!projectId.value) return
  try {
    const pid = encodeURIComponent(projectId.value)
    await apiFetch(`/v1/projects/${pid}/runner/mcp-servers`, {
      method: 'POST',
      body: JSON.stringify({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        transport: preset.transport,
        command: preset.command,
        args: preset.args,
        url: preset.url
      })
    })
    notify(`MCP '${preset.name}' instalado!`, undefined, 'success')
    await loadAll()
  } catch (err) {
    notify('Erro ao instalar MCP', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function toggleMcpServer(s: RunnerMcpServerItem) {
  if (!projectId.value) return
  try {
    const pid = encodeURIComponent(projectId.value)
    await apiFetch(`/v1/projects/${pid}/runner/mcp-servers/${encodeURIComponent(s.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !s.enabled })
    })
    await loadAll()
  } catch (err) {
    notify('Erro ao atualizar MCP', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function testMcpServer(s: RunnerMcpServerItem) {
  if (!projectId.value) return
  testingServerId.value = s.id
  try {
    const pid = encodeURIComponent(projectId.value)
    const res = await apiFetch(`/v1/projects/${pid}/runner/mcp-servers/${encodeURIComponent(s.id)}/test`, {
      method: 'POST'
    }) as NonNullable<RunnerMcpServerItem['lastTest']>
    notify(
      res.ok ? `${s.name} online (${res.latencyMs}ms)` : `${s.name} falhou`,
      res.ok ? (res.serverName ? `Server: ${res.serverName} ${res.serverVersion || ''}` : undefined) : res.error,
      res.ok ? 'success' : 'error'
    )
    await loadAll()
  } catch (err) {
    notify('Erro ao testar MCP', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    testingServerId.value = null
  }
}

async function removeMcpServer(s: RunnerMcpServerItem) {
  if (!projectId.value) return
  try {
    const pid = encodeURIComponent(projectId.value)
    await apiFetch(`/v1/projects/${pid}/runner/mcp-servers/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
    notify(`MCP '${s.name}' removido`, undefined, 'warning')
    await loadAll()
  } catch (err) {
    notify('Erro ao remover MCP', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function installPluginPreset(preset: RunnerPluginPreset) {
  if (!projectId.value) return
  try {
    const pid = encodeURIComponent(projectId.value)
    await apiFetch(`/v1/projects/${pid}/runner/plugins`, {
      method: 'POST',
      body: JSON.stringify({ id: preset.id })
    })
    notify(`Plugin '${preset.name}' instalado!`, undefined, 'success')
    await loadAll()
  } catch (err) {
    notify('Erro ao instalar plugin', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function togglePlugin(p: RunnerPluginItem) {
  if (!projectId.value) return
  try {
    const pid = encodeURIComponent(projectId.value)
    await apiFetch(`/v1/projects/${pid}/runner/plugins/${encodeURIComponent(p.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: !p.enabled })
    })
    await loadAll()
    if (inspectedPlugin.value?.id === p.id) {
      inspectedPlugin.value = plugins.value.find(item => item.id === p.id) || null
    }
  } catch (err) {
    notify('Erro ao atualizar plugin', err instanceof Error ? err.message : String(err), 'error')
  }
}

async function uninstallPlugin(p: RunnerPluginItem) {
  if (!projectId.value) return
  try {
    const pid = encodeURIComponent(projectId.value)
    await apiFetch(`/v1/projects/${pid}/runner/plugins/${encodeURIComponent(p.id)}`, { method: 'DELETE' })
    notify(`Plugin '${p.name}' desinstalado`, undefined, 'warning')
    if (inspectedPlugin.value?.id === p.id) inspectedPlugin.value = null
    await loadAll()
  } catch (err) {
    notify('Erro ao desinstalar plugin', err instanceof Error ? err.message : String(err), 'error')
  }
}

watch(projectId, loadAll, { immediate: true })
</script>

<template>
  <div class="space-y-5">
    <div class="rounded-xl border border-default bg-elevated/40 p-4">
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 flex-1">
          <div>
            <div class="text-[11px] text-muted">MCPs Ativos</div>
            <div class="text-sm font-semibold text-highlighted mt-0.5">{{ activeMcpsCount }} / {{ servers.length }}</div>
          </div>
          <div>
            <div class="text-[11px] text-muted">Plugins Ativos</div>
            <div class="text-sm font-semibold text-highlighted mt-0.5">{{ activePluginsCount }} / {{ plugins.length }}</div>
          </div>
          <div>
            <div class="text-[11px] text-muted">Skills / Tools de Plugins</div>
            <div class="text-sm font-semibold text-highlighted mt-0.5">{{ activeCapabilitiesCount }}</div>
          </div>
          <div>
            <div class="text-[11px] text-muted">Protocolo</div>
            <div class="text-xs font-mono text-primary mt-1">MCP + Plugins v1</div>
          </div>
        </div>

        <div v-if="hasPermission('runner:execute')" class="flex flex-wrap items-center gap-2 shrink-0">
          <UButton size="xs" variant="outline" icon="i-lucide-download" :loading="importingLocal" @click="importLocalMcps">
            Importar MCPs Locais
          </UButton>
          <UButton size="xs" variant="outline" icon="i-lucide-braces" @click="jsonModalOpen = true">
            Colar JSON
          </UButton>
          <UButton size="xs" variant="soft" icon="i-lucide-plug-zap" @click="editingMcp = null; mcpModalOpen = true">
            Novo MCP
          </UButton>
          <UButton size="xs" icon="i-lucide-plus" @click="pluginModalOpen = true">
            Instalar Plugin
          </UButton>
        </div>
      </div>
    </div>

    <UiSegmentedTabs
      v-model="subTab"
      :items="[
        { label: 'MCP Servers', value: 'mcps', icon: 'i-lucide-plug-zap', badge: activeMcpsCount || undefined },
        { label: 'Plugins', value: 'plugins', icon: 'i-lucide-blocks', badge: activePluginsCount || undefined }
      ]"
    />

    <McpServersTab
      v-if="subTab === 'mcps'"
      :servers="servers"
      :presets="mcpPresets"
      :loading="loading"
      :testing-server-id="testingServerId"
      @refresh="loadAll"
      @edit="(s) => { editingMcp = s; mcpModalOpen = true }"
      @toggle="toggleMcpServer"
      @test="testMcpServer"
      @remove="removeMcpServer"
      @install-preset="installMcpPreset"
    />

    <PluginsTab
      v-else
      :plugins="plugins"
      :presets="pluginPresets"
      :loading="loading"
      @refresh="loadAll"
      @inspect="(p) => inspectedPlugin = p"
      @toggle="togglePlugin"
      @uninstall="uninstallPlugin"
      @install-preset="installPluginPreset"
    />

    <ExtensionModals
      v-model:mcp-open="mcpModalOpen"
      v-model:json-open="jsonModalOpen"
      v-model:plugin-open="pluginModalOpen"
      v-model:inspected-plugin="inspectedPlugin"
      :editing-mcp="editingMcp"
      @saved="loadAll"
      @toggle-plugin="togglePlugin"
      @uninstall-plugin="uninstallPlugin"
    />
  </div>
</template>
