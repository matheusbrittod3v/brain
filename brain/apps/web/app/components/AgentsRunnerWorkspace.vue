<script setup lang="ts">
import type { RunnerTaskItem } from './RunnerTasksPanel.vue'

const props = defineProps<{
  tasks: RunnerTaskItem[]
  loading?: boolean
}>()

const emit = defineEmits<{
  refresh: []
}>()

const subTab = ref<'chat' | 'tasks' | 'models' | 'extensions'>('chat')

const activeTasksCount = computed(() =>
  props.tasks.filter(t => t.status === 'queued' || t.status === 'running').length
)
</script>

<template>
  <div>
    <UiPageHeader
      title="Agentes &amp; Brain Runner"
      description="Delegue tarefas assíncronas ao Brain Runner e acompanhe a fila de execução"
      icon="i-lucide-bot"
    >
      <template #actions>
        <UButton size="sm" variant="ghost" icon="i-lucide-refresh-cw" :loading="loading" @click="emit('refresh')">
          Atualizar
        </UButton>
      </template>
    </UiPageHeader>

    <div class="mb-5">
      <UiSegmentedTabs
        v-model="subTab"
        :items="[
          { label: 'Chat', value: 'chat', icon: 'i-lucide-message-square-code' },
          { label: 'Execuções', value: 'tasks', icon: 'i-lucide-list-checks', badge: activeTasksCount || undefined },
          { label: 'Modelos & Conexões', value: 'models', icon: 'i-lucide-cpu' },
          { label: 'Plugins & MCPs', value: 'extensions', icon: 'i-lucide-blocks' }
        ]"
      />
    </div>

    <RunnerChatPanel v-if="subTab === 'chat'" />

    <RunnerModelsPanel v-else-if="subTab === 'models'" />

    <RunnerExtensionsPanel v-else-if="subTab === 'extensions'" />

    <RunnerTasksPanel
      v-else
      :tasks="tasks"
      :loading="loading"
      @refresh="emit('refresh')"
    />
  </div>
</template>

