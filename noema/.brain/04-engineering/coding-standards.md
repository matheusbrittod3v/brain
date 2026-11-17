---
id: STD-NOEMA-001
type: document
title: Padrões de Escrita de Código e Qualidade do Noema
status: approved
access_policy: internal-project
trust_level: verified
tags: [coding-standards, typescript, testing, security]
---

# Padrões de Escrita de Código — Noema

## 1. TypeScript & ESM
- Sempre usar **ESM nativo** (`"type": "module"`) com extensão explícita `.js` nos imports relativos (`import { ... } from "./client.js"`).
- `strict: true` no TypeScript; evitar `any` (preferir `unknown` com narrowing ou schemas **TypeBox** / **Zod**).
- Não duplicar lógica: extrair helpers compartilhados e usar early returns com aninhamento raso.

## 2. Segurança & Erros
- Lançar sempre `BrainError` com códigos padronizados (`BRAIN_ERR_UNAUTHORIZED`, `BRAIN_ERR_POLICY_DENIED`, `BRAIN_ERR_NOT_FOUND`, `BRAIN_ERR_CONFLICT`, `BRAIN_ERR_STORAGE_UNAVAILABLE`).
- Nunca aceitar `tenantId`, `allowedProjects` ou `allowedPolicies` do payload da requisição; derivar sempre do `AuthContext` autenticado.
- Toda query SQL deve parametrizar valores (nunca interpolar strings não confiáveis) e rodar sob `withRlsTransaction` / `withTenantRls` quando usar `brain_app`.
- Nunca silenciar falhas de segurança (Gitleaks, verificação HMAC, RLS, validação de papel).

## 3. Rastreabilidade (`@brain-rule` / `@brain-adr`)
- Vincular código crítico às regras de negócio e ADRs usando comentários `// @brain-rule BR-NOEMA-001` ou `// @brain-adr ADR-NOEMA-001`.
- Validar conformidade arquitetural e de regras antes de merge com `noema validate` (ou `brain_validate_implementation`).

## 4. Testes
- Testes unitários com `node:test` e `node:assert/strict` em `test/*.test.ts` / `test/*.test.mjs`.
- Testes live contra PostgreSQL 16 + `pgvector` em `tests/integration/` validando RLS fail-closed e isolamento cross-tenant.

