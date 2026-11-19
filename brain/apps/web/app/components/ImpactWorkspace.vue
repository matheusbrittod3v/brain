<script setup lang="ts">
import { z } from 'zod'

const props = defineProps<{
  knowledgeItems: Array<{ id: string; title: string; type: string }>
}>()

const { projectId, apiFetch, notify } = useBrainApi()

const activeTab = ref<'blast' | 'assistant' | 'checklist' | 'contradictions'>('blast')

// 1. Blast Radius
const schema = z.object({
  itemId: z.string().min(1, 'Selecione ou informe o ID do item')
})
const state = reactive({ itemId: '' })
const loadingBlast = ref(false)
const impactResult = ref<any>(null)

async function analyzeImpact() {
  loadingBlast.value = true
  try {
    const res = await apiFetch<any>(
      `/v1/projects/${encodeURIComponent(projectId.value)}/change/impact`,
      {
        method: 'POST',
        body: JSON.stringify({ targetIds: [state.itemId.trim()] })
      }
    )
    impactResult.value = res
    notify('Análise de impacto concluída')
  } catch (err) {
    notify('Erro na análise de impacto', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loadingBlast.value = false
  }
}

// 2. Change Assistant
const assistantForm = reactive({
  plan: '',
  diff: '',
  filePaths: ''
})
const loadingAssistant = ref(false)
const assistantResult = ref<{
  riskLevel: string
  summary: string
  directlyAffectedRules: Array<{ id: string; title: string; policy: string; summary: string }>
  impactedDocuments: Array<{ id: string; title: string; type: string; policy: string }>
  relatedFiles: string[]
  recommendedActions: string[]
} | null>(null)

async function runChangeAssistant() {
  loadingAssistant.value = true
  try {
    const files = assistantForm.filePaths
      .split('\n')
      .map(f => f.trim())
      .filter(Boolean)
    const res = await apiFetch<typeof assistantResult.value>(
      `/v1/projects/${encodeURIComponent(projectId.value)}/intelligence/change-assistant`,
      {
        method: 'POST',
        body: JSON.stringify({
          plan: assistantForm.plan,
          diff: assistantForm.diff,
          filePaths: files
        })
      }
    )
    assistantResult.value = res
    notify('Assistente de Mudança executado')
  } catch (err) {
    notify('Erro no assistente de mudança', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loadingAssistant.value = false
  }
}

// 3. PR Review Checklist
const prForm = reactive({
  title: 'Evolução de regras e novos endpoints',
  branch: 'main',
  filePaths: ''
})
const loadingChecklist = ref(false)
const checklistResult = ref<{
  prTitle: string
  branch: string
  checklist: Array<{ category: string; item: string }>
  relevantRules: Array<{ id: string; title: string }>
} | null>(null)

async function generateChecklist() {
  loadingChecklist.value = true
  try {
    const files = prForm.filePaths.split('\n').map(f => f.trim()).filter(Boolean)
    const res = await apiFetch<typeof checklistResult.value>(
      `/v1/projects/${encodeURIComponent(projectId.value)}/intelligence/pr-review-checklist`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: prForm.title,
          branch: prForm.branch,
          filePaths: files
        })
      }
    )
    checklistResult.value = res
    notify('Checklist de Revisão gerado')
  } catch (err) {
    notify('Erro ao gerar checklist', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loadingChecklist.value = false
  }
}

// 4. Contradictions Detection
const loadingContradictions = ref(false)
const contradictionsData = ref<{
  totalContradictions: number
  contradictions: Array<{
    id: string
    itemA: { id: string; title: string; type: string }
    itemB: { id: string; title: string; type: string }
    reason: string
    severity: string
    resolutionSuggestion: string
  }>
} | null>(null)

async function loadContradictions() {
  loadingContradictions.value = true
  try {
    contradictionsData.value = await apiFetch<typeof contradictionsData.value>(
      `/v1/projects/${encodeURIComponent(projectId.value)}/intelligence/contradictions`
    )
  } catch (err) {
    notify('Erro ao verificar contradições', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    loadingContradictions.value = false
  }
}

watch(activeTab, (tab) => {
  if (tab === 'contradictions' && !contradictionsData.value) {
    loadContradictions()
  }
})
</script>

<template>
  <div class="space-y-6">
    <UiPageHeader
      title="Inteligência de Mudança, Impacto & Revisão"
      description="Assistente preditivo de impacto, cálculo de blast radius, detecção de contradições e checklists para PRs"
      icon="i-lucide-zap"
    />

    <!-- Navigation Tabs -->
    <div class="flex flex-wrap gap-2 border-b border-default pb-3">
      <UButton
        size="sm"
        :variant="activeTab === 'blast' ? 'solid' : 'soft'"
        color="primary"
        icon="i-lucide-radar"
        @click="activeTab = 'blast'"
      >
        Raio de Explosão (Blast Radius)
      </UButton>
      <UButton
        size="sm"
        :variant="activeTab === 'assistant' ? 'solid' : 'soft'"
        color="primary"
        icon="i-lucide-sparkles"
        @click="activeTab = 'assistant'"
      >
        Assistente de Mudança (Diff &amp; Plano)
      </UButton>
      <UButton
        size="sm"
        :variant="activeTab === 'checklist' ? 'solid' : 'soft'"
        color="primary"
        icon="i-lucide-check-square"
        @click="activeTab = 'checklist'"
      >
        Modelos de Revisão (PR Checklist)
      </UButton>
      <UButton
        size="sm"
        :variant="activeTab === 'contradictions' ? 'solid' : 'soft'"
        color="primary"
        icon="i-lucide-alert-triangle"
        @click="activeTab = 'contradictions'"
      >
        Detecção de Contradições
      </UButton>
    </div>

    <!-- TAB 1: BLAST RADIUS -->
    <div v-if="activeTab === 'blast'" class="space-y-6">
      <UCard>
        <UForm :schema="schema" :state="state" class="grid grid-cols-1 md:grid-cols-12 gap-4 items-end" @submit="analyzeImpact">
          <UFormField label="Item ou Regra Alvo" name="itemId" class="md:col-span-6">
            <UInput v-model="state.itemId" placeholder="Ex.: BR-BRAIN-001 ou ID do item" class="w-full font-mono" />
          </UFormField>

          <UFormField label="Selecionar do Projeto" class="md:col-span-4">
            <USelect
              :items="props.knowledgeItems.map(k => ({ label: `${k.id} — ${k.title}`, value: k.id }))"
              placeholder="Escolher item indexado..."
              class="w-full"
              @update:model-value="(v: string) => { state.itemId = v }"
            />
          </UFormField>

          <div class="md:col-span-2">
            <UButton type="submit" block :loading="loadingBlast" icon="i-lucide-zap">
              Analisar
            </UButton>
          </div>
        </UForm>
      </UCard>

      <UiEmptyState
        v-if="!impactResult"
        icon="i-lucide-radar"
        title="Pronto para simular impacto"
        description="Informe ou selecione um ID acima para calcular impactos diretos, transitivos e contratos entre serviços."
      />

      <div v-else class="space-y-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <UiStatCard
            label="Nível de Risco"
            :value="(impactResult.riskLevel || 'low').toUpperCase()"
            icon="i-lucide-alert-triangle"
            :tone="impactResult.riskLevel === 'critical' ? 'error' : impactResult.riskLevel === 'high' ? 'warning' : 'success'"
          />
          <UiStatCard
            label="Impactos Diretos"
            :value="impactResult.directImpacts?.length ?? 0"
            icon="i-lucide-git-commit-horizontal"
            tone="primary"
          />
          <UiStatCard
            label="Impactos Transitivos"
            :value="impactResult.transitiveImpacts?.length ?? 0"
            icon="i-lucide-git-fork"
            tone="warning"
          />
          <UiStatCard
            label="Regras Críticas"
            :value="impactResult.criticalRulesImpacted?.length ?? 0"
            icon="i-lucide-shield-alert"
            tone="error"
          />
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <UCard>
            <template #header>
              <div class="flex items-center justify-between">
                <h3 class="font-semibold text-sm">Nós Diretamente Afetados</h3>
                <UBadge color="primary" variant="subtle" size="xs">{{ impactResult.directImpacts?.length ?? 0 }}</UBadge>
              </div>
            </template>
            <UiEmptyState v-if="!impactResult.directImpacts?.length" compact icon="i-lucide-check-circle" title="Nenhum impacto direto" />
            <div v-else class="space-y-2">
              <div
                v-for="hit in impactResult.directImpacts"
                :key="`${hit.itemId}-${hit.via}`"
                class="flex items-center justify-between p-2.5 rounded-lg border border-default bg-elevated/40"
              >
                <span class="font-mono text-xs font-semibold">{{ hit.itemId }}</span>
                <div class="flex items-center gap-1.5">
                  <UBadge color="neutral" variant="outline" size="xs">{{ hit.via }}</UBadge>
                  <UBadge :color="hit.isInferred ? 'warning' : 'success'" variant="subtle" size="xs">
                    {{ hit.isInferred ? 'Hipótese' : 'Confirmado' }}
                  </UBadge>
                </div>
              </div>
            </div>
          </UCard>

          <UCard>
            <template #header>
              <div class="flex items-center justify-between">
                <h3 class="font-semibold text-sm">Impactos Transitivos</h3>
                <UBadge color="warning" variant="subtle" size="xs">{{ impactResult.transitiveImpacts?.length ?? 0 }}</UBadge>
              </div>
            </template>
            <UiEmptyState v-if="!impactResult.transitiveImpacts?.length" compact icon="i-lucide-check-circle" title="Nenhum impacto transitivo" />
            <div v-else class="space-y-2">
              <div
                v-for="hit in impactResult.transitiveImpacts"
                :key="`${hit.itemId}-${hit.hops}`"
                class="flex items-center justify-between p-2.5 rounded-lg border border-default bg-elevated/40"
              >
                <span class="font-mono text-xs font-semibold">{{ hit.itemId }}</span>
                <div class="flex items-center gap-1.5">
                  <UBadge color="warning" variant="subtle" size="xs">{{ hit.hops }} hops</UBadge>
                  <UBadge color="neutral" variant="outline" size="xs">{{ hit.via }}</UBadge>
                </div>
              </div>
            </div>
          </UCard>
        </div>
      </div>
    </div>

    <!-- TAB 2: CHANGE ASSISTANT -->
    <div v-else-if="activeTab === 'assistant'" class="space-y-6">
      <UCard>
        <template #header>
          <h3 class="text-sm font-semibold">Assistente de Mudança (Plano &amp; Git Diff)</h3>
          <p class="text-xs text-muted">Aponte o que pretende alterar e descubra regras afetadas, dependências e impacto provável</p>
        </template>
        <div class="space-y-4">
          <UFormField label="Resumo do Plano ou Objetivo da Mudança">
            <UInput v-model="assistantForm.plan" placeholder="Ex.: Refatorar autenticação para suportar OAuth2 Device Flow sem Keycloak" class="w-full" />
          </UFormField>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <UFormField label="Arquivos Modificados (um por linha)">
              <UTextarea v-model="assistantForm.filePaths" placeholder="apps/api/src/server.ts&#10;packages/auth/src/casl.ts" :rows="4" class="w-full font-mono text-xs" />
            </UFormField>
            <UFormField label="Git Diff ou Trecho de Código Alterado">
              <UTextarea v-model="assistantForm.diff" placeholder="Cole aqui o diff ou resumo das funções alteradas..." :rows="4" class="w-full font-mono text-xs" />
            </UFormField>
          </div>
          <UButton icon="i-lucide-sparkles" :loading="loadingAssistant" @click="runChangeAssistant">
            Executar Assistente de Mudança
          </UButton>
        </div>
      </UCard>

      <div v-if="assistantResult" class="space-y-4">
        <UAlert
          :color="assistantResult.riskLevel === 'critical' ? 'error' : assistantResult.riskLevel === 'high' ? 'warning' : 'primary'"
          variant="subtle"
          icon="i-lucide-shield-alert"
          :title="`Nível de Risco: ${assistantResult.riskLevel.toUpperCase()}`"
          :description="assistantResult.summary"
        />

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <UCard>
            <template #header>
              <h4 class="text-xs font-semibold uppercase tracking-wider">Regras de Negócio Afetadas ({{ assistantResult.directlyAffectedRules.length }})</h4>
            </template>
            <div v-if="!assistantResult.directlyAffectedRules.length" class="text-xs text-muted">Nenhuma regra crítica diretamente impactada.</div>
            <div v-else class="space-y-2">
              <div v-for="r in assistantResult.directlyAffectedRules" :key="r.id" class="p-2.5 rounded-lg border border-default bg-elevated/40">
                <div class="flex items-center justify-between">
                  <span class="font-mono text-xs font-bold text-primary">{{ r.id }}</span>
                  <UBadge color="neutral" variant="outline" size="xs">{{ r.policy }}</UBadge>
                </div>
                <div class="text-xs font-medium text-highlighted mt-1">{{ r.title }}</div>
                <div class="text-[11px] text-muted mt-0.5">{{ r.summary }}</div>
              </div>
            </div>
          </UCard>

          <UCard>
            <template #header>
              <h4 class="text-xs font-semibold uppercase tracking-wider">Ações Recomendadas</h4>
            </template>
            <ul class="space-y-2">
              <li v-for="(act, idx) in assistantResult.recommendedActions" :key="idx" class="flex items-start gap-2 text-xs">
                <UIcon name="i-lucide-check-circle-2" class="size-4 text-primary shrink-0 mt-0.5" />
                <span>{{ act }}</span>
              </li>
            </ul>
          </UCard>
        </div>
      </div>
    </div>

    <!-- TAB 3: PR REVIEW CHECKLIST -->
    <div v-else-if="activeTab === 'checklist'" class="space-y-6">
      <UCard>
        <template #header>
          <h3 class="text-sm font-semibold">Gerador de Checklist de Revisão de PR</h3>
          <p class="text-xs text-muted">Cria listas de verificação customizadas para PRs baseadas em regras de negócio e arquivos tocados</p>
        </template>
        <div class="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          <UFormField label="Título do PR" class="md:col-span-5">
            <UInput v-model="prForm.title" class="w-full" />
          </UFormField>
          <UFormField label="Branch Destino" class="md:col-span-3">
            <UInput v-model="prForm.branch" class="w-full font-mono text-xs" />
          </UFormField>
          <UFormField label="Arquivos no PR" class="md:col-span-4">
            <UInput v-model="prForm.filePaths" placeholder="server.ts, auth.ts" class="w-full text-xs font-mono" />
          </UFormField>
        </div>
        <div class="mt-4">
          <UButton icon="i-lucide-list-checks" :loading="loadingChecklist" @click="generateChecklist">
            Gerar Checklist de Revisão
          </UButton>
        </div>
      </UCard>

      <div v-if="checklistResult" class="space-y-4">
        <UCard>
          <template #header>
            <div class="flex items-center justify-between">
              <h4 class="font-semibold text-sm">Checklist Automatizado para "{{ checklistResult.prTitle }}"</h4>
              <UBadge color="primary" variant="subtle" size="xs">Branch: {{ checklistResult.branch }}</UBadge>
            </div>
          </template>
          <div class="space-y-3">
            <div v-for="(chk, idx) in checklistResult.checklist" :key="idx" class="p-3 rounded-xl border border-default bg-elevated/40 flex items-start gap-3">
              <UBadge color="neutral" variant="outline" size="xs" class="shrink-0 mt-0.5">{{ chk.category }}</UBadge>
              <span class="text-xs text-highlighted">{{ chk.item }}</span>
            </div>
          </div>
        </UCard>
      </div>
    </div>

    <!-- TAB 4: CONTRADICTIONS -->
    <div v-else-if="activeTab === 'contradictions'" class="space-y-6">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-sm font-semibold">Detecção de Contradições e Conflitos</h3>
          <p class="text-xs text-muted">Varredura automática de diretrizes opostas ou conflitos entre regras de negócio e ADRs</p>
        </div>
        <UButton size="sm" variant="soft" icon="i-lucide-refresh-cw" :loading="loadingContradictions" @click="loadContradictions">
          Escanear Novamente
        </UButton>
      </div>

      <UiEmptyState
        v-if="!contradictionsData?.contradictions?.length"
        icon="i-lucide-shield-check"
        title="Nenhuma contradição detectada"
        description="Todas as regras de negócio e decisões de arquitetura analisadas estão coerentes entre si."
      />

      <div v-else class="space-y-3">
        <div
          v-for="c in contradictionsData.contradictions"
          :key="c.id"
          class="p-4 rounded-xl border border-warning/50 bg-warning/5 space-y-2"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-alert-triangle" class="size-4 text-warning" />
              <span class="font-mono text-xs font-bold">{{ c.id }}</span>
            </div>
            <UBadge :color="c.severity === 'high' ? 'error' : 'warning'" variant="subtle" size="xs">
              Severidade: {{ c.severity.toUpperCase() }}
            </UBadge>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
            <div class="p-2 rounded bg-elevated border border-default">
              <span class="font-bold">Item A:</span> {{ c.itemA.id }} — {{ c.itemA.title }}
            </div>
            <div class="p-2 rounded bg-elevated border border-default">
              <span class="font-bold">Item B:</span> {{ c.itemB.id }} — {{ c.itemB.title }}
            </div>
          </div>
          <p class="text-xs text-highlighted font-medium">{{ c.reason }}</p>
          <p class="text-[11px] text-muted"><span class="font-bold">Sugestão:</span> {{ c.resolutionSuggestion }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
