export interface RunnerPluginItem {
  id: string
  name: string
  version: string
  description: string
  source: 'builtin' | 'local' | 'npm' | 'git'
  sourceRef?: string
  category: 'workflow' | 'security' | 'code' | 'docs' | 'integration'
  enabled: boolean
  skills: string[]
  tools: string[]
  hooks: string[]
  config: Record<string, string>
  env: Record<string, string>
  installedAt: string
  updatedAt: string
}

export interface RunnerPluginPreset {
  id: string
  name: string
  version: string
  description: string
  category: RunnerPluginItem['category']
  skills: string[]
  tools: string[]
  hooks: string[]
  defaultConfig: Record<string, string>
}

export interface RunnerMcpServerItem {
  id: string
  name: string
  description?: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  env?: Record<string, string>
  enabled: boolean
  source?: 'manual' | 'preset' | 'imported'
  lastTest?: {
    ok: boolean
    latencyMs?: number
    serverName?: string
    serverVersion?: string
    error?: string
    testedAt: string
  }
}

export interface RunnerMcpPreset {
  id: string
  name: string
  description: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  requiredEnv?: string[]
}

export function parseKeyValueLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const val = trimmed.slice(idx + 1).trim()
    if (key) out[key] = val
  }
  return out
}

export function formatKeyValueLines(obj?: Record<string, string>): string {
  if (!obj) return ''
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n')
}

