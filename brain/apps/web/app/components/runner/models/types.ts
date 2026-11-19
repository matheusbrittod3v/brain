export interface ModelCatalogItem {
  id: string
  name?: string
  free?: boolean
  custom?: boolean
  disabled?: boolean
}

export interface RunnerProviderItem {
  id: string
  mode: 'http' | 'cli'
  format?: string
  category: 'local' | 'cloud' | 'gateway' | 'cli'
  hasFree?: boolean
  supportsOAuth?: boolean
  supportsLocalImport?: boolean
  connectedAccount?: {
    authType: string
    email?: string
    planType?: string
    updatedAt?: string
  }
  baseUrl?: string
  envKey?: string
  cliCommand?: string[]
  configured: boolean
  online: boolean
  connectionError?: string
  discoveredModels: string[]
  models: ModelCatalogItem[]
}

export interface RoutingTarget {
  provider: string
  model: string
  baseUrl?: string
}

export const CATEGORY_TABS = [
  { label: 'Todos', value: 'all' },
  { label: 'Gratuitos', value: 'free' },
  { label: 'Local', value: 'local' },
  { label: 'Gateway / OAuth', value: 'gateway' },
  { label: 'Cloud API', value: 'cloud' },
  { label: 'CLI', value: 'cli' }
]

export function categoryColor(cat: RunnerProviderItem['category']) {
  if (cat === 'local') return 'success'
  if (cat === 'gateway') return 'primary'
  if (cat === 'cli') return 'warning'
  return 'neutral'
}

export function categoryLabel(cat: RunnerProviderItem['category']) {
  if (cat === 'local') return 'Local'
  if (cat === 'gateway') return 'Gateway / OAuth'
  if (cat === 'cli') return 'CLI'
  return 'Cloud API'
}

