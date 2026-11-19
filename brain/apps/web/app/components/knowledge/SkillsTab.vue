<script setup lang="ts">
import type { KnowledgeItemRow } from './knowledgeUtils'

defineProps<{
  skillsList: KnowledgeItemRow[]
  canWrite: boolean
}>()

const emit = defineEmits<{
  (e: 'create-skill'): void
  (e: 'open', item: KnowledgeItemRow, tab: 'read' | 'edit'): void
}>()
</script>

<template>
  <div class="space-y-4">
    <UAlert
      color="primary"
      variant="subtle"
      icon="i-lucide-bot"
      title="Skills Centralizadas via MCP (.brain/skills)"
      description="Qualquer agente conectado ao Brain (Cursor, Claude Code, NanoClaw, Brain Runner) descobre e carrega estas skills (do projeto e globais __org__) pelas tools brain_list_skills e brain_get_skill."
    />

    <UiEmptyState
      v-if="skillsList.length === 0"
      icon="i-lucide-sparkles"
      title="Nenhuma Skill cadastrada"
      description="Crie sua primeira Skill (estilo SKILL.md) para padronizar fluxos entre todos os seus agentes."
    >
      <UButton v-if="canWrite" icon="i-lucide-sparkles" @click="emit('create-skill')">
        Criar Primeira Skill
      </UButton>
    </UiEmptyState>

    <div v-else v-auto-animate class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <UCard v-for="skill in skillsList" :key="`${skill.projectId}-${skill.id}`" variant="subtle">
        <div class="space-y-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 flex-wrap">
                <h3 class="font-semibold text-sm truncate">{{ skill.title }}</h3>
                <UBadge v-if="skill.scope === 'org' || skill.projectId === '__org__'" color="info" variant="solid" size="xs">
                  Global (__org__)
                </UBadge>
                <UBadge :color="skill.status === 'approved' ? 'success' : 'warning'" variant="subtle" size="xs">
                  {{ skill.status }}
                </UBadge>
              </div>
              <code class="text-[11px] text-muted">{{ skill.id }} · v{{ skill.version ?? 1 }}</code>
            </div>
            <div class="flex gap-1 shrink-0">
              <UButton size="xs" variant="soft" icon="i-lucide-eye" @click="emit('open', skill, 'read')">Abrir</UButton>
              <UButton
                v-if="canWrite"
                size="xs"
                variant="ghost"
                icon="i-lucide-pencil"
                @click="emit('open', skill, 'edit')"
              />
            </div>
          </div>

          <p class="text-xs text-muted line-clamp-3 whitespace-pre-line">
            {{ skill.summary || skill.content }}
          </p>

          <div class="flex flex-wrap gap-1 pt-2 border-t border-default">
            <UBadge v-for="tag in (skill.tags ?? [])" :key="tag" color="primary" variant="outline" size="xs">
              #{{ tag }}
            </UBadge>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>

