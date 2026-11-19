<script setup lang="ts">
import {
  KNOWLEDGE_LAYERS,
  inferKnowledgeLayer,
  type KnowledgeLayer
} from './knowledgeUtils'

export interface GraphNode {
  id: string
  title: string
  type: string
  status: string
  content: string
  tags?: string[]
}

const props = defineProps<{
  items: GraphNode[]
}>()

const emit = defineEmits<{
  inspectItem: [item: GraphNode]
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)

// 3D Camera Controls
const pitch = ref(38) // Elevation angle in degrees
const yaw = ref(-32) // Azimuth angle in degrees
const zoom = ref(1.0)
const layerSpacing = ref(95) // Distance between layer planes in px
const autoRotate = ref(false)
const showCrossLayerLinks = ref(true)
const activeLayerFilter = ref<'all' | KnowledgeLayer>('all')
const hoveredNode = ref<GraphNode | null>(null)
const tooltipPos = ref({ x: 0, y: 0 })

let animationFrameId: number | null = null
let isDragging = false
let lastMouse = { x: 0, y: 0 }

const layersOrder: KnowledgeLayer[] = [
  'architecture',
  'business',
  'code',
  'product',
  'operations'
]

const layerMetaMap = new Map(KNOWLEDGE_LAYERS.map(l => [l.id, l]))

interface Node3D {
  item: GraphNode
  layer: KnowledgeLayer
  layerIndex: number
  localX: number // -100 to 100
  localY: number // -100 to 100
  screenX: number
  screenY: number
  radius: number
  color: string
}

interface Link3D {
  source: Node3D
  target: Node3D
  isCrossLayer: boolean
  relation: string
}

// Compute 3D node positions
const nodes3D = computed<Node3D[]>(() => {
  const filtered = activeLayerFilter.value === 'all'
    ? props.items
    : props.items.filter(i => inferKnowledgeLayer(i) === activeLayerFilter.value)

  const itemsByLayer = new Map<KnowledgeLayer, GraphNode[]>()
  for (const l of layersOrder) itemsByLayer.set(l, [])

  for (const it of filtered) {
    const l = inferKnowledgeLayer(it)
    const list = itemsByLayer.get(l)
    if (list) list.push(it)
  }

  const result: Node3D[] = []

  layersOrder.forEach((layerId, layerIdx) => {
    const itemsInLayer = itemsByLayer.get(layerId) || []
    const count = itemsInLayer.length
    const meta = layerMetaMap.get(layerId)
    const color = meta ? meta.color : '#6366f1'

    itemsInLayer.forEach((item, idx) => {
      // Distribute nodes on an elliptical orbital floor per layer
      let localX = 0
      let localY = 0
      if (count === 1) {
        localX = 0
        localY = 0
      } else {
        const angle = (idx / count) * 2 * Math.PI
        const radius = count > 8 ? (idx % 2 === 0 ? 110 : 65) : 85
        localX = Math.cos(angle) * radius
        localY = Math.sin(angle) * radius * 0.75
      }

      result.push({
        item,
        layer: layerId,
        layerIndex: layerIdx,
        localX,
        localY,
        screenX: 0,
        screenY: 0,
        radius: item.status === 'approved' ? 6 : 5,
        color
      })
    })
  })

  return result
})

// Links between nodes (within layer and cross-layer)
const links3D = computed<Link3D[]>(() => {
  const nodes = nodes3D.value
  const nodeMap = new Map(nodes.map(n => [n.item.id, n]))
  const links: Link3D[] = []

  for (const n of nodes) {
    const related = n.item.tags || []
    // Connect to items in other layers if tagged or related
    for (const other of nodes) {
      if (other === n) continue
      const isRelated = related.some(t => other.item.title.toLowerCase().includes(t.toLowerCase()) || other.item.id === t)
      const cross = n.layer !== other.layer

      if (isRelated) {
        links.push({
          source: n,
          target: other,
          isCrossLayer: cross,
          relation: cross ? 'cross_layer' : 'in_layer'
        })
      }
    }

    // Default cross-layer links: connect representative items down the stack
    if (n.layerIndex < layersOrder.length - 1) {
      const nextLayer = layersOrder[n.layerIndex + 1]
      const candidates = nodes.filter(other => other.layer === nextLayer)
      if (candidates.length > 0 && Math.random() < 0.25) {
        const target = candidates[Math.floor(Math.random() * candidates.length)]!
        links.push({ source: n, target, isCrossLayer: true, relation: 'flows_to' })
      }
    }
  }

  return links.slice(0, 80)
})

function project3D(x: number, y: number, z: number, cx: number, cy: number) {
  const radYaw = (yaw.value * Math.PI) / 180
  const radPitch = (pitch.value * Math.PI) / 180

  // Rotation around Y (yaw)
  const x1 = x * Math.cos(radYaw) - y * Math.sin(radYaw)
  const y1 = x * Math.sin(radYaw) + y * Math.cos(radYaw)
  const z1 = z

  // Rotation around X (pitch)
  const x2 = x1
  const y2 = y1 * Math.cos(radPitch) - z1 * Math.sin(radPitch)
  const z2 = y1 * Math.sin(radPitch) + z1 * Math.cos(radPitch)

  // Isometric orthographic projection with zoom
  const screenX = cx + x2 * zoom.value
  const screenY = cy + y2 * zoom.value

  return { screenX, screenY, depth: z2 }
}

function drawScene() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const width = canvas.width / dpr
  const height = canvas.height / dpr
  ctx.clearRect(0, 0, width, height)

  const cx = width / 2
  const cy = height / 2

  // 1. Draw 3D Layer Floors (Stacked Isometric Planes)
  const planeWidth = 260
  const planeHeight = 180

  layersOrder.forEach((layerId, idx) => {
    // Invert z so architecture is at the top or bottom
    const z = (idx - (layersOrder.length - 1) / 2) * layerSpacing.value
    const meta = layerMetaMap.get(layerId)
    const color = meta ? meta.color : '#6366f1'

    // Plane 4 corners in local space
    const p1 = project3D(-planeWidth / 2, -planeHeight / 2, z, cx, cy)
    const p2 = project3D(planeWidth / 2, -planeHeight / 2, z, cx, cy)
    const p3 = project3D(planeWidth / 2, planeHeight / 2, z, cx, cy)
    const p4 = project3D(-planeWidth / 2, planeHeight / 2, z, cx, cy)

    // Fill semi-transparent isometric plane
    ctx.beginPath()
    ctx.moveTo(p1.screenX, p1.screenY)
    ctx.lineTo(p2.screenX, p2.screenY)
    ctx.lineTo(p3.screenX, p3.screenY)
    ctx.lineTo(p4.screenX, p4.screenY)
    ctx.closePath()

    ctx.fillStyle = `${color}10`
    ctx.fill()
    ctx.strokeStyle = `${color}40`
    ctx.lineWidth = 1.2
    ctx.stroke()

    // Plane Label (Floating Badge in 3D)
    const labelPos = project3D(-planeWidth / 2 - 15, 0, z, cx, cy)
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
    ctx.fillStyle = color
    ctx.fillText(`${meta?.label || layerId}`, labelPos.screenX, labelPos.screenY)
  })

  // 2. Compute Screen Positions for all Nodes
  for (const n of nodes3D.value) {
    const z = (n.layerIndex - (layersOrder.length - 1) / 2) * layerSpacing.value
    const proj = project3D(n.localX, n.localY, z, cx, cy)
    n.screenX = proj.screenX
    n.screenY = proj.screenY
  }

  // 3. Draw Links (3D Bezier Arcs)
  if (showCrossLayerLinks.value) {
    for (const link of links3D.value) {
      ctx.beginPath()
      ctx.moveTo(link.source.screenX, link.source.screenY)

      if (link.isCrossLayer) {
        // Curve across layers
        const midX = (link.source.screenX + link.target.screenX) / 2 + 25
        const midY = (link.source.screenY + link.target.screenY) / 2 - 15
        ctx.quadraticCurveTo(midX, midY, link.target.screenX, link.target.screenY)
        ctx.strokeStyle = link.source.color + '30'
        ctx.lineWidth = 1
      } else {
        ctx.lineTo(link.target.screenX, link.target.screenY)
        ctx.strokeStyle = link.source.color + '45'
        ctx.lineWidth = 0.8
      }
      ctx.stroke()
    }
  }

  // 4. Draw Nodes with glow
  for (const n of nodes3D.value) {
    const isHovered = hoveredNode.value?.id === n.item.id

    ctx.beginPath()
    ctx.arc(n.screenX, n.screenY, isHovered ? n.radius + 3 : n.radius, 0, 2 * Math.PI)
    ctx.fillStyle = n.color
    ctx.fill()

    if (isHovered) {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 2
      ctx.stroke()

      // Glow circle
      ctx.beginPath()
      ctx.arc(n.screenX, n.screenY, n.radius + 8, 0, 2 * Math.PI)
      ctx.strokeStyle = `${n.color}60`
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else {
      ctx.strokeStyle = '#0f172a'
      ctx.lineWidth = 1.2
      ctx.stroke()
    }

    // Node Title (if zoomed in or hovered)
    if (zoom.value >= 1.05 || isHovered) {
      ctx.font = '9px monospace'
      ctx.fillStyle = isHovered ? '#ffffff' : '#94a3b8'
      ctx.fillText(n.item.title.slice(0, 15), n.screenX + 8, n.screenY + 3)
    }
  }
}

function loop() {
  if (autoRotate.value) {
    yaw.value = (yaw.value + 0.35) % 360
  }
  drawScene()
  animationFrameId = requestAnimationFrame(loop)
}

function handleMouseDown(e: MouseEvent) {
  isDragging = true
  lastMouse = { x: e.clientX, y: e.clientY }
}

function handleMouseMove(e: MouseEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const mouseX = e.clientX - rect.left
  const mouseY = e.clientY - rect.top

  if (isDragging) {
    const dx = e.clientX - lastMouse.x
    const dy = e.clientY - lastMouse.y
    yaw.value = (yaw.value + dx * 0.6) % 360
    pitch.value = Math.max(10, Math.min(80, pitch.value - dy * 0.4))
    lastMouse = { x: e.clientX, y: e.clientY }
  } else {
    // Check hit hover
    let found: GraphNode | null = null
    for (const n of nodes3D.value) {
      const dist = Math.hypot(n.screenX - mouseX, n.screenY - mouseY)
      if (dist <= n.radius + 5) {
        found = n.item
        tooltipPos.value = { x: mouseX + 12, y: mouseY - 12 }
        break
      }
    }
    hoveredNode.value = found
  }
}

function handleMouseUp() {
  isDragging = false
}

function handleClick() {
  if (hoveredNode.value) {
    emit('inspectItem', hoveredNode.value)
  }
}

function handleWheel(e: WheelEvent) {
  e.preventDefault()
  const delta = e.deltaY > 0 ? -0.08 : 0.08
  zoom.value = Math.max(0.5, Math.min(2.2, zoom.value + delta))
}

function resetCamera() {
  pitch.value = 38
  yaw.value = -32
  zoom.value = 1.0
  layerSpacing.value = 95
  autoRotate.value = false
}

function resizeCanvas() {
  const canvas = canvasRef.value
  const container = containerRef.value
  if (!canvas || !container) return
  const dpr = window.devicePixelRatio || 1
  const rect = container.getBoundingClientRect()
  const w = Math.max(300, rect.width)
  const h = Math.max(480, rect.height || 480)
  canvas.width = w * dpr
  canvas.height = h * dpr
  const ctx = canvas.getContext('2d')
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

onMounted(() => {
  resizeCanvas()
  window.addEventListener('resize', resizeCanvas)
  loop()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeCanvas)
  if (animationFrameId) cancelAnimationFrame(animationFrameId)
})
</script>

<template>
  <div ref="containerRef" class="relative rounded-xl border border-default bg-[#0a0f1d] overflow-hidden select-none">
    <!-- 3D Canvas -->
    <canvas
      ref="canvasRef"
      class="w-full h-[520px] cursor-grab active:cursor-grabbing"
      @mousedown="handleMouseDown"
      @mousemove="handleMouseMove"
      @mouseup="handleMouseUp"
      @mouseleave="handleMouseUp"
      @click="handleClick"
      @wheel="handleWheel"
    />

    <!-- Interactive Overlay HUD -->
    <div class="absolute top-3 left-3 flex flex-wrap items-center gap-2 bg-[#0f172a]/80 backdrop-blur border border-default/60 p-2 rounded-lg text-xs">
      <div class="flex items-center gap-1.5 pr-2 border-r border-default/60">
        <UIcon name="i-lucide-box" class="size-4 text-primary" />
        <span class="font-bold text-highlighted">3D Isometric Stack</span>
      </div>

      <UButton
        size="xs"
        :variant="autoRotate ? 'solid' : 'ghost'"
        :color="autoRotate ? 'primary' : 'neutral'"
        icon="i-lucide-rotate-cw"
        title="Auto-rotação contínua 360°"
        @click="autoRotate = !autoRotate"
      >
        {{ autoRotate ? 'Rotacionando' : 'Órbita' }}
      </UButton>

      <UButton
        size="xs"
        :variant="showCrossLayerLinks ? 'soft' : 'ghost'"
        icon="i-lucide-git-merge"
        title="Exibir conexões entre camadas"
        @click="showCrossLayerLinks = !showCrossLayerLinks"
      >
        Conexões 3D
      </UButton>

      <UButton size="xs" variant="ghost" icon="i-lucide-rotate-ccw" title="Resetar câmera" @click="resetCamera">
        Reset
      </UButton>
    </div>

    <!-- Sliders Overlay HUD -->
    <div class="absolute bottom-3 left-3 flex items-center gap-4 bg-[#0f172a]/80 backdrop-blur border border-default/60 px-3 py-2 rounded-lg text-xs">
      <div class="flex items-center gap-2">
        <span class="text-muted text-[11px]">Espaçamento Z:</span>
        <input
          v-model.number="layerSpacing"
          type="range"
          min="40"
          max="160"
          step="5"
          class="w-20 accent-primary cursor-pointer"
        />
        <span class="font-mono text-[10px] text-primary">{{ layerSpacing }}px</span>
      </div>

      <div class="flex items-center gap-2">
        <span class="text-muted text-[11px]">Zoom:</span>
        <input
          v-model.number="zoom"
          type="range"
          min="0.5"
          max="2.0"
          step="0.05"
          class="w-16 accent-primary cursor-pointer"
        />
        <span class="font-mono text-[10px] text-highlighted">{{ Math.round(zoom * 100) }}%</span>
      </div>
    </div>

    <!-- Mini Layer Legend HUD -->
    <div class="absolute top-3 right-3 flex flex-col gap-1 bg-[#0f172a]/80 backdrop-blur border border-default/60 p-2.5 rounded-lg text-[11px]">
      <div
        v-for="layer in layersOrder"
        :key="layer"
        class="flex items-center gap-2 cursor-pointer transition-opacity"
        :class="activeLayerFilter === 'all' || activeLayerFilter === layer ? 'opacity-100' : 'opacity-35'"
        @click="activeLayerFilter = activeLayerFilter === layer ? 'all' : layer"
      >
        <span class="w-2.5 h-2.5 rounded-full" :style="{ backgroundColor: layerMetaMap.get(layer)?.color }" />
        <span class="font-medium text-highlighted">{{ layerMetaMap.get(layer)?.label }}</span>
      </div>
    </div>

    <!-- Node Hover Tooltip -->
    <div
      v-if="hoveredNode"
      class="absolute pointer-events-none z-20 p-2.5 rounded-lg bg-[#0f172a]/95 border border-default shadow-xl text-xs space-y-1 max-w-xs"
      :style="{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y}px` }"
    >
      <div class="flex items-center justify-between gap-2">
        <span class="font-bold text-highlighted truncate">{{ hoveredNode.title }}</span>
        <UBadge size="xs" :color="hoveredNode.status === 'approved' ? 'success' : 'warning'" variant="subtle">
          {{ hoveredNode.status }}
        </UBadge>
      </div>
      <div class="text-[10px] text-muted font-mono">
        {{ hoveredNode.id }} · {{ hoveredNode.type }}
      </div>
      <p class="text-[11px] text-highlighted/80 line-clamp-2">{{ hoveredNode.content }}</p>
      <div class="text-[10px] text-primary font-semibold">Clique para inspecionar item →</div>
    </div>
  </div>
</template>
