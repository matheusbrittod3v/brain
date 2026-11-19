---
id: LIMITS-AND-CONSTRAINTS
title: "Limites Arquiteturais, Restrições e Invariantes do Project Brain OS"
status: approved
type: limit_constraint
layer: product
access_policy: internal-project
tags:
  - layer:product
  - constraints
  - engineering-standards
  - invariants
---

# Limites Arquiteturais e Restrições Inegociáveis

Este documento define os limites formais e restrições técnicas que todo agente, desenvolvedor e pipeline deve respeitar ao contribuir no repositório.

## 1. Limite Estrito de Tamanho por Arquivo (Regra dos 700 Linhas)
- **Restrição**: Nenhum arquivo de código fonte (`.ts`, `.vue`, `.js`) deve ultrapassar **700 linhas** de código.
- **Justificativa**: Preservar legibilidade, manutenibilidade por múltiplos agentes autônomos, agilidade no code review e desacoplamento modular.
- **Como cumprir**: Dividir controladores extensos em submódulos de rotas dedicados (ex.: `knowledge-daily.ts`, `knowledge-intelligence.ts`, `mcp-gateway.ts`) e interfaces Vue em subcomponentes atômicos.

## 2. Isolamento Multi-Tenant e RLS Obrigatório
- **Restrição**: Nenhuma query SQL direta na tabela `knowledge_items`, `audit_logs` ou `tasks` pode ignorar o contexto de `tenant_id` e `project_id`.
- **Justificativa**: Garantia de confidencialidade de dados entre diferentes organizações e isolamento formal de projetos restritos.
- **Implementação**: Uso do pool autenticado `brain_app` com GUCs PostgreSQL configuradas (`app.current_tenant_id`, `app.current_project_id`).

## 3. Proibição de Hardcoded Secrets
- **Restrição**: É estritamente proibido gravar chaves de API, senhas de banco ou tokens em código fonte, mensagens de commit ou artefatos.
- **Justificativa**: Prevenção de vazamentos de credenciais corporativas.
- **Mecanismo**: Todos os inputs de perfil e conhecimentos passam pela função `assertSecretScanClean(scanForSecrets(...))`. Tokens externos são mantidos criptografados na tabela `system_settings` ou via variáveis de ambiente.

## 4. Modificações em Modo Rascunho (Draft-First)
- **Restrição**: Agentes de IA operam por padrão em modo `draft-only`.
- **Justificativa**: Nenhuma regra de negócio crítica ou decisão de arquitetura é ativada em produção sem revisão humana formal no Inbox de Propostas (`/inbox`).

## 5. Compatibilidade Retroativa em Contratos MCP
- **Restrição**: Ferramentas MCP existentes não podem ter seus parâmetros obrigatórios renomeados ou removidos sem ciclo de depreciação.
- **Justificativa**: Evitar falhas em subagentes externos, clientes IDE e rotinas automatizadas que dependem do catálogo de ferramentas.
