---
id: BR-NOEMA-010
title: Herança Unificada de Permissões entre Usuário e Agente Vinculado
type: business_rule
status: approved
domainId: 1
accessPolicyId: internal-project
tags:
  - rbac
  - security
  - agents
  - mcp
---

# BR-NOEMA-010: Herança Unificada Humano-Agente

## Regra de Negócio
1. Permissões granulares cobrem menus (`menu:*`), leitura/busca (`knowledge:view`, `knowledge:read`, `knowledge:search`), escrita/aprovação (`knowledge:write`, `knowledge:approve`, `proposals:decide`), Runner, FinOps, Auditoria e administração (`roles:manage`, `users:assign_roles`).
2. Cargos agrupam permissões + `allowedPolicies` (ex.: `public-org`, `internal-project`).
3. Quando `inheritUserPermissions` está ativo no vínculo usuário-agente, o agente vinculado herda integralmente todas as permissões do usuário, sem separação artificial entre humano e IA.
4. Exceções pontuais são aplicadas via `extraPermissions` e `deniedPermissions` por usuário.

