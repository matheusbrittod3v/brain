---
id: ARCH-BRAIN-RUNNER
title: Arquitetura do Brain Agent Runner e Multi-Provider OAuth
type: architecture_decision
status: approved
access_policy: internal-project
knowledgeLayer: architecture
---

# Arquitetura do `apps/agent-runner`

```mermaid
flowchart LR
  Queue["queue.ts + daemon.ts"] --> Lock["model-lock.ts + FinOps"]
  Lock --> Local["local-executors.ts (Ollama / Agy CLI)"]
  Lock --> Cloud["cloud-executors.ts (OpenAI / Gemini / Anthropic)"]
  Cloud --> OAuth["oauth/ (flows, store, callback-server)"]
  Local --> Sandbox["sandbox.ts"]
  Runner --> Ext["extensions/ (MCPs & Plugins)"]
```

- **Módulos**: `queue.ts`, `sandbox.ts`, `local-executors.ts`, `cloud-executors.ts`, `model-lock.ts`, `daemon.ts`, `oauth/*`, `extensions/*`.
- **Extensões**: gerenciamento e teste de servidores MCP externos e plugins em `extensions/manager.ts`, `mcp-tester.ts`, `presets.ts`.
