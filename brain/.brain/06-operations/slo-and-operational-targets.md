---
id: SLO-OPERATIONAL-TARGETS
title: "SLOs, Metas Operacionais e Alertas do Project Brain OS"
status: approved
type: slo_target
layer: operations
access_policy: internal-project
tags:
  - layer:operations
  - slo
  - sli
  - monitoring
  - performance
---

# Metas Operacionais e Objetivos de Nível de Serviço (SLOs)

Indicadores Chave de Nível de Serviço (SLIs) e metas de conformidade operacional:

## 1. Tabela de SLOs Primários

| Indicador (SLI) | Meta de SLO | Janela | Procedimento em caso de Desvio |
| :--- | :--- | :--- | :--- |
| **Disponibilidade da API REST** | >= 99.9% | 30 dias | Reiniciar container api, checar pool de conexões PostgreSQL |
| **Disponibilidade do MCP Gateway** | >= 99.9% | 30 dias | Verificar portas 3333 e reconexão de sessões Streamable HTTP |
| **Latência de Busca Híbrida (p95)** | < 250 ms | 7 dias | Verificar estado do Valkey e aquecimento de índices HNSW |
| **Latência de Busca Híbrida (p99)** | < 600 ms | 7 dias | Otimizar parâmetros `ef_search` do pgvector e filtros RLS |
| **Hit Ratio do Cache Valkey** | >= 65% | 24 horas | Analisar invalidações frequentes e TTL de chaves |
| **Taxa de Erro de Ingestão do Worker** | < 0.5% | 24 horas | Inspecionar fila BullMQ / PostgreSQL no container worker |

## 2. Níveis de Alerta & Escalonamento

- **Severidade Baixa (P4 / Info)**: Desvio temporário de hit ratio de cache ou novo documento órfão detectado. Ação: alerta assíncrono na tela de operações.
- **Severidade Média (P3 / Warning)**: Latência p95 superior a 350ms em busca semântica. Ação: purga seletiva de cache antigo e análise de concorrência.
- **Severidade Alta (P2 / Error)**: Contêiner Valkey ou MinIO inoperante. Ação: acionamento de fallback em memória / disco local e notificação para SRE.
- **Severidade Crítica (P1 / Critical)**: Banco de dados PostgreSQL pgvector inacessível ou corrupção de tenants. Ação: failover automático e bloqueio de novas mutações.
