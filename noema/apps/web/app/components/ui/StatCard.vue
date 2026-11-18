<script setup lang="ts">
type Tone = 'primary' | 'success' | 'warning' | 'error' | 'info' | 'neutral'

const props = withDefaults(defineProps<{
  label: string
  value: string | number
  icon?: string
  tone?: Tone
  hint?: string
  loading?: boolean
}>(), {
  tone: 'primary',
  icon: undefined,
  hint: undefined,
  loading: false
})

const toneClasses: Record<Tone, { icon: string; ring: string; value: string }> = {
  primary: { icon: 'text-indigo-400 bg-indigo-500/10', ring: 'hover:border-indigo-500/40', value: 'text-highlighted' },
  success: { icon: 'text-emerald-400 bg-emerald-500/10', ring: 'hover:border-emerald-500/40', value: 'text-emerald-400' },
  warning: { icon: 'text-amber-400 bg-amber-500/10', ring: 'hover:border-amber-500/40', value: 'text-amber-400' },
  error: { icon: 'text-rose-400 bg-rose-500/10', ring: 'hover:border-rose-500/40', value: 'text-rose-400' },
  info: { icon: 'text-sky-400 bg-sky-500/10', ring: 'hover:border-sky-500/40', value: 'text-sky-400' },
  neutral: { icon: 'text-slate-400 bg-slate-500/10', ring: 'hover:border-slate-500/40', value: 'text-highlighted' }
}

const t = computed(() => toneClasses[props.tone])
</script>

<template>
  <div
    class="group relative rounded-xl border border-default bg-elevated/40 p-4 transition-colors"
    :class="t.ring"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="text-xs font-medium text-muted truncate">{{ label }}</div>
        <USkeleton v-if="loading" class="h-7 w-20 mt-2" />
        <div v-else class="text-2xl font-bold mt-1 tabular-nums tracking-tight" :class="t.value">
          {{ value }}
        </div>
        <div v-if="hint" class="text-[11px] text-dimmed mt-1 truncate">{{ hint }}</div>
      </div>
      <div v-if="icon" class="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center" :class="t.icon">
        <UIcon :name="icon" class="w-4.5 h-4.5" />
      </div>
    </div>
    <slot />
  </div>
</template>

