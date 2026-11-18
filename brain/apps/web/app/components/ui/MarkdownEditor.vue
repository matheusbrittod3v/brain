<script setup lang="ts">
import { MdEditor } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'

const model = defineModel<string>({ required: true })

withDefaults(defineProps<{
  height?: string
  placeholder?: string
}>(), {
  height: '340px',
  placeholder: 'Escreva em Markdown (suporta Mermaid, KaTeX, blocos de código)...'
})

const colorMode = useColorMode()
const editorTheme = computed(() => (colorMode.value === 'dark' ? 'dark' : 'light'))
</script>

<template>
  <ClientOnly>
    <div class="rounded-xl overflow-hidden border border-default">
      <MdEditor
        v-model="model"
        :theme="editorTheme"
        language="en-US"
        :preview="true"
        :placeholder="placeholder"
        :style="{ height }"
        :toolbars-exclude="['github', 'htmlPreview', 'save']"
      />
    </div>
    <template #fallback>
      <UTextarea v-model="model" :rows="10" class="w-full font-mono text-xs" />
    </template>
  </ClientOnly>
</template>

