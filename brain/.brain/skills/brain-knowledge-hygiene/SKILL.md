---
name: brain-knowledge-hygiene
description: Higiene de conhecimento, segredos, citações e versionamento no .brain/.
---

# Brain Knowledge Hygiene

1. **Zero Segredos**: Nunca grave tokens, chaves privadas ou strings de conexão em specs, docs ou skills.
2. **Versionamento**: Ao atualizar uma spec ou regra existente, mantenha o mesmo `id` para preservar o histórico de versões e diff.
3. **Evidência por Testes**: Toda regra crítica (`business_rule`) deve possuir ao menos um vínculo `VERIFIED_BY` para manter o Health Score elevado.

