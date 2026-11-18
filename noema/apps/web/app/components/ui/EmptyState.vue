<script setup lang="ts">
withDefaults(defineProps<{
  icon?: string
  title: string
  description?: string
  compact?: boolean
}>(), {
  icon: 'i-lucide-inbox',
  description: undefined,
  compact: false
})
</script>

<template>
  <div class="flex flex-col items-center justify-center text-center" :class="compact ? 'py-6' : 'py-12'">
    <div class="w-12 h-12 rounded-2xl bg-elevated border border-default flex items-center justify-center mb-3">
      <UIcon :name="icon" class="w-6 h-6 text-dimmed" />
    </div>
    <div class="text-sm font-semibold text-highlighted">{{ title }}</div>
    <p v-if="description" class="text-xs text-muted mt-1 max-w-sm">{{ description }}</p>
    <div v-if="$slots.default" class="mt-4">
      <slot />
    </div>
  </div>
</template>

