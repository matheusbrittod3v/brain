<script setup lang="ts">
const props = defineProps<{
  projectId: string
}>()

const { apiFetch, notify } = useBrainApi()

const filePath = ref('apps/api/src/server.ts')
const codeSnippet = ref(`export async function handleUserSession(req: FastifyRequest) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const auth = await authenticateRequest(token);
  return { actorId: auth.actorId, allowedProjects: auth.allowedProjects };
}`)

const loading = ref(false)
const explanation = ref<{
  filePath: string
  summary: string
  architectureFit: string
  governingRules: Array<{ id: string; title: string; status: string }>
  potentialConstraints: Array<{ id: string; title: string; type: string }>
  codeQualityCheck: { hasAuthCheck: boolean; hasErrorHandling: boolean; hasAuditLogging: boolean }
  contextualAdvice: string[]
} | null>(null)

async function explainCode() {
  if (!props.projectId || !codeSnippet.value.trim()) return
  loading.value = true
  try {
    explanation.value = await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/daily/explain-code`, {
      method: 'POST',
      body: JSON.stringify({ codeSnippet: codeSnippet.value, filePath: filePath.value })
    })
    notify('Explicação gerada com sucesso!')
  } catch (err) {
    notify('Erro ao explicar código', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <UCard>
      <template #header>
        <div class="space-y-1">
          <h3 class="font-semibold text-sm">Explicação de Código no Contexto do Projeto</h3>
          <p class="text-xs text-muted">Cole qualquer função ou trecho de código. O Brain descreve seu funcionamento relacionando-o às regras de negócio, decisões arquiteturais e políticas CASL do projeto.</p>
        </div>
      </template>

      <div class="space-y-3">
        <UInput v-model="filePath" placeholder="Caminho do arquivo (opcional, ex: apps/api/src/server.ts)..." size="sm" />
        <UTextarea
          v-model="codeSnippet"
          :rows="6"
          placeholder="Cole o código aqui..."
          class="font-mono text-xs"
        />
        <div class="flex justify-end">
          <UButton color="primary" icon="i-lucide-code" :loading="loading" :disabled="!codeSnippet.trim()" @click="explainCode">
            Explicar Código no Contexto
          </UButton>
        </div>
      </div>
    </UCard>

    <!-- Results -->
    <div v-if="explanation" class="space-y-4">
      <div class="p-4 rounded-xl border border-primary/20 bg-primary/5 space-y-1 text-xs">
        <span class="font-semibold text-primary">Visão Arquitetural: </span>
        <span class="text-highlighted">{{ explanation.summary }}</span>
        <p class="text-muted pt-1">{{ explanation.architectureFit }}</p>
      </div>

      <!-- Quality & Security Badges -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <div class="p-2.5 rounded-lg border border-default bg-elevated/40 flex items-center justify-between text-xs">
          <span>Verificação de Auth / CASL:</span>
          <UBadge :color="explanation.codeQualityCheck.hasAuthCheck ? 'success' : 'warning'" size="xs" variant="subtle">
            {{ explanation.codeQualityCheck.hasAuthCheck ? 'Detectado' : 'Ausente' }}
          </UBadge>
        </div>
        <div class="p-2.5 rounded-lg border border-default bg-elevated/40 flex items-center justify-between text-xs">
          <span>Tratamento de Erros:</span>
          <UBadge :color="explanation.codeQualityCheck.hasErrorHandling ? 'success' : 'warning'" size="xs" variant="subtle">
            {{ explanation.codeQualityCheck.hasErrorHandling ? 'Presente' : 'Não identificado' }}
          </UBadge>
        </div>
        <div class="p-2.5 rounded-lg border border-default bg-elevated/40 flex items-center justify-between text-xs">
          <span>Trilha de Auditoria:</span>
          <UBadge :color="explanation.codeQualityCheck.hasAuditLogging ? 'success' : 'neutral'" size="xs" variant="subtle">
            {{ explanation.codeQualityCheck.hasAuditLogging ? 'Presente' : 'Opcional' }}
          </UBadge>
        </div>
      </div>

      <!-- Governing Rules -->
      <div v-if="explanation.governingRules.length > 0" class="space-y-1.5">
        <h4 class="text-xs font-semibold text-warning flex items-center gap-1.5">
          <UIcon name="i-lucide-shield-check" class="size-3.5" />
          Regras de Negócio que Governam Este Padrão
        </h4>
        <div class="space-y-1">
          <div
            v-for="r in explanation.governingRules"
            :key="r.id"
            class="flex items-center justify-between p-2 rounded-lg border border-default bg-elevated/30 text-xs"
          >
            <span class="font-medium">{{ r.title }}</span>
            <UBadge color="warning" variant="subtle" size="xs">{{ r.id }}</UBadge>
          </div>
        </div>
      </div>

      <!-- Advice -->
      <div class="p-3.5 rounded-xl border border-default bg-elevated/50 space-y-1.5 text-xs">
        <span class="font-semibold text-highlighted">Orientações do Brain:</span>
        <ul class="space-y-1">
          <li v-for="(adv, idx) in explanation.contextualAdvice" :key="idx" class="text-muted flex items-start gap-1.5">
            <span class="text-primary font-bold">›</span>
            <span>{{ adv }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
