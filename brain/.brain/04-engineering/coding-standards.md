---
id: ENG-BRAIN-001
title: Padrões de Engenharia e Segurança
type: spec
status: approved
access_policy: internal-project
knowledgeLayer: code
---

# Padrões de Engenharia

- Não duplicar lógica entre apps/packages; reutilizar contratos de `@brain/core` e repositórios de `@brain/database`.
- Todas as rotas da API devem passar pelo `registerRbacGuard` salvo endpoints explicitamente públicos de autenticação/discovery.
- Executar `scanForSecrets` antes de indexar documentos ou arquivos de workspace.
