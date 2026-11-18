<script setup lang="ts">
import * as echarts from 'echarts'

const props = defineProps<{
  option: echarts.EChartsOption
  height?: string
}>()

const chartRef = ref<HTMLDivElement | null>(null)
let chartInstance: echarts.ECharts | null = null

function renderChart() {
  if (!chartRef.value) return
  if (!chartInstance) {
    chartInstance = echarts.init(chartRef.value, 'dark')
  }
  chartInstance.setOption({
    backgroundColor: 'transparent',
    ...props.option
  }, true)
}

onMounted(() => {
  renderChart()
  window.addEventListener('resize', handleResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize)
  chartInstance?.dispose()
})

watch(() => props.option, () => {
  renderChart()
}, { deep: true })

function handleResize() {
  chartInstance?.resize()
}
</script>

<template>
  <div ref="chartRef" :style="{ width: '100%', height: height || '260px' }" />
</template>

