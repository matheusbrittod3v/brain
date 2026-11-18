---
id: DOC-BRAIN-ONBOARDING-001
type: document
title: Guia de onboarding e mapa da documentação do Brain
status: approved
access_policy: internal-project
trust_level: verified
tags: [onboarding, documentation, architecture]
---

# Guia de onboarding do Brain

Este guia ajuda quem está chegando ao projeto a localizar os principais componentes, preparar o ambiente e encontrar a documentação técnica de referência.

## O que é o Brain

O Brain é um Project Brain OS que conecta código, arquitetura, regras de negócio, conhecimento e agentes de IA. O projeto prevê execução local (Local Edge) e serviços compartilhados (Enterprise Hub), com controles de isolamento e governança.

## Mapa do monorepo

- `apps/api`: API HTTP e gateway.
- `apps/mcp-server`: servidor e ferramentas MCP.
- `apps/cli`: interface de linha de comando `brain`.
- `apps/worker` e `apps/agent-runner`: processamento assíncrono e execução de tarefas.
- `apps/ai-worker`: processamento de tarefas de IA.
- `apps/web`: aplicação web.
- `integrations/`: integrações com GitHub, extensões de IDE e SaaS.
- `packages/`: componentes compartilhados, incluindo contratos centrais, persistência, contexto, conhecimento, grafo, memória e análise de código.
- `protocols/`: contratos JSON Schema para handoff, context pack, sincronização Edge, eventos de conhecimento, ferramentas MCP, manifesto de projeto e tarefas do runner.
- `infra/`: configurações de Docker, Kubernetes, OPA e Terraform.

## Onde encontrar mais detalhes

Os documentos de arquitetura e especificação ficam em `../docs/` a partir deste diretório:

- `../docs/00-normative-decisions.md`: decisões normativas e invariantes do projeto.
- `../docs/01-architecture/`: arquitetura, modelo de dados, busca, memória, gateway e sincronização Edge.
- `../docs/02-specifications/`: capacidades, contratos MCP/API, integrações e estrutura do conhecimento.
- `../docs/03-security-and-governance/security-architecture.md`: isolamento, autorização e governança.
- `../docs/04-roadmap/`: desenvolvimento local, riscos, roadmap e blueprint.
- `.brain/`: visão, regras, decisões e padrões estruturados consumidos pelo Brain.

O `README.md` descreve a instalação e os detalhes operacionais do banco de dados. Em caso de divergência, use as decisões normativas e a documentação técnica específica como referência e atualize este guia.

## Preparar o ambiente local

Execute a partir do diretório `brain/`:

1. Copie `.env.example` para `.env` e configure os valores locais.
2. Instale as dependências com `npm install`.
3. Inicie a infraestrutura local com `npm run infra:up`.
4. Prepare as roles e aplique as migrations na ordem indicada no README.
5. Execute `npm run typecheck` para verificar os tipos.

Os valores de `.env.example` são destinados apenas ao desenvolvimento local. Consulte o README e a documentação de segurança para roles, RLS, migrations e uso de credenciais.

## Fluxo recomendado para mudanças

1. Leia as decisões normativas e a especificação do componente afetado.
2. Consulte o Context Pack e as regras do projeto no Brain antes de alterar comportamento ou código crítico.
3. Faça a mudança no serviço ou pacote responsável e atualize os contratos e documentos relacionados.
4. Execute as verificações apropriadas ao escopo e valide mudanças críticas com `brain validate` ou a ferramenta MCP equivalente.

Mantenha os caminhos e comandos deste guia sincronizados com a árvore atual do projeto.
