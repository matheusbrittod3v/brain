---
name: spec-driven-planning
description: Fluxo Spec-Driven (OpenSpec / Spec-Kit) para planejar features em .brain/specs antes de alterar código.
---

# Spec-Driven Planning

Sempre que iniciar uma nova funcionalidade ou refatoração relevante no projeto:

1. **Consultar o Hub**: Use `brain_search` e `brain_list_skills` para verificar specs e regras de negócio já existentes.
2. **Registrar a Spec**: Use `brain_upsert_knowledge_spec` (`type: "spec"`) com:
   - Contexto e objetivo arquitetural;
   - Requisitos e critérios de aceite;
   - Checklist executável com `- [ ]` para cada etapa técnica.
3. **Vincular no Grafo**: Conecte a Spec às regras (`DEPENDS_ON`), arquivos (`IMPACTS`) e testes (`VERIFIED_BY`).
4. **Executar & Validar**: Implemente cada item do checklist e atualize a Spec para `approved` após validação.

