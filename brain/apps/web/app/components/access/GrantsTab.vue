<script setup lang="ts">
import { z } from 'zod'
import { ALL_POLICIES, KNOWN_AGENTS, type GrantItem, type RegisteredUser } from './types'

const props = defineProps<{
  grants: GrantItem[]
  users: RegisteredUser[]
  roleOptions: Array<{ label: string; value: string }>
  initialActorId?: string
}>()

const emit = defineEmits<{
  refresh: []
}>()

const { projectId, apiFetch, notify } = useBrainApi()

const customActorMode = ref(false)
const savingGrant = ref(false)

const grantSchema = z.object({
  actorId: z.string().min(1, 'Selecione ou informe o ator'),
  role: z.string().min(1),
  ttlMinutes: z.number().min(5).max(10080)
})

const grantState = reactive({
  actorId: props.initialActorId || '',
  role: 'developer',
  policyIds: ['public-org', 'internal-project'] as string[],
  ttlMinutes: 60
})

watch(() => props.initialActorId, (val) => {
  if (val) {
    customActorMode.value = false
    grantState.actorId = val
  }
})

const actorOptions = computed(() => [
  ...props.users.map(u => ({
    label: u.email ? `${u.name} (${u.email})` : `${u.name} — ${u.id}`,
    value: u.id
  })),
  ...KNOWN_AGENTS.map(a => ({ label: `Agente: ${a}`, value: a }))
])

function resolveUserDisplay(userId: string) {
  const found = props.users.find(u => u.id === userId)
  return found ? { name: found.name, email: found.email } : { name: userId, email: undefined }
}

function togglePolicy(pol: string) {
  const idx = grantState.policyIds.indexOf(pol)
  if (idx >= 0 && grantState.policyIds.length > 1) grantState.policyIds.splice(idx, 1)
  else if (idx < 0) grantState.policyIds.push(pol)
}

function formatRemaining(expiresAt: string) {
  const diffMin = Math.round((Date.parse(expiresAt) - Date.now()) / 60_000)
  if (diffMin <= 0) return 'Expirado'
  if (diffMin < 60) return `${diffMin} min restantes`
  return `${Math.floor(diffMin / 60)}h ${diffMin % 60}m restantes`
}

async function onCreateGrant() {
  savingGrant.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/access/grants`, {
      method: 'POST',
      body: JSON.stringify({
        actorId: grantState.actorId.trim(),
        roles: [grantState.role],
        policyIds: grantState.policyIds,
        ttlMinutes: grantState.ttlMinutes
      })
    })
    notify('Concessão temporária emitida', `Expira em ${grantState.ttlMinutes} min.`)
    grantState.actorId = ''
    emit('refresh')
  } catch (err) {
    notify('Erro ao emitir grant', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    savingGrant.value = false
  }
}

async function revokeGrant(grantId: string) {
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(projectId.value)}/access/grants/${encodeURIComponent(grantId)}`, {
      method: 'DELETE'
    })
    notify('Concessão revogada', grantId, 'warning')
    emit('refresh')
  } catch (err) {
    notify('Erro ao revogar grant', err instanceof Error ? err.message : String(err), 'error')
  }
}
</script>

<template>
  <div class="space-y-5">
    <UCard>
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 class="font-semibold text-sm">Emitir Acesso Temporário (Just-In-Time)</h3>
            <p class="text-xs text-muted">Conceda acesso excepcional com expiração automática para usuários ou agentes.</p>
          </div>
          <UButton
            size="xs"
            variant="ghost"
            color="neutral"
            @click="customActorMode = !customActorMode; grantState.actorId = ''"
          >
            {{ customActorMode ? 'Selecionar da lista' : 'Digitar ID externo' }}
          </UButton>
        </div>
      </template>

      <UForm :schema="grantSchema" :state="grantState" class="space-y-4" @submit="onCreateGrant">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
          <UFormField label="Usuário ou Agente" name="actorId">
            <USelect
              v-if="!customActorMode"
              v-model="grantState.actorId"
              :items="actorOptions"
              placeholder="Selecione o ator..."
              class="w-full"
            />
            <UInput v-else v-model="grantState.actorId" placeholder="ID do ator..." class="w-full font-mono" />
          </UFormField>

          <UFormField label="Cargo Temporário" name="role">
            <USelect v-model="grantState.role" :items="roleOptions" class="w-full" />
          </UFormField>

          <UFormField label="Duração (min)" name="ttlMinutes">
            <div class="flex flex-wrap items-center gap-1.5">
              <UInput v-model.number="grantState.ttlMinutes" type="number" min="5" max="10080" class="w-20" />
              <UButton
                v-for="preset in [{ l: '15m', v: 15 }, { l: '1h', v: 60 }, { l: '4h', v: 240 }, { l: '24h', v: 1440 }]"
                :key="preset.v"
                size="xs"
                :variant="grantState.ttlMinutes === preset.v ? 'solid' : 'outline'"
                color="neutral"
                @click="grantState.ttlMinutes = preset.v"
              >
                {{ preset.l }}
              </UButton>
            </div>
          </UFormField>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-default">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-xs text-muted mr-1">Políticas:</span>
            <UButton
              v-for="pol in ALL_POLICIES"
              :key="pol"
              size="xs"
              :variant="grantState.policyIds.includes(pol) ? 'soft' : 'outline'"
              :color="grantState.policyIds.includes(pol) ? 'primary' : 'neutral'"
              @click="togglePolicy(pol)"
            >
              {{ pol }}
            </UButton>
          </div>
          <UButton type="submit" :loading="savingGrant" icon="i-lucide-clock">Conceder Acesso</UButton>
        </div>
      </UForm>
    </UCard>

    <UCard>
      <UiEmptyState v-if="grants.length === 0" compact icon="i-lucide-clock" title="Nenhuma concessão temporária ativa" />
      <UTable
        v-else
        :data="grants"
        :columns="[
          { accessorKey: 'actorId', header: 'Ator' },
          { accessorKey: 'roles', header: 'Cargos' },
          { accessorKey: 'policyIds', header: 'Políticas' },
          { accessorKey: 'expiresAt', header: 'Expiração' },
          { id: 'actions', header: '' }
        ]"
      >
        <template #actorId-cell="{ row }">
          <div>
            <div class="font-medium text-sm">{{ resolveUserDisplay(row.original.actorId).name }}</div>
            <div class="text-[11px] text-muted font-mono">{{ row.original.actorId }}</div>
          </div>
        </template>
        <template #roles-cell="{ row }">
          <div class="flex gap-1">
            <UBadge v-for="r in row.original.roles" :key="r" size="xs" variant="subtle">{{ r }}</UBadge>
          </div>
        </template>
        <template #policyIds-cell="{ row }">
          <div class="flex flex-wrap gap-1">
            <UBadge v-for="p in row.original.policyIds" :key="p" color="neutral" variant="outline" size="xs">{{ p }}</UBadge>
          </div>
        </template>
        <template #expiresAt-cell="{ row }">
          <div>
            <UBadge color="warning" variant="subtle" size="xs">{{ formatRemaining(row.original.expiresAt) }}</UBadge>
            <div class="text-[11px] text-muted mt-0.5">{{ new Date(row.original.expiresAt).toLocaleString('pt-BR') }}</div>
          </div>
        </template>
        <template #actions-cell="{ row }">
          <UButton size="xs" color="error" variant="ghost" icon="i-lucide-ban" @click="revokeGrant(row.original.grantId)">
            Revogar
          </UButton>
        </template>
      </UTable>
    </UCard>
  </div>
</template>

