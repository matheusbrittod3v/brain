<script setup lang="ts">
export interface SegmentedTabItem {
  label: string
  value: string
  icon?: string
  badge?: number | string
}

defineProps<{
  items: SegmentedTabItem[]
}>()

const model = defineModel<string>({ required: true })
</script>

<template>
  <div
    role="tablist"
    class="inline-flex flex-wrap gap-1 p-1 rounded-xl bg-elevated/60 border border-default max-w-full"
  >
    <button
      v-for="tab in items"
      :key="tab.value"
      type="button"
      role="tab"
      :aria-selected="model === tab.value"
      class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer whitespace-nowrap"
      :class="model === tab.value
        ? 'bg-primary text-inverted shadow-sm'
        : 'text-muted hover:text-highlighted hover:bg-accented/50'"
      @click="model = tab.value"
    >
      <UIcon v-if="tab.icon" :name="tab.icon" class="w-3.5 h-3.5" />
      <span>{{ tab.label }}</span>
      <span
        v-if="tab.badge !== undefined && tab.badge !== 0"
        class="ml-0.5 px-1.5 py-px rounded-full text-[10px] tabular-nums"
        :class="model === tab.value ? 'bg-white/20' : 'bg-accented text-muted'"
      >{{ tab.badge }}</span>
    </button>
  </div>
</template>

