---
name: frontend-architecture-craft
description: >-
  Arquitetura frontend moderna e elegante com Vue 3, Nuxt 3 e TypeScript:
  Composition API idiomática, composables puros, reatividade de alta performance
  (shallowRef para grafos/3D), separação Dumb/Smart components e UI resiliente.
---

# Frontend Architecture & Vue 3 / Nuxt 3 Craft

Este guia estabelece os padrões de excelência para desenvolvimento frontend no ecossistema Vue 3, Nuxt 3 e TypeScript.

---

## 1. Composition API & `<script setup lang="ts">`

Sempre utilize a sintaxe concisa de `<script setup lang="ts">`. Mantenha a ordem padronizada:
1. Imports (Vue, bibliotecas externas, componentes internos, composables, types).
2. Props e Emits (`defineProps`, `defineEmits`).
3. Estado reativo (`ref`, `reactive`, `shallowRef`).
4. Computeds (`computed`).
5. Watchers (`watch`, `watchEffect`).
6. Métodos e Handlers de eventos.
7. Lifecycle hooks (`onMounted`, `onUnmounted`).

```vue
<script setup lang="ts">
import { ref, computed, shallowRef, onMounted, onUnmounted } from 'vue'
import type { KnowledgeItem } from '@brain/core'

const props = withDefaults(
  defineProps<{
    projectId: string
    items: readonly KnowledgeItem[]
    selectedId?: string | null
  }>(),
  {
    selectedId: null
  }
)

const emit = defineEmits<{
  (e: 'select', item: KnowledgeItem): void
  (e: 'filter-change', query: string): void
}>()

const searchQuery = ref('')
const activeTab = ref<'table' | 'graph' | 'radar'>('table')

// shallowRef para coleções pesadas ou instâncias de canvas/WebGL
const graphInstance = shallowRef<Cytoscape.Core | null>(null)

const filteredItems = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!query) return props.items
  return props.items.filter((item) =>
    item.title.toLowerCase().includes(query) || item.id.toLowerCase().includes(query)
  )
})

function handleSelect(item: KnowledgeItem) {
  emit('select', item)
}
</script>
```

---

## 2. Reatividade de Alta Performance (`shallowRef`)

Quando trabalhar com objetos complexos e pesados (árvores de topologia, grafos D3/Cytoscape, instâncias Three.js, grandes matrizes de dados):
- **NÃO use `reactive` ou `ref` profundo**: O Vue criará Proxies recursivos para cada propriedade e vértice, degradando drasticamente o FPS e a memória.
- **USE `shallowRef`**: A reatividade monitora apenas `.value = novoValor`, preservando o objeto interno cru.

```typescript
// ❌ Evite: proxy recursivo em 50.000 nós de grafo
const graphData = ref<CytoscapeElements>({ nodes: [], edges: [] })

// ✅ Recomendado: alta performance sem overhead de Proxy
const graphData = shallowRef<CytoscapeElements>({ nodes: [], edges: [] })

// Para disparar reatividade:
function updateGraph(newData: CytoscapeElements) {
  graphData.value = newData // Gatilho limpo de renderização
}
```

---

## 3. Composables Desacoplados e Reutilizáveis

Isole a lógica de estado, efeitos e chamadas de rede em composables com prefixo `use*`.
- Devem retornar `readonly` para estados sensíveis.
- Devem limpar seus próprios side-effects em `onScopeDispose` ou `onUnmounted`.

```typescript
// composables/useKnowledgeRetrieval.ts
import { ref, readonly } from 'vue'
import type { KnowledgeItem } from '@brain/core'

export function useKnowledgeRetrieval(projectId: string) {
  const items = ref<KnowledgeItem[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  let abortController: AbortController | null = null

  async function search(query: string) {
    abortController?.abort()
    abortController = new AbortController()

    loading.value = true
    error.value = null

    try {
      const response = await $fetch<KnowledgeItem[]>(`/v1/projects/${projectId}/search`, {
        params: { query },
        signal: abortController.signal
      })
      items.value = response
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        error.value = err.message ?? 'Falha ao buscar conhecimento'
      }
    } finally {
      loading.value = false
    }
  }

  return {
    items: readonly(items),
    loading: readonly(loading),
    error: readonly(error),
    search
  }
}
```

---

## 4. Separação Dumb (Apresentação) vs Smart (Contêiner)

- **Dumb Components (`Ui*`, `Base*`)**: Recebem dados via `props`, emitem eventos via `emit`, zero chamadas diretas de API, estritamente focados em visual e acessibilidade.
- **Smart Workspaces / Views**: Orquestram composables, controlam autenticação, gerenciam ciclo de vida de rede e repassam dados aos dumb components.

---

## 5. Limpeza Rigorosa de Ciclo de Vida

Todo listener adicionado na janela, canvas, WebGL ou WebSocket deve ser explicitamente removido:

```typescript
onMounted(() => {
  window.addEventListener('resize', handleResize, { passive: true })
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  // Limpar instâncias WebGL/Canvas
  threeRenderer?.dispose()
  cytoscapeInstance?.destroy()
})
```

---

## 6. Checklist de Qualidade Frontend
- [ ] Componente respeita o limite estrito de `<= 700` linhas?
- [ ] Props possuem tipagem TypeScript explícita e defaults coerentes?
- [ ] Estados mutáveis expostos por composables são protegidos com `readonly`?
- [ ] Coleções volumosas de visualização usam `shallowRef`?
- [ ] Todos os listeners, timers e instâncias WebGL são destruídos no `onUnmounted`?
