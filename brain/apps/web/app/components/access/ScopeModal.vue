<script setup lang="ts">
import { ALL_POLICIES, type UnifiedUserRow } from './types'

const props = defineProps<{
  open: boolean
  user?: UnifiedUserRow | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  saved: []
}>()

const { projectId, apiFetch, notify } = useBrainApi()

const saving = ref(false)
const form = ref({
  userId: '',
  userName: '',
  allowedProjectsCsv: '',
  allowedPolicies: ['public-org', 'internal-project'] as string[],
  rolesCsv: '',
  revokeActiveSessions: true
})

watch(() => props.open, (isOpen) => {
  if (!isOpen || !props.user) return
  form.value = {
    userId: props.user.id,
    userName: props.user.name,
    allowedProjectsCsv: (props.user.allowedProjects ?? [projectId.value]).join(', '),
    allowedPolicies: [...(props.user.allowedPolicies ?? ['public-org', 'internal-project'])],
    rolesCsv: (props.user.effectiveRoles ?? []).join(', '),
    revokeActiveSessions: true
  }
})

function togglePolicy(pol: string) {
  const idx = form.value.allowedPolicies.indexOf(pol)
  if (idx >= 0) form.value.allowedPolicies.splice(idx, 1)
  else form.value.allowedPolicies.push(pol)
}

async function saveScopes() {
  if (!form.value.userId) return
  saving.value = true
  try {
    const pid = encodeURIComponent(projectId.value)
    const uid = encodeURIComponent(form.value.userId)
    const allowedProjects = form.value.allowedProjectsCsv.split(',').map(s => s.trim()).filter(Boolean)
    const roles = form.value.rolesCsv.split(',').map(s => s.trim()).filter(Boolean)
    await apiFetch(`/v1/projects/${pid}/access/users/${uid}/scopes`, {
      method: 'PUT',
      body: JSON.stringify({
        allowedProjects,
        allowedPolicies: form.value.allowedPolicies,
        roles: roles.length > 0 ? roles : undefined,
        revokeActiveSessions: form.value.revokeActiveSessions
      })
    })
    notify('Escopos atualizados', `${form.value.userName} (${allowedProjects.length} projetos)`, 'success')
    emit('update:open', false)
    emit('saved')
  } catch (err) {
    notify('Erro ao atualizar escopos', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UModal
    :open="open"
    :title="`Escopos de Acesso: ${form.userName}`"
    @update:open="(v: boolean) => emit('update:open', v)"
  >
    <template #body>
      <div class="space-y-4">
        <UFormField label="Projetos Autorizados (separados por vírgula)">
          <UInput
            v-model="form.allowedProjectsCsv"
            placeholder="ex: noema, brain, projeto-a"
            class="w-full font-mono text-xs"
          />
        </UFormField>

        <UFormField label="Cargos (separados por vírgula)">
          <UInput
            v-model="form.rolesCsv"
            placeholder="ex: runner-operator, integration-manager"
            class="w-full font-mono text-xs"
          />
        </UFormField>

        <div class="space-y-1.5">
          <div class="text-xs font-medium text-muted">Políticas de Confidencialidade Permitidas</div>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="pol in ALL_POLICIES"
              :key="pol"
              size="xs"
              :variant="form.allowedPolicies.includes(pol) ? 'solid' : 'outline'"
              :color="form.allowedPolicies.includes(pol) ? 'primary' : 'neutral'"
              @click="togglePolicy(pol)"
            >
              {{ pol }}
            </UButton>
          </div>
        </div>

        <UCheckbox
          v-model="form.revokeActiveSessions"
          label="Revogar sessões/tokens ativos do usuário imediatamente"
        />

        <div class="flex justify-end gap-2 pt-3 border-t border-default">
          <UButton color="neutral" variant="ghost" @click="emit('update:open', false)">Cancelar</UButton>
          <UButton :loading="saving" icon="i-lucide-shield-check" @click="saveScopes">
            Salvar Escopos
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>

