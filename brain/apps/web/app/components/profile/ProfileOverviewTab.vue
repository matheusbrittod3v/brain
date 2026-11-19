<script setup lang="ts">
const { currentUser, apiUrl, projectId, logout } = useBrainApi()
const emit = defineEmits<{
  openTab: [tab: 'oauth' | 'tokens']
}>()
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <UCard class="lg:col-span-2 border border-default">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div class="flex items-center gap-3.5">
            <UAvatar :alt="currentUser?.name || currentUser?.email || 'User'" size="xl" />
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h2 class="text-base font-semibold text-highlighted truncate">{{ currentUser?.name }}</h2>
                <UBadge v-for="role in (currentUser?.roles ?? [])" :key="role" color="primary" variant="subtle" size="xs">
                  {{ role }}
                </UBadge>
              </div>
              <p class="text-xs text-muted truncate mt-0.5">{{ currentUser?.email }}</p>
              <div class="flex items-center gap-3 mt-1.5 text-[11px] text-muted font-mono">
                <span>ID: {{ currentUser?.id }}</span>
              </div>
            </div>
          </div>

          <UButton color="error" variant="soft" size="sm" icon="i-lucide-log-out" @click="logout">
            Encerrar Sessão
          </UButton>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 pt-4 border-t border-default">
          <div class="rounded-lg bg-elevated/50 p-3">
            <div class="text-[11px] text-muted">Projeto Ativo</div>
            <div class="text-xs font-semibold text-highlighted font-mono mt-0.5 truncate">{{ projectId }}</div>
          </div>
          <div class="rounded-lg bg-elevated/50 p-3">
            <div class="text-[11px] text-muted">Cargos</div>
            <div class="text-xs font-semibold text-highlighted mt-0.5">{{ currentUser?.roles?.length ?? 0 }}</div>
          </div>
          <div class="rounded-lg bg-elevated/50 p-3">
            <div class="text-[11px] text-muted">Permissões</div>
            <div class="text-xs font-semibold text-highlighted mt-0.5">{{ currentUser?.permissions?.length ?? 0 }}</div>
          </div>
          <div class="rounded-lg bg-elevated/50 p-3">
            <div class="text-[11px] text-muted">API Conectada</div>
            <div class="text-xs font-semibold text-highlighted font-mono mt-0.5 truncate">{{ apiUrl }}</div>
          </div>
        </div>
      </UCard>

      <UCard class="border border-default">
        <template #header>
          <div class="flex items-center gap-2 text-sm font-semibold text-highlighted">
            <UIcon name="i-lucide-bot" class="w-4 h-4 text-primary" />
            <span>Acesso Rápido MCP</span>
          </div>
        </template>
        <div class="space-y-2.5 text-xs text-muted">
          <p>Conecte Codex, Cursor ou Claude Code ao Brain usando OAuth 2.1 ou Bearer Tokens revogáveis.</p>
          <div class="flex flex-col gap-2 pt-1">
            <UButton size="sm" variant="soft" color="primary" icon="i-lucide-shield-check" block @click="emit('openTab', 'oauth')">
              Autorizar OAuth2 IA &amp; MCP
            </UButton>
            <UButton size="sm" variant="outline" color="neutral" icon="i-lucide-key-round" block @click="emit('openTab', 'tokens')">
              Gerenciar Tokens MCP
            </UButton>
          </div>
        </div>
      </UCard>
    </div>

    <UCard class="border border-default">
      <template #header>
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold text-highlighted">Permissões Efetivas da Sessão</span>
          <UBadge color="neutral" variant="subtle" size="xs">{{ currentUser?.permissions?.length ?? 0 }} ativas</UBadge>
        </div>
      </template>
      <div v-if="(currentUser?.permissions?.length ?? 0) === 0" class="text-xs text-muted">
        Nenhuma permissão explícita carregada.
      </div>
      <div v-else class="flex flex-wrap gap-1.5">
        <UBadge v-for="perm in (currentUser?.permissions ?? [])" :key="perm" color="neutral" variant="subtle" size="xs" class="font-mono">
          {{ perm }}
        </UBadge>
      </div>
    </UCard>
  </div>
</template>
