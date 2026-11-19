<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    code: string
    maxHeightClass?: string
  }>(),
  {
    maxHeightClass: 'max-h-[460px]'
  }
)

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

const svgHtml = ref('')
const renderError = ref('')
const rendering = ref(false)
const showCode = ref(false)
const copied = ref(false)

let renderCounter = 0

async function renderDiagram() {
  const source = props.code?.trim()
  if (!source || !import.meta.client) {
    svgHtml.value = ''
    return
  }

  const currentRun = ++renderCounter
  rendering.value = true
  renderError.value = ''

  try {
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      theme: isDark.value ? 'dark' : 'default',
      securityLevel: 'strict',
      flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' }
    })

    const diagramId = `mermaid-${Math.random().toString(36).slice(2, 10)}`
    const { svg } = await mermaid.render(diagramId, source)
    if (currentRun === renderCounter) {
      svgHtml.value = svg
    }
  } catch (err) {
    if (currentRun === renderCounter) {
      renderError.value = err instanceof Error ? err.message : 'Falha ao renderizar diagrama Mermaid'
      svgHtml.value = ''
    }
  } finally {
    if (currentRun === renderCounter) {
      rendering.value = false
    }
  }
}

onMounted(renderDiagram)
watch([() => props.code, isDark], renderDiagram)

async function copyCode() {
  await navigator.clipboard.writeText(props.code).catch(() => {})
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>

<template>
  <div class="rounded-xl border border-default bg-elevated/40 overflow-hidden">
    <div class="flex items-center justify-between px-3 py-2 border-b border-default bg-elevated/60">
      <div class="flex items-center gap-1.5">
        <UButton
          size="xs"
          :variant="!showCode ? 'solid' : 'ghost'"
          :color="!showCode ? 'primary' : 'neutral'"
          icon="i-lucide-workflow"
          @click="showCode = false"
        >
          Diagrama
        </UButton>
        <UButton
          size="xs"
          :variant="showCode ? 'solid' : 'ghost'"
          :color="showCode ? 'primary' : 'neutral'"
          icon="i-lucide-code-2"
          @click="showCode = true"
        >
          Código
        </UButton>
      </div>
      <UButton
        size="xs"
        variant="soft"
        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
        @click="copyCode"
      >
        {{ copied ? 'Copiado!' : 'Copiar Mermaid' }}
      </UButton>
    </div>

    <div v-if="showCode || renderError" class="p-3 space-y-2">
      <div v-if="renderError" class="text-xs text-warning font-mono">
        {{ renderError }}
      </div>
      <pre class="p-3 rounded-lg bg-default border border-default text-default font-mono text-xs overflow-x-auto select-all" :class="maxHeightClass"><code>{{ code }}</code></pre>
    </div>

    <div v-else class="p-4 overflow-auto flex justify-center items-center min-h-[160px]" :class="maxHeightClass">
      <div v-if="rendering && !svgHtml" class="text-xs text-muted flex items-center gap-2">
        <UIcon name="i-lucide-loader-2" class="size-4 animate-spin" />
        Renderizando diagrama Mermaid...
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-else-if="svgHtml" class="mermaid-svg w-full flex justify-center [&>svg]:max-w-full [&>svg]:h-auto" v-html="svgHtml" />
    </div>
  </div>
</template>
