<script setup lang="ts">
const { projectId, apiFetch, notify } = useBrainApi()

const loading = ref(false)
const syncingProvider = ref<string | null>(null)
const reprocessItemId = ref('')
const reprocessExtractor = ref<'native-markdown' | 'ai-worker-structured' | 'pii-strict'>('pii-strict')
const reprocessing = ref(false)

interface HealthDashboard {
  projectId: string
  checkedAt: string
  connections: Record<string, { online: boolean; latencyMs: number; detail: string }>
  ingestionPipeline: {
    totalItems: number
    embeddedItems: number
    pendingEmbeddings: number
    lastIngestedAt: string | null
    queuedRunnerTasks: number
    failedRunnerTasks: number
  }
  alerts: Array<{ severity: 'warning' | 'error' | 'info'; title: string; detail: string }>
}

interface DoctorReport {
  healthy: boolean
  score: number
  checkedAt: string
  checks: Array<{ id: string; label: string; ok: boolean; detail: string; suggestedFix: string | null }>
}

interface ConnectorsPayload {
  projectId: string
  connectors: Array<{
    provider: 'github' | 'gitlab' | 'gdrive' | 'notion'
    name: string
    incrementalCursor: string
    lastSyncedAt: string | null
    syncedItemsCount: number
    status: string
  }>
  storageLifecycle: {
    bucket: string
    presignedUrlTtlSeconds: number
    maxArtifactBytes: number
    retentionPolicy: string
  }
  documents: Array<{
    id: string
    title: string
    type: string
    sourceOrigin: string
    sourceVersion: string
    syncedAt: string
    extractorModel: string
    minioUri: string | null
  }>
}

const health = ref<HealthDashboard | null>(null)
const doctor = ref<DoctorReport | null>(null)
const connectorsData = ref<ConnectorsPayload | null>(null)

async function loadAll() {
  loading.value = true
  const pid = encodeURIComponent(projectId.value || 'brain')
  try {
    const [hRes, dRes, cRes] = await Promise.all([
      apiFetch<HealthDashboard>(`/v1/projects/${pid}/operations/health-dashboard`).catch(() => null),
      apiFetch<DoctorReport>('/v1/system/doctor').catch(() => null),
      apiFetch<ConnectorsPayload>(`/v1/projects/${pid}/connectors/sources`).catch(() => null)
    ])
    health.value = hRes
    doctor.value = dRes
    connectorsData.value = cRes
    if (!reprocessItemId.value && cRes?.documents?.[0]?.id) {
      reprocessItemId.value = cRes.documents[0].id
    }
  } finally {
    loading.value = false
  }
}

async function syncConnector(provider: 'github' | 'gitlab' | 'gdrive' | 'notion') {
  const pid = encodeURIComponent(projectId.value || 'brain')
  syncingProvider.value = provider
  try {
    await apiFetch(`/v1/projects/${pid}/connectors/sync`, {
      method: 'POST',
      body: JSON.stringify({ provider })
    })
    notify('Sincronização incremental concluída', `Conector '${provider}' sincronizado e snapshot gravado no MinIO.`, 'success')
    await loadAll()
  } catch (err) {
    notify('Erro ao sincronizar conector', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    syncingProvider.value = null
  }
}

async function reprocessItem() {
  if (!reprocessItemId.value.trim()) return
  const pid = encodeURIComponent(projectId.value || 'brain')
  const iid = encodeURIComponent(reprocessItemId.value.trim())
  reprocessing.value = true
  try {
    const res = await apiFetch<{ version: number; sourceVersion: string; extractorModel: string }>(
      `/v1/projects/${pid}/knowledge/${iid}/reprocess`,
      {
        method: 'POST',
        body: JSON.stringify({ extractor: reprocessExtractor.value, embeddingModel: 'bge-m3' })
      }
    )
    notify(
      'Ingestão reprocessada!',
      `${reprocessItemId.value} -> ${res.sourceVersion} (${res.extractorModel})`,
      'success'
    )
    await loadAll()
  } catch (err) {
    notify('Erro ao reprocessar item', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    reprocessing.value = false
  }
}

onMounted(loadAll)
watch(projectId, loadAll)
</script>

<template>
  <div class="space-y-5">
    <!-- Alertas Ativos -->
    <div v-if="health?.alerts?.length" class="space-y-2">
      <UAlert
        v-for="(alert, idx) in health.alerts"
        :key="idx"
        :color="alert.severity === 'error' ? 'error' : alert.severity === 'warning' ? 'warning' : 'info'"
        variant="subtle"
        icon="i-lucide-bell-ring"
        :title="alert.title"
        :description="alert.detail"
      />
    </div>

    <!-- Painel de Saúde Operacional & Conexões (Prioridade 2) -->
    <UCard class="border border-default">
      <template #header>
        <div class="flex items-center justify-between">
          <div>
            <h3 class="text-sm font-semibold text-highlighted">Painel de Saúde do Projeto &amp; Conexões</h3>
            <p class="text-xs text-muted">Estado em tempo real do pipeline de ingestão, embeddings pendentes, filas e serviços integrados.</p>
          </div>
          <UButton size="xs" variant="soft" icon="i-lucide-refresh-cw" :loading="loading" @click="loadAll">
            Diagnosticar
          </UButton>
        </div>
      </template>

      <div v-if="health" class="space-y-4">
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <div class="rounded-xl border border-default bg-elevated/40 p-3">
            <div class="text-[11px] text-muted">Itens Indexados</div>
            <div class="text-base font-bold text-highlighted mt-0.5">{{ health.ingestionPipeline.totalItems }}</div>
          </div>
          <div class="rounded-xl border border-default bg-elevated/40 p-3">
            <div class="text-[11px] text-muted">Embeddings (bge-m3)</div>
            <div class="text-base font-bold text-success mt-0.5">{{ health.ingestionPipeline.embeddedItems }}</div>
          </div>
          <div class="rounded-xl border border-default bg-elevated/40 p-3">
            <div class="text-[11px] text-muted">Embeddings Pendentes</div>
            <div class="text-base font-bold text-highlighted mt-0.5">{{ health.ingestionPipeline.pendingEmbeddings }}</div>
          </div>
          <div class="rounded-xl border border-default bg-elevated/40 p-3">
            <div class="text-[11px] text-muted">Fila Runner Ativa</div>
            <div class="text-base font-bold text-highlighted mt-0.5">{{ health.ingestionPipeline.queuedRunnerTasks }}</div>
          </div>
          <div class="rounded-xl border border-default bg-elevated/40 p-3">
            <div class="text-[11px] text-muted">Falhas Recentes</div>
            <div class="text-base font-bold" :class="health.ingestionPipeline.failedRunnerTasks > 0 ? 'text-error' : 'text-highlighted'">
              {{ health.ingestionPipeline.failedRunnerTasks }}
            </div>
          </div>
          <div class="rounded-xl border border-default bg-elevated/40 p-3">
            <div class="text-[11px] text-muted">Última Ingestão</div>
            <div class="text-xs font-mono font-semibold text-highlighted mt-1 truncate">
              {{ health.ingestionPipeline.lastIngestedAt ? new Date(health.ingestionPipeline.lastIngestedAt).toLocaleTimeString('pt-BR') : '—' }}
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div
            v-for="(conn, key) in health.connections"
            :key="key"
            class="rounded-xl border border-default p-3 flex flex-col justify-between gap-1.5"
          >
            <div class="flex items-center justify-between">
              <span class="text-xs font-semibold uppercase tracking-wide text-highlighted">{{ key }}</span>
              <UBadge :color="conn.online ? 'success' : 'error'" variant="subtle" size="xs">
                {{ conn.online ? `${conn.latencyMs}ms` : 'Offline' }}
              </UBadge>
            </div>
            <div class="text-[11px] text-muted">{{ conn.detail }}</div>
          </div>
        </div>
      </div>
    </UCard>

    <!-- Assistente Brain Doctor (Prioridade 5) -->
    <UCard v-if="doctor" class="border border-default">
      <template #header>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <UIcon name="i-lucide-stethoscope" class="size-4 text-primary" />
            <h3 class="text-sm font-semibold text-highlighted">Assistente de Configuração &amp; Brain Doctor</h3>
          </div>
          <UBadge :color="doctor.healthy ? 'success' : 'warning'" variant="subtle" size="sm">
            Prontidão: {{ doctor.score }}%
          </UBadge>
        </div>
      </template>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <div
          v-for="chk in doctor.checks"
          :key="chk.id"
          class="rounded-xl border border-default bg-elevated/30 p-3 space-y-1"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold text-highlighted">{{ chk.label }}</span>
            <UBadge :color="chk.ok ? 'success' : 'error'" variant="subtle" size="xs">
              {{ chk.ok ? 'OK' : 'Atenção' }}
            </UBadge>
          </div>
          <p class="text-[11px] text-muted">{{ chk.detail }}</p>
          <p v-if="chk.suggestedFix" class="text-[11px] font-mono text-warning pt-1">
            Fix: {{ chk.suggestedFix }}
          </p>
        </div>
      </div>
    </UCard>

    <!-- Conectores Incrementais, Ciclo de Vida MinIO & Reprocessamento (Prioridade 3) -->
    <UCard v-if="connectorsData" class="border border-default">
      <template #header>
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 class="text-sm font-semibold text-highlighted">Conectores Incrementais &amp; Reprocessamento de Ingestão</h3>
            <p class="text-xs text-muted">
              Sincronização incremental (GitHub, GitLab, Google Drive, Notion), ciclo de vida MinIO ({{ connectorsData.storageLifecycle.bucket }}, URLs pré-assinadas {{ connectorsData.storageLifecycle.presignedUrlTtlSeconds }}s) e reprocessamento por extrator.
            </p>
          </div>
        </div>
      </template>

      <div class="space-y-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div
            v-for="conn in connectorsData.connectors"
            :key="conn.provider"
            class="rounded-xl border border-default bg-elevated/30 p-3 flex flex-col justify-between gap-2"
          >
            <div>
              <div class="flex items-center justify-between">
                <span class="text-xs font-semibold text-highlighted">{{ conn.name }}</span>
                <UBadge :color="conn.status === 'synced' ? 'success' : 'neutral'" variant="subtle" size="xs">
                  {{ conn.status }}
                </UBadge>
              </div>
              <div class="text-[11px] font-mono text-muted mt-1 truncate">Cursor: {{ conn.incrementalCursor }}</div>
              <div class="text-[11px] text-muted mt-0.5">
                {{ conn.lastSyncedAt ? `Sync: ${new Date(conn.lastSyncedAt).toLocaleString('pt-BR')}` : 'Ainda não sincronizado' }}
              </div>
            </div>
            <UButton
              size="xs"
              variant="soft"
              color="primary"
              icon="i-lucide-refresh-cw"
              :loading="syncingProvider === conn.provider"
              @click="syncConnector(conn.provider)"
            >
              Sync Incremental
            </UButton>
          </div>
        </div>

        <!-- Reprocessar Ingestão com Outro Extrator / Modelo -->
        <div class="rounded-xl border border-default bg-elevated/40 p-3.5 flex flex-col md:flex-row md:items-end gap-3">
          <UFormField label="Documento / Item para Reprocessar" class="flex-1">
            <USelect
              v-model="reprocessItemId"
              :items="connectorsData.documents.map(d => ({ label: `${d.id} — ${d.title} (${d.sourceVersion})`, value: d.id }))"
              size="sm"
              class="w-full font-mono"
            />
          </UFormField>
          <UFormField label="Extrator / Sanitizador" class="w-60">
            <USelect
              v-model="reprocessExtractor"
              :items="[
                { label: 'PII Strict + Secret Guard', value: 'pii-strict' },
                { label: 'AI Worker Structured Markdown', value: 'ai-worker-structured' },
                { label: 'Native Markdown + YAML', value: 'native-markdown' }
              ]"
              size="sm"
              class="w-full"
            />
          </UFormField>
          <UButton size="sm" color="primary" icon="i-lucide-cpu" :loading="reprocessing" @click="reprocessItem">
            Reprocessar + Gerar bge-m3
          </UButton>
        </div>
      </div>
    </UCard>
  </div>
</template>
