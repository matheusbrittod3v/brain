<script setup lang="ts">
const props = defineProps<{
  open: boolean
  projectId: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'uploaded'): void
}>()

const { apiFetch, notify } = useBrainApi()

const uploadMode = ref<'file' | 'url'>('file')
const uploading = ref(false)
const uploadPolicy = ref('internal-project')
const uploadMdType = ref<'document' | 'spec' | 'skill'>('document')
const uploadUrl = ref('')
const selectedFile = ref<File | null>(null)
const dragActive = ref(false)

function onFileSelected(file: File | null | undefined) {
  if (!file) return
  selectedFile.value = file
}

function handleDrop(e: DragEvent) {
  dragActive.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) onFileSelected(file)
}

async function onUrlImportSubmit() {
  if (!uploadUrl.value.trim()) return
  uploading.value = true
  try {
    await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/ingest-url`, {
      method: 'POST',
      body: JSON.stringify({
        url: uploadUrl.value.trim(),
        type: uploadMdType.value,
        accessPolicyId: uploadPolicy.value
      })
    })
    notify('URL importada!', 'Conteúdo extraído e indexado no Hub.')
    uploadUrl.value = ''
    emit('update:open', false)
    emit('uploaded')
  } catch (err) {
    notify('Erro ao importar URL', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    uploading.value = false
  }
}

async function onUploadSubmit() {
  if (!selectedFile.value) return
  uploading.value = true
  try {
    const file = selectedFile.value
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (ext === '.md' || ext === '.txt') {
      const content = await file.text()
      await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/knowledge`, {
        method: 'POST',
        body: JSON.stringify({
          title: file.name.replace(/\.(md|txt)$/i, ''),
          type: uploadMdType.value,
          content,
          accessPolicyId: uploadPolicy.value,
          tags: [uploadMdType.value, 'upload']
        })
      })
      notify('Arquivo Markdown importado!', `${file.name} salvo como ${uploadMdType.value}.`)
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      }
      const contentBase64 = btoa(binary)
      await apiFetch(`/v1/projects/${encodeURIComponent(props.projectId)}/ingest-document`, {
        method: 'POST',
        body: JSON.stringify({
          fileName: file.name,
          contentBase64,
          accessPolicyId: uploadPolicy.value
        })
      })
      notify('Documento processado!', `${file.name} extraído, escaneado e indexado.`)
    }
    selectedFile.value = null
    emit('update:open', false)
    emit('uploaded')
  } catch (err) {
    notify('Falha no upload', err instanceof Error ? err.message : String(err), 'error')
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <UModal :open="open" title="Importar Arquivo ou URL para o Hub" @update:open="val => emit('update:open', val)">
    <template #body>
      <div class="space-y-4">
        <UiSegmentedTabs
          v-model="uploadMode"
          :items="[
            { label: 'Arquivo (PDF/DOCX/MD)', value: 'file', icon: 'i-lucide-file-up' },
            { label: 'URL Externa', value: 'url', icon: 'i-lucide-globe' }
          ]"
        />

        <div v-if="uploadMode === 'file'" class="space-y-4">
          <div
            class="border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer"
            :class="dragActive ? 'border-primary bg-primary/10' : 'border-default hover:border-primary/50'"
            @dragover.prevent="dragActive = true"
            @dragleave.prevent="dragActive = false"
            @drop.prevent="handleDrop"
          >
            <UIcon name="i-lucide-file-up" class="w-8 h-8 text-primary mx-auto mb-2" />
            <div class="text-sm font-medium">
              {{ selectedFile ? selectedFile.name : 'Arraste PDF, DOCX, HTML, CSV ou Markdown aqui' }}
            </div>
            <p class="text-xs text-muted mt-1">Parser nativo TypeScript (unpdf, mammoth, turndown) + scan de segredos</p>
            <input
              type="file"
              accept=".pdf,.docx,.pptx,.xlsx,.html,.csv,.md,.txt"
              class="mt-3 text-xs"
              @change="(e: Event) => onFileSelected((e.target as HTMLInputElement).files?.[0])"
            >
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UFormField label="Política de Acesso">
              <USelect
                v-model="uploadPolicy"
                :items="['public-org', 'internal-project', 'confidential-business', 'restricted-security']"
                class="w-full"
              />
            </UFormField>
            <UFormField v-if="selectedFile && /\.(md|txt)$/i.test(selectedFile.name)" label="Importar Markdown como">
              <USelect
                v-model="uploadMdType"
                :items="[
                  { label: 'Documento', value: 'document' },
                  { label: 'Spec', value: 'spec' },
                  { label: 'Skill MCP', value: 'skill' }
                ]"
                class="w-full"
              />
            </UFormField>
          </div>

          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="emit('update:open', false)">Cancelar</UButton>
            <UButton :disabled="!selectedFile" :loading="uploading" icon="i-lucide-upload" @click="onUploadSubmit">
              Processar &amp; Salvar
            </UButton>
          </div>
        </div>

        <div v-else class="space-y-4">
          <UFormField label="URL Pública (Documentação, Blog, Repo README)">
            <UInput v-model="uploadUrl" placeholder="https://docs.exemplo.com/guia" class="w-full" />
          </UFormField>
          <div class="grid grid-cols-2 gap-3">
            <UFormField label="Tipo">
              <USelect v-model="uploadMdType" :items="['document', 'spec', 'skill']" class="w-full" />
            </UFormField>
            <UFormField label="Política">
              <USelect
                v-model="uploadPolicy"
                :items="['public-org', 'internal-project', 'confidential-business', 'restricted-security']"
                class="w-full"
              />
            </UFormField>
          </div>
          <div class="flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="emit('update:open', false)">Cancelar</UButton>
            <UButton :disabled="!uploadUrl.trim()" :loading="uploading" icon="i-lucide-globe" @click="onUrlImportSubmit">
              Importar URL
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
