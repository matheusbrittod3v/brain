<script setup lang="ts">
const props = defineProps<{
  initialTab?: 'overview' | 'oauth' | 'tokens'
}>()

const activeTab = ref<'overview' | 'oauth' | 'tokens'>(props.initialTab ?? 'overview')

watch(
  () => props.initialTab,
  (next) => {
    if (next) activeTab.value = next
  }
)

const tabs = [
  { value: 'overview', label: 'Conta & Permissões', icon: 'i-lucide-user-circle' },
  { value: 'oauth', label: 'OAuth2 IA & MCP', icon: 'i-lucide-shield-check' },
  { value: 'tokens', label: 'Tokens MCP & Codex', icon: 'i-lucide-key-round' }
]
</script>

<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Perfil do Usuário & Conexões MCP"
      description="Gerencie sua conta, autorizações OAuth2 para agentes (Codex, Cursor, Claude) e tokens revogáveis."
      icon="i-lucide-user-cog"
    />

    <UiSegmentedTabs v-model="activeTab" :items="tabs" />

    <ProfileOverviewTab v-if="activeTab === 'overview'" @open-tab="activeTab = $event" />
    <ProfileOAuthTab v-else-if="activeTab === 'oauth'" />
    <ProfileMcpTokensTab v-else-if="activeTab === 'tokens'" />
  </div>
</template>
