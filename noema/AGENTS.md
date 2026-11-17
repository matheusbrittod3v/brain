# Noema — Project Brain OS 2.0

Use sempre o servidor MCP `noema` antes de editar código crítico. O catálogo é extensível; atualmente há 14 ferramentas. Documente cada ferramenta nova ou alterada em `docs/02-specifications/mcp-and-api-spec.md` e mantenha `protocols/mcp-tools/catalog.json`, paridade HTTP/stdio e testes de autorização alinhados:
1. `brain_context_build` para montar o Context Pack da tarefa.
2. `brain_validate_implementation` antes de concluir alterações em regras de negócio.
3. `brain_create_handoff` / `brain_resume_handoff` para continuidade cross-IDE.
