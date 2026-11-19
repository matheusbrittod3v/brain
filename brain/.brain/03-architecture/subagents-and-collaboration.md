---
id: ARCH-BRAIN-SUBAGENTS
title: Orquestração de Subagentes, Runner Primário/Secundário e Handoffs
type: architecture_decision
status: approved
access_policy: internal-project
knowledgeLayer: architecture
---

# Agentes, Subagentes e Continuidade

```mermaid
flowchart LR
  Primary["Runner Primário (codex / gpt-5.6-luna)"] -->|Fallback| Secondary["Runner Secundário (antigravity-cli / gemini-3.8-flash)"]
  Secondary -->|Fallback Local| Local["Subagente Local (ollama / gemma2:2b)"]
  Primary --> Lease["File Leases (brain_acquire_lease)"]
  Primary --> Handoff["Handoffs (brain_create_handoff / resume)"]
  Primary --> Audit["Audit Logs + FinOps Usage"]
```

- **Isolamento de Edição**: Agentes adquirem `file leases` (`brain_acquire_lease`) antes de modificar arquivos em paralelo, evitando conflitos.
- **Continuidade**: `brain_create_handoff` e `brain_resume_handoff` preservam decisões, pendências e estado entre sessões.
- **Roteamento Resiliente**: `codex` (primário) → `antigravity-cli` (secundário) → `ollama` / `9router` (fallbacks).
