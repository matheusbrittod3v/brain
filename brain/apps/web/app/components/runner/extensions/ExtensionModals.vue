<script setup lang="ts">
import { formatKeyValueLines, parseKeyValueLines, type RunnerMcpServerItem, type RunnerPluginItem } from './types'

const props = defineProps<{
  mcpOpen: boolean
  editingMcp: RunnerMcpServerItem | null
  jsonOpen: boolean
  pluginOpen: boolean
  inspectedPlugin: RunnerPluginItem | null
}>()

const emit = defineEmits<{
  'update:mcpOpen': [value: boolean]
  'update:jsonOpen': [value: boolean]
  'update:pluginOpen': [value: boolean]
  'update:inspectedPlugin': [value: RunnerPluginItem | null]
  saved: []
  togglePlugin: [plugin: RunnerPluginItem]
  uninstallPlugin: [plugin: RunnerPluginItem]
}>()

const { projectId, apiFetch, notify } = useBrainApi()

const savingMcp = ref(false)
const mcpForm = reactive({
  id: '',
  name: '',
  description: '',
  transport: 'stdio' as 'stdio' | 'http' | 'sse',
  command: 'npx',
  argsText: '',
  url: '',
  envText: '',
  headersText: ''
})

watch(() => props.mcpOpen, (isOpen) => {
  if (!isOpen) return
  const s = props.editingMcp
  if (s) {
    mcpForm.id = s.id
    mcpForm.name = s.name
    mcpForm.description = s.description || ''
    mcpForm.transport = s.transport
    mcpForm.command = s.command || 'npx'
    mcpForm.argsText = (s.args || []).join(' ')
    mcpForm.url = s.url || ''
    mcpForm.envText = formatKeyValueLines(s.env)
    mcpForm.headersText = formatKeyValueLines(s.headers)
  } else {
    mcpForm.id = ''
    mcpForm.name = ''
    mcpForm.description = ''
    mcpForm.transport = 'stdio'
    mcpForm.command = 'npx'
    mcpForm.argsText = ''
    mcpForm.url = ''
    mcpForm.envText = ''
    mcpForm.headersText = ''
  }
})

async function saveMcpServer() {
  if (!mcpForm.id.trim() || !projectId.value) return
  savingMcp.value = true
  try {
    const pid = encodeURIComponent(projectId.value)
    await apiFetch(`/v1/projects/${pid}/runner/mcp-servers`, {
      method: 'POST',
      body: JSON.stringify({
        id: mcpForm.id.trim(),
        name: mcpForm.name.trim() || mcpForm.id.trim(),
        description: mcpForm.description.trim() || undefined,
        transport: mcpForm.transport,
        command: mcpForm.transport === 'stdio' ? mcpForm.command.trim() : undefined,
        args: mcpForm.transport === 'stdio' ? mcpForm.argsText.trim().split(/\s+/).filter(Boolean) : undefined,
        url: mcpForm.transport !== 'stdio' ? mcpForm.url.trim() : undefined,
        env: parseKeyValueLines(mcpForm.envText),
        headers: mcpForm.transport !== 'stdio' ? parseKeyValueLines(mcpForm.headersText) : undefined
      })
    })
    notify('MCP Server salvo!', mcpForm.id.trim(), 'success')
    emit('update:mcpOpen', false)
    emit('saved')
  } catch (err) {
    notify('Erro ao salvar MCP Server', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingMcp.value = false
  }
}

const jsonInput = ref(`{\n  "mcpServers": {\n    "exemplo": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-memory"]\n    }\n  }\n}`)
const importingJson = ref(false)

async function submitJsonImport() {
  if (!projectId.value || !jsonInput.value.trim()) return
  importingJson.value = true
  try {
    const parsed = JSON.parse(jsonInput.value)
    const pid = encodeURIComponent(projectId.value)
    const res = await apiFetch(`/v1/projects/${pid}/runner/mcp-servers/import`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'json', json: parsed })
    }) as { imported: RunnerMcpServerItem[] }
    notify(`${res.imported.length} MCP(s) importado(s) do JSON`, undefined, 'success')
    emit('update:jsonOpen', false)
    emit('saved')
  } catch (err) {
    notify('Erro ao importar JSON', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    importingJson.value = false
  }
}

const installingPlugin = ref(false)
const customPluginForm = ref({
  id: '',
  name: '',
  description: '',
  source: 'local' as 'builtin' | 'local' | 'npm' | 'git',
  sourceRef: '',
  category: 'workflow' as RunnerPluginItem['category'],
  skillsText: '',
  toolsText: ''
})

async function submitCustomPlugin() {
  if (!projectId.value || !customPluginForm.value.id.trim()) return
  installingPlugin.value = true
  try {
    const pid = encodeURIComponent(projectId.value)
    await apiFetch(`/v1/projects/${pid}/runner/plugins`, {
      method: 'POST',
      body: JSON.stringify({
        id: customPluginForm.value.id.trim(),
        name: customPluginForm.value.name.trim() || customPluginForm.value.id.trim(),
        description: customPluginForm.value.description.trim() || undefined,
        source: customPluginForm.value.source,
        sourceRef: customPluginForm.value.sourceRef.trim() || undefined,
        category: customPluginForm.value.category,
        skills: customPluginForm.value.skillsText.split(',').map(s => s.trim()).filter(Boolean),
        tools: customPluginForm.value.toolsText.split(',').map(s => s.trim()).filter(Boolean)
      })
    })
    notify(`Plugin '${customPluginForm.value.id.trim()}' instalado!`, undefined, 'success')
    emit('update:pluginOpen', false)
    customPluginForm.value = { id: '', name: '', description: '', source: 'local', sourceRef: '', category: 'workflow', skillsText: '', toolsText: '' }
    emit('saved')
  } catch (err) {
    notify('Erro ao instalar plugin', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    installingPlugin.value = false
  }
}

const pluginConfigText = ref('')
const pluginEnvText = ref('')
const savingPluginConfig = ref(false)

watch(() => props.inspectedPlugin, (p) => {
  if (!p) return
  pluginConfigText.value = formatKeyValueLines(p.config)
  pluginEnvText.value = formatKeyValueLines(p.env)
})

async function savePluginConfig() {
  if (!projectId.value || !props.inspectedPlugin) return
  savingPluginConfig.value = true
  try {
    const pid = encodeURIComponent(projectId.value)
    const res = await apiFetch(`/v1/projects/${pid}/runner/plugins/${encodeURIComponent(props.inspectedPlugin.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        config: parseKeyValueLines(pluginConfigText.value),
        env: parseKeyValueLines(pluginEnvText.value)
      })
    }) as { plugin: RunnerPluginItem }
    notify('Configuração do plugin salva!', props.inspectedPlugin.name, 'success')
    emit('update:inspectedPlugin', res.plugin)
    emit('saved')
  } catch (err) {
    notify('Erro ao salvar configuração', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingPluginConfig.value = false
  }
}
</script>

<template>
  <div>
    <!-- Modal: Novo / Editar MCP Server -->
    <UModal
      :open="mcpOpen"
      :title="mcpForm.id ? `MCP Server: ${mcpForm.id}` : 'Novo Servidor MCP'"
      @update:open="(v: boolean) => emit('update:mcpOpen', v)"
    >
      <template #body>
        <div class="space-y-3">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="ID (slug)">
              <UInput v-model="mcpForm.id" placeholder="ex: github, meu-mcp" class="w-full font-mono text-xs" />
            </UFormField>
            <UFormField label="Nome de exibição">
              <UInput v-model="mcpForm.name" placeholder="Ex.: GitHub MCP" class="w-full text-xs" />
            </UFormField>
          </div>
          <UFormField label="Transporte">
            <USelect v-model="mcpForm.transport" :items="['stdio', 'http', 'sse']" class="w-full" />
          </UFormField>
          <template v-if="mcpForm.transport === 'stdio'">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <UFormField label="Comando">
                <UInput v-model="mcpForm.command" placeholder="npx" class="w-full font-mono text-xs" />
              </UFormField>
              <UFormField label="Argumentos (separados por espaço)" class="sm:col-span-2">
                <UInput v-model="mcpForm.argsText" placeholder="-y @modelcontextprotocol/server-memory" class="w-full font-mono text-xs" />
              </UFormField>
            </div>
          </template>
          <template v-else>
            <UFormField label="URL do Servidor MCP">
              <UInput v-model="mcpForm.url" placeholder="http://localhost:3100/mcp" class="w-full font-mono text-xs" />
            </UFormField>
            <UFormField label="Headers (CHAVE=VALOR por linha)">
              <UTextarea v-model="mcpForm.headersText" :rows="2" placeholder="Authorization=Bearer ..." class="w-full font-mono text-xs" />
            </UFormField>
          </template>
          <UFormField label="Variáveis de Ambiente (CHAVE=VALOR por linha)">
            <UTextarea v-model="mcpForm.envText" :rows="3" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..." class="w-full font-mono text-xs" />
          </UFormField>
          <div class="flex justify-end gap-2 pt-2">
            <UButton variant="ghost" @click="emit('update:mcpOpen', false)">Cancelar</UButton>
            <UButton :loading="savingMcp" @click="saveMcpServer">Salvar MCP</UButton>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Modal: Colar JSON mcpServers -->
    <UModal
      :open="jsonOpen"
      title="Importar Servidores MCP via JSON"
      @update:open="(v: boolean) => emit('update:jsonOpen', v)"
    >
      <template #body>
        <div class="space-y-3">
          <p class="text-xs text-muted">Cole a configuração padrão `mcpServers` (compatível com Claude Code, Cursor e Antigravity).</p>
          <UTextarea v-model="jsonInput" :rows="10" class="w-full font-mono text-xs" />
          <div class="flex justify-end gap-2">
            <UButton variant="ghost" @click="emit('update:jsonOpen', false)">Cancelar</UButton>
            <UButton :loading="importingJson" @click="submitJsonImport">Importar JSON</UButton>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Modal: Instalar Plugin Customizado -->
    <UModal
      :open="pluginOpen"
      title="Instalar Plugin Customizado"
      @update:open="(v: boolean) => emit('update:pluginOpen', v)"
    >
      <template #body>
        <div class="space-y-3">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="ID do Plugin">
              <UInput v-model="customPluginForm.id" placeholder="ex: meu-plugin" class="w-full font-mono text-xs" />
            </UFormField>
            <UFormField label="Nome">
              <UInput v-model="customPluginForm.name" placeholder="Meu Plugin" class="w-full text-xs" />
            </UFormField>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="Origem">
              <USelect v-model="customPluginForm.source" :items="['local', 'npm', 'git', 'builtin']" class="w-full" />
            </UFormField>
            <UFormField label="Categoria">
              <USelect v-model="customPluginForm.category" :items="['workflow', 'code', 'security', 'docs', 'integration']" class="w-full" />
            </UFormField>
          </div>
          <UFormField label="Caminho / Pacote / Repositório (opcional)">
            <UInput v-model="customPluginForm.sourceRef" placeholder="./plugins/meu-plugin ou @org/plugin" class="w-full font-mono text-xs" />
          </UFormField>
          <UFormField label="Descrição">
            <UInput v-model="customPluginForm.description" placeholder="O que este plugin faz..." class="w-full text-xs" />
          </UFormField>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="Skills (separadas por vírgula)">
              <UInput v-model="customPluginForm.skillsText" placeholder="review, lint" class="w-full font-mono text-xs" />
            </UFormField>
            <UFormField label="Tools (separadas por vírgula)">
              <UInput v-model="customPluginForm.toolsText" placeholder="check_style" class="w-full font-mono text-xs" />
            </UFormField>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <UButton variant="ghost" @click="emit('update:pluginOpen', false)">Cancelar</UButton>
            <UButton :loading="installingPlugin" @click="submitCustomPlugin">Instalar</UButton>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Slideover: Gerenciar Plugin Específico -->
    <USlideover
      :open="!!inspectedPlugin"
      :title="inspectedPlugin ? `Plugin: ${inspectedPlugin.name}` : ''"
      @update:open="(v: boolean) => { if (!v) emit('update:inspectedPlugin', null) }"
    >
      <template #body>
        <div v-if="inspectedPlugin" class="space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <UBadge :color="inspectedPlugin.enabled ? 'success' : 'neutral'" variant="subtle" size="xs">
                {{ inspectedPlugin.enabled ? 'Ativo' : 'Desativado' }}
              </UBadge>
              <span class="text-xs font-mono text-muted">v{{ inspectedPlugin.version }} · {{ inspectedPlugin.source }}</span>
            </div>
            <UButton size="xs" variant="soft" @click="emit('togglePlugin', inspectedPlugin)">
              {{ inspectedPlugin.enabled ? 'Desativar' : 'Ativar' }}
            </UButton>
          </div>

          <p class="text-xs text-muted">{{ inspectedPlugin.description }}</p>

          <div v-if="inspectedPlugin.sourceRef" class="text-xs font-mono bg-elevated/50 p-2 rounded border border-default">
            Origem: {{ inspectedPlugin.sourceRef }}
          </div>

          <div class="space-y-1.5">
            <div class="text-xs font-medium text-muted">Capacidades expostas</div>
            <div class="flex flex-wrap gap-1">
              <UBadge v-for="sk in inspectedPlugin.skills" :key="`s-${sk}`" color="primary" variant="soft" size="xs">skill: {{ sk }}</UBadge>
              <UBadge v-for="tl in inspectedPlugin.tools" :key="`t-${tl}`" color="info" variant="soft" size="xs">tool: {{ tl }}</UBadge>
              <UBadge v-for="hk in inspectedPlugin.hooks" :key="`h-${hk}`" color="warning" variant="soft" size="xs">hook: {{ hk }}</UBadge>
            </div>
          </div>

          <UFormField label="Configuração do Plugin (CHAVE=VALOR por linha)">
            <UTextarea v-model="pluginConfigText" :rows="4" class="w-full font-mono text-xs" placeholder="strictness=balanced" />
          </UFormField>

          <UFormField label="Variáveis de Ambiente (CHAVE=VALOR por linha)">
            <UTextarea v-model="pluginEnvText" :rows="3" class="w-full font-mono text-xs" placeholder="TOKEN=..." />
          </UFormField>

          <div class="flex items-center justify-between gap-2 pt-2 border-t border-default">
            <UButton size="sm" color="error" variant="ghost" icon="i-lucide-trash-2" @click="emit('uninstallPlugin', inspectedPlugin)">
              Desinstalar
            </UButton>
            <UButton size="sm" icon="i-lucide-save" :loading="savingPluginConfig" @click="savePluginConfig">
              Salvar Configuração
            </UButton>
          </div>
        </div>
      </template>
    </USlideover>
  </div>
</template>

