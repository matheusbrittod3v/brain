<script setup lang="ts">
defineProps<{
  title: string
  description?: string
  icon?: string
}>()
</script>

<template>
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-5 mb-6 border-b border-default">
    <div class="flex items-center gap-3 min-w-0">
      <div
        v-if="icon"
        class="shrink-0 w-10 h-10 rounded-xl bg-primary/10 border border-primary/25 flex items-center justify-center"
      >
        <UIcon :name="icon" class="w-5 h-5 text-primary" />
      </div>
      <div class="min-w-0">
        <h1 class="text-lg font-bold tracking-tight text-highlighted truncate">{{ title }}</h1>
        <p v-if="description" class="text-xs text-muted mt-0.5">{{ description }}</p>
      </div>
    </div>
    <div v-if="$slots.actions" class="flex items-center gap-2 flex-wrap">
      <slot name="actions" />
    </div>
  </div>
</template>

