<script setup lang="ts">
export interface GraphNodeItem {
  id: string
  title?: string
  type?: string
  status?: string
}

export interface GraphEdgeItem {
  from: string
  to: string
  relation: string
}

const props = defineProps<{
  nodes: GraphNodeItem[]
  edges: GraphEdgeItem[]
  rootId?: string
}>()

const emit = defineEmits<{
  selectNode: [node: GraphNodeItem]
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const containerRef = ref<HTMLDivElement | null>(null)

// 3D Camera State
const pitch = ref(25) // degrees
const yaw = ref(-30) // degrees
const zoom = ref(1.1)
const autoRotate = ref(true)
const hoveredNode = ref<GraphNodeItem | null>(null)
const tooltipPos = ref({ x: 0, y: 0 })

let animationFrameId: number | null = null
let isDragging = false
let lastMouse = { x: 0, y: 0 }

interface InternalNode3D {
  item: GraphNodeItem
  x: number // 3D coordinates (-200 to 200)
  y: number
  z: number
  screenX: number
  screenY: number
  scale: number
  color: string
  radius: number
}

const computed3DNodes = computed<InternalNode3D[]>(() => {
  const list = props.nodes.slice(0, 80)
  const count = list.length
  if (count === 0) return []

  // Golden spiral on sphere (Fibonacci sphere distribution)
  const phi = Math.PI * (3 - Math.sqrt(5)) // golden angle
  const baseRadius = Math.min(220, 100 + count * 2)

  return list.map((item, i) => {
    const isRoot = item.id === props.rootId
    if (isRoot) {
      return {
        item,
        x: 0,
        y: 0,
        z: 0,
        screenX: 0,
        screenY: 0,
        scale: 1,
        color: '#38bdf8',
        radius: 12
      }
    }

    const y = 1 - (i / (count - 1 || 1)) * 2 // y goes from 1 to -1
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y)) // radius at y
    const theta = phi * i

    const r = baseRadius * (0.75 + ((i % 4) * 0.12))
    const x = Math.cos(theta) * radiusAtY * r
    const z = Math.sin(theta) * radiusAtY * r

    const color = item.status === 'approved'
      ? '#10b981'
      : item.status === 'draft'
        ? '#f59e0b'
        : item.type === 'business_rule'
          ? '#eab308'
          : item.type === 'architecture_decision'
            ? '#6366f1'
            : item.type === 'code_symbol'
              ? '#0ea5e9'
              : '#a855f7'

    return {
      item,
      x,
      y: y * r,
      z,
      screenX: 0,
      screenY: 0,
      scale: 1,
      color,
      radius: 6.5
    }
  })
})

function project3D(x: number, y: number, z: number, width: number, height: number) {
  const radYaw = (yaw.value * Math.PI) / 180
  const radPitch = (pitch.value * Math.PI) / 180

  // 1. Rotate around Y (Yaw)
  const cosY = Math.cos(radYaw)
  const sinY = Math.sin(radYaw)
  const x1 = x * cosY - z * sinY
  const z1 = x * sinY + z * cosY

  // 2. Rotate around X (Pitch)
  const cosP = Math.cos(radPitch)
  const sinP = Math.sin(radPitch)
  const y2 = y * cosP - z1 * sinP
  const z2 = y * sinP + z1 * cosP

  // 3. Perspective Projection
  const cameraDistance = 580
  const perspective = cameraDistance / (cameraDistance + z2)
  const finalScale = perspective * zoom.value

  const screenX = width / 2 + x1 * finalScale
  const screenY = height / 2 + y2 * finalScale

  return { screenX, screenY, scale: finalScale, depth: z2 }
}

function drawScene() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const width = canvas.width
  const height = canvas.height
  ctx.clearRect(0, 0, width, height)

  // Subtle background glow
  const bgGrad = ctx.createRadialGradient(width / 2, height / 2, 20, width / 2, height / 2, width * 0.6)
  bgGrad.addColorStop(0, 'rgba(30, 41, 59, 0.4)')
  bgGrad.addColorStop(1, 'rgba(2, 6, 23, 0.95)')
  ctx.fillStyle = bgGrad
  ctx.fillRect(0, 0, width, height)

  // Ambient 3D orbital rings
  ctx.save()
  ctx.strokeStyle = 'rgba(71, 85, 105, 0.15)'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 6])
  const ringRadius = 180 * zoom.value
  ctx.beginPath()
  ctx.ellipse(width / 2, height / 2, ringRadius, ringRadius * 0.35, (pitch.value * Math.PI) / 180, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()

  const nodes = computed3DNodes.value
  const nodeMap = new Map<string, InternalNode3D>()

  // Project all nodes
  for (const n of nodes) {
    const proj = project3D(n.x, n.y, n.z, width, height)
    n.screenX = proj.screenX
    n.screenY = proj.screenY
    n.scale = proj.scale
    nodeMap.set(n.item.id, n)
  }

  // Draw Edges
  ctx.save()
  for (const edge of props.edges) {
    const src = nodeMap.get(edge.from)
    const tgt = nodeMap.get(edge.to)
    if (!src || !tgt) continue

    const edgeColor = edge.relation === 'VERIFIED_BY'
      ? 'rgba(16, 185, 129, 0.55)'
      : edge.relation === 'IMPACTS'
        ? 'rgba(245, 158, 11, 0.55)'
        : 'rgba(99, 102, 241, 0.45)'

    ctx.strokeStyle = edgeColor
    ctx.lineWidth = Math.max(1, 1.8 * ((src.scale + tgt.scale) / 2))

    // Draw 3D curved connector
    ctx.beginPath()
    ctx.moveTo(src.screenX, src.screenY)
    const midX = (src.screenX + tgt.screenX) / 2
    const midY = (src.screenY + tgt.screenY) / 2 - 15 * ((src.scale + tgt.scale) / 2)
    ctx.quadraticCurveTo(midX, midY, tgt.screenX, tgt.screenY)
    ctx.stroke()
  }
  ctx.restore()

  // Draw Nodes sorted by depth (back to front)
  const sortedNodes = [...nodes].sort((a, b) => {
    const projA = project3D(a.x, a.y, a.z, width, height).depth
    const projB = project3D(b.x, b.y, b.z, width, height).depth
    return projB - projA
  })

  for (const n of sortedNodes) {
    const isHovered = hoveredNode.value?.id === n.item.id
    const isRoot = props.rootId === n.item.id
    const r = Math.max(3, n.radius * n.scale * (isHovered ? 1.4 : isRoot ? 1.3 : 1))

    // Glow Halo
    const haloGrad = ctx.createRadialGradient(n.screenX, n.screenY, r * 0.4, n.screenX, n.screenY, r * 2.8)
    haloGrad.addColorStop(0, n.color)
    haloGrad.addColorStop(1, 'transparent')
    ctx.fillStyle = haloGrad
    ctx.beginPath()
    ctx.arc(n.screenX, n.screenY, r * 2.8, 0, Math.PI * 2)
    ctx.fill()

    // Node Sphere Core
    ctx.fillStyle = n.color
    ctx.beginPath()
    ctx.arc(n.screenX, n.screenY, r, 0, Math.PI * 2)
    ctx.fill()

    ctx.strokeStyle = isRoot ? '#f8fafc' : '#0f172a'
    ctx.lineWidth = isRoot ? 2.5 : 1.5
    ctx.stroke()

    // Label if zoomed or important
    if (n.scale > 0.85 || isHovered || isRoot) {
      ctx.fillStyle = isHovered ? '#ffffff' : '#cbd5e1'
      ctx.font = `${Math.round(Math.max(9, 10 * n.scale))}px monospace`
      ctx.textAlign = 'center'
      const labelText = n.item.title ? n.item.title.slice(0, 16) : n.item.id
      ctx.fillText(labelText, n.screenX, n.screenY + r + 11)
    }
  }

  // Auto rotation loop
  if (autoRotate.value && !isDragging) {
    yaw.value = (yaw.value + 0.35) % 360
  }
  animationFrameId = requestAnimationFrame(drawScene)
}

function handleMouseDown(e: MouseEvent) {
  isDragging = true
  lastMouse = { x: e.clientX, y: e.clientY }
}

function handleMouseMove(e: MouseEvent) {
  const rect = canvasRef.value?.getBoundingClientRect()
  if (!rect) return
  const mouseX = e.clientX - rect.left
  const mouseY = e.clientY - rect.top

  if (isDragging) {
    const dx = e.clientX - lastMouse.x
    const dy = e.clientY - lastMouse.y
    yaw.value = (yaw.value + dx * 0.5) % 360
    pitch.value = Math.max(-85, Math.min(85, pitch.value - dy * 0.4))
    lastMouse = { x: e.clientX, y: e.clientY }
    return
  }

  // Hit test for nodes
  let found: GraphNodeItem | null = null
  for (const n of computed3DNodes.value) {
    const dist = Math.hypot(n.screenX - mouseX, n.screenY - mouseY)
    if (dist <= Math.max(8, n.radius * n.scale * 1.5)) {
      found = n.item
      tooltipPos.value = { x: mouseX + 14, y: mouseY - 14 }
      break
    }
  }
  hoveredNode.value = found
}

function handleMouseUp() {
  isDragging = false
}

function handleClick() {
  if (hoveredNode.value) {
    emit('selectNode', hoveredNode.value)
  }
}

function handleWheel(e: WheelEvent) {
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.08 : 0.92
  zoom.value = Math.max(0.5, Math.min(2.5, zoom.value * factor))
}

function resizeCanvas() {
  const container = containerRef.value
  const canvas = canvasRef.value
  if (!container || !canvas) return
  canvas.width = container.clientWidth
  canvas.height = container.clientHeight || 450
}

onMounted(() => {
  resizeCanvas()
  window.addEventListener('resize', resizeCanvas)
  animationFrameId = requestAnimationFrame(drawScene)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeCanvas)
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId)
  }
})
</script>

<template>
  <div ref="containerRef" class="relative w-full h-[450px] overflow-hidden rounded-xl bg-slate-950 select-none">
    <canvas
      ref="canvasRef"
      class="w-full h-full block cursor-grab active:cursor-grabbing"
      @mousedown="handleMouseDown"
      @mousemove="handleMouseMove"
      @mouseup="handleMouseUp"
      @mouseleave="handleMouseUp(); hoveredNode = null"
      @click="handleClick"
      @wheel="handleWheel"
    />

    <!-- 3D Controls Overlay -->
    <div class="absolute bottom-3 right-3 flex items-center gap-1.5 bg-slate-900/80 backdrop-blur-md px-2.5 py-1.5 rounded-lg border border-slate-800 text-xs text-slate-300">
      <button
        type="button"
        class="px-2 py-0.5 rounded font-medium transition-colors"
        :class="autoRotate ? 'bg-primary text-white shadow-xs' : 'text-slate-400 hover:text-white'"
        title="Ativar/Desativar Rotação Automática 360°"
        @click="autoRotate = !autoRotate"
      >
        <UIcon name="i-lucide-rotate-cw" class="size-3.5 mr-1 inline" />
        Órbita
      </button>

      <div class="h-3 w-px bg-slate-700 mx-1" />

      <button
        type="button"
        class="px-1.5 py-0.5 text-slate-400 hover:text-white"
        title="Aumentar Zoom"
        @click="zoom = Math.min(2.5, zoom * 1.15)"
      >
        <UIcon name="i-lucide-zoom-in" class="size-3.5" />
      </button>
      <button
        type="button"
        class="px-1.5 py-0.5 text-slate-400 hover:text-white"
        title="Diminuir Zoom"
        @click="zoom = Math.max(0.5, zoom * 0.85)"
      >
        <UIcon name="i-lucide-zoom-out" class="size-3.5" />
      </button>
      <button
        type="button"
        class="px-1.5 py-0.5 text-slate-400 hover:text-white"
        title="Resetar Câmera"
        @click="pitch = 25; yaw = -30; zoom = 1.1"
      >
        <UIcon name="i-lucide-rotate-ccw" class="size-3.5" />
      </button>
    </div>

    <!-- Node Hover Tooltip -->
    <div
      v-if="hoveredNode"
      class="absolute z-20 pointer-events-none p-2.5 rounded-lg bg-slate-900/95 border border-slate-700/80 shadow-xl backdrop-blur-md text-xs text-slate-200 max-w-xs space-y-1"
      :style="{ left: `${tooltipPos.x}px`, top: `${tooltipPos.y}px` }"
    >
      <div class="font-bold text-sky-400 font-mono truncate">{{ hoveredNode.id }}</div>
      <div v-if="hoveredNode.title" class="text-slate-100 font-semibold text-xs">{{ hoveredNode.title }}</div>
      <div class="flex items-center gap-2 text-[10px] text-slate-400 pt-0.5">
        <span v-if="hoveredNode.type" class="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700">{{ hoveredNode.type }}</span>
        <span v-if="hoveredNode.status" class="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700">{{ hoveredNode.status }}</span>
      </div>
      <div class="text-[10px] text-slate-400 italic">Clique para inspecionar</div>
    </div>
  </div>
</template>
