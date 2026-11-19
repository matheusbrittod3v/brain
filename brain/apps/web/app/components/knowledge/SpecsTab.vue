<script setup lang="ts">
import type { KnowledgeItemRow } from './knowledgeUtils'

defineProps<{
  specsList: KnowledgeItemRow[]
  canWrite: boolean
  canExecute: boolean
  canApprove: boolean
}>()

const emit = defineEmits<{
  (e: 'create-spec'): void
  (e: 'plan', spec: KnowledgeItemRow): void
  (e: 'approve', itemId: string): void
  (e: 'open', item: KnowledgeItemRow, tab: 'edit' | 'relations'): void
}>()
</script>

<template>
  <div class="space-y-4">
    <UiEmptyState
      v-if="specsList.length === 0"
      icon="i-lucide-file-code-2"
      title="Nenhuma Spec registrada ainda"
      description="Registre especificações técnicas (.brain/specs) para alimentar o Brain Runner e a Análise de Impacto."
    >
      <UButton v-if="canWrite" icon="i-lucide-file-code-2" @click="emit('create-spec')">
        Registrar Primeira Spec
      </UButton>
    </UiEmptyState>

    <div v-else v-auto-animate class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <UCard v-for="spec in specsList" :key="spec.id" variant="subtle">
        <div class="space-y-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="font-semibold text-sm truncate">{{ spec.title }}</h3>
                <UBadge :color="spec.status === 'approved' ? 'success' : 'warning'" variant="subtle" size="xs">
                  {{ spec.status }}
                </UBadge>
              </div>
              <code class="text-[11px] text-muted">{{ spec.id }} · v{{ spec.version ?? 1 }}</code>
            </div>
            <div class="flex gap-1 shrink-0">
              <UButton
                v-if="canExecute"
                size="xs"
                color="primary"
                variant="ghost"
                icon="i-lucide-play"
                title="Gerar tarefas (- [ ]) e enviar ao Runner"
                @click="emit('plan', spec)"
              />
              <UButton
                v-if="canApprove && spec.status !== 'approved'"
                size="xs"
                color="success"
                variant="soft"
                icon="i-lucide-check"
                @click="emit('approve', spec.id)"
              >
                Aprovar
              </UButton>
              <UButton
                size="xs"
                variant="ghost"
                icon="i-lucide-network"
                title="Vínculos no Grafo"
                @click="emit('open', spec, 'relations')"
              />
              <UButton
                v-if="canWrite"
                size="xs"
                variant="soft"
                icon="i-lucide-pencil"
                @click="emit('open', spec, 'edit')"
              >
                Editar
              </UButton>
            </div>
          </div>

          <p class="text-xs text-muted line-clamp-3 whitespace-pre-line">{{ spec.content }}</p>

          <div class="flex flex-wrap gap-1 pt-2 border-t border-default">
            <UBadge v-for="tag in (spec.tags ?? [])" :key="tag" color="info" variant="outline" size="xs">
              #{{ tag }}
            </UBadge>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>

