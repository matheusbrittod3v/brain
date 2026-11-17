"use client";

import type { QueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCircle2, Clock, GitFork, Layers, Loader2, Network, Play, Search, ShieldAlert, Sparkles, X, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import type { ApiFetchFn, InspectedItemState, KnowledgeHitItem, KnowledgeStatus, NotifyFn } from "../../lib/types";
import { DataTable } from "../DataTable";
import { Badge, EmptyState, SectionCard, Segmented, StatCard, statusTone } from "../UiPrimitives";

type RunnerTask = { taskId: string; instruction: string; status: string; priority: string; resultSummary?: string; createdAt: string };

const RUNNER_SUGGESTIONS = [
  "Gerar documentação viva das regras de negócio sem teste",
  "Revisar ADRs desatualizados e propor atualizações",
  "Mapear impacto de mudança no módulo de autenticação"
];

export function AgentsWorkspace(props: {
  projectId: string;
  tasks: RunnerTask[];
  apiFetch: ApiFetchFn;
  queryClient: QueryClient;
  notify: NotifyFn;
}) {
  const { projectId, tasks, apiFetch, queryClient, notify } = props;
  const [runnerInstruction, setRunnerInstruction] = useState("");
  const [priority, setPriority] = useState<"low" | "normal" | "high">("normal");
  const [submitting, setSubmitting] = useState(false);

  const stats = useMemo(() => {
    let running = 0;
    let done = 0;
    let failed = 0;
    for (const t of tasks) {
      const tone = statusTone(t.status);
      if (tone === "success") done++;
      else if (tone === "danger") failed++;
      else running++;
    }
    return { running, done, failed };
  }, [tasks]);

  const submit = () => {
    const instruction = runnerInstruction.trim();
    if (!instruction || submitting) return;
    setSubmitting(true);
    void apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/runner/tasks`, {
      method: "POST",
      body: JSON.stringify({ instruction, draftOnly: true, priority })
    })
      .then(() => {
        setRunnerInstruction("");
        notify("Tarefa delegada ao Brain Runner.");
        return queryClient.invalidateQueries({ queryKey: ["runner"] });
      })
      .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setSubmitting(false));
  };

  return (
    <div className="noema-stack">
      <div className="noema-grid-stats">
        <StatCard label="Em andamento" value={stats.running} tone="warning" icon={<Clock size={16} />} />
        <StatCard label="Concluídas" value={stats.done} tone="success" icon={<CheckCircle2 size={16} />} />
        <StatCard label="Com falha" value={stats.failed} tone="danger" icon={<AlertTriangle size={16} />} />
      </div>

      <SectionCard
        title="Delegar tarefa ao Brain Runner"
        subtitle="O agente sempre gera rascunhos que passam pela aprovação humana."
        icon={<Bot size={15} />}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <textarea
            className="noema-input"
            rows={3}
            value={runnerInstruction}
            onChange={(e) => setRunnerInstruction(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
            }}
            placeholder="Descreva o que o agente deve fazer..."
            aria-label="Instrução para o Brain Runner"
          />
          {!runnerInstruction && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {RUNNER_SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="noema-chip" onClick={() => setRunnerInstruction(s)}>
                  <Sparkles size={11} /> {s}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Prioridade</span>
              <Segmented
                value={priority}
                onChange={setPriority}
                options={[
                  { id: "low", label: "Baixa" },
                  { id: "normal", label: "Normal" },
                  { id: "high", label: "Alta" }
                ]}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="noema-hide-mobile" style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                <span className="noema-kbd">⌘</span> + <span className="noema-kbd">Enter</span>
              </span>
              <button className="noema-btn noema-btn-primary" onClick={submit} disabled={!runnerInstruction.trim() || submitting}>
                {submitting ? <Loader2 size={14} className="noema-spin" /> : <Play size={14} />} Executar
              </button>
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Execuções" subtitle="Histórico de tarefas do Runner neste projeto">
        <DataTable
          data={tasks}
          emptyText="Nenhuma execução ainda"
          columns={[
            {
              header: "Instrução",
              accessorKey: "instruction",
              cell: ({ row }) => (
                <div style={{ minWidth: 220 }}>
                  <div style={{ fontWeight: 500 }}>{row.original.instruction}</div>
                  <div className="noema-mono" style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    {row.original.taskId}
                  </div>
                </div>
              )
            },
            {
              header: "Status",
              accessorKey: "status",
              cell: ({ row }) => (
                <Badge tone={statusTone(row.original.status)} dot>
                  {row.original.status}
                </Badge>
              )
            },
            {
              header: "Prioridade",
              accessorKey: "priority",
              cell: ({ row }) => <Badge tone={row.original.priority === "high" ? "danger" : "neutral"}>{row.original.priority}</Badge>
            },
            {
              header: "Resumo",
              accessorKey: "resultSummary",
              cell: ({ row }) => (
                <span style={{ color: row.original.resultSummary ? "var(--text-secondary)" : "var(--text-muted)", fontSize: 12.5 }}>
                  {row.original.resultSummary || "—"}
                </span>
              )
            }
          ]}
          searchPlaceholder="Filtrar execuções..."
        />
      </SectionCard>
    </div>
  );
}

interface ImpactTraversalHit {
  itemId: string;
  projectId: string;
  hops: number;
  via: string;
  isInferred?: boolean;
}

interface ImpactRuleRef {
  id: string;
  title?: string;
  priority: string;
  status?: string;
}

interface CrossServiceImpact {
  contractId: string;
  impactedServices?: string[];
  impactedProjects?: string[];
}

interface ImpactReport {
  projectId: string;
  confirmedImpacts?: ImpactTraversalHit[];
  hypotheses?: ImpactTraversalHit[];
  directImpacts?: ImpactTraversalHit[];
  transitiveImpacts?: ImpactTraversalHit[];
  crossServiceImpacts?: CrossServiceImpact[];
  criticalRulesImpacted?: ImpactRuleRef[];
  riskLevel?: "low" | "medium" | "high" | "critical" | string;
}

const RISK_META: Record<string, { label: string; tone: "success" | "warning" | "danger" | "default" }> = {
  low: { label: "Risco Baixo", tone: "success" },
  medium: { label: "Risco Médio", tone: "warning" },
  high: { label: "Risco Alto", tone: "danger" },
  critical: { label: "Risco Crítico", tone: "danger" }
};

const TYPE_FILTERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "all", label: "Todos" },
  { id: "business_rule", label: "Regras" },
  { id: "adr", label: "ADRs" },
  { id: "code_symbol", label: "Código" },
  { id: "test", label: "Testes" },
  { id: "doc", label: "Docs" }
];

export function ImpactWorkspace(props: {
  projectId: string;
  knowledgeItems?: KnowledgeHitItem[];
  onInspect?: (item: InspectedItemState) => void;
  apiFetch: ApiFetchFn;
  notify: NotifyFn;
}) {
  const { projectId, knowledgeItems = [], onInspect, apiFetch, notify } = props;
  const [targets, setTargets] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [pickerSearch, setPickerSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [impactResult, setImpactResult] = useState<ImpactReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [resultTab, setResultTab] = useState<"all" | "direct" | "transitive" | "hypotheses" | "rules" | "cross" | "json">("all");

  const itemById = useMemo(() => new Map(knowledgeItems.map((item) => [item.id, item])), [knowledgeItems]);

  const filteredCandidates = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    return knowledgeItems
      .filter((item) => typeFilter === "all" || item.type === typeFilter)
      .filter((item) => !q || item.id.toLowerCase().includes(q) || item.title.toLowerCase().includes(q) || item.sourceUri.toLowerCase().includes(q))
      .slice(0, 18);
  }, [knowledgeItems, pickerSearch, typeFilter]);

  const toggleTarget = (id: string) => {
    setTargets((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const addTargets = (raw: string) => {
    const ids = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (ids.length) setTargets((prev) => [...new Set([...prev, ...ids])]);
    setDraft("");
  };

  const runAnalysis = (explicitIds?: string[]) => {
    const all = explicitIds
      ? [...new Set(explicitIds)]
      : [...new Set([...targets, ...draft.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)])];
    if (all.length === 0 || loading) return;
    setTargets(all);
    setDraft("");
    setLoading(true);
    void apiFetch<ImpactReport>(`/v1/projects/${encodeURIComponent(projectId)}/change/impact`, {
      method: "POST",
      body: JSON.stringify({ targetIds: all })
    })
      .then((res) => {
        setImpactResult(res);
        setResultTab("all");
      })
      .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setLoading(false));
  };

  const confirmed = impactResult?.confirmedImpacts ?? [];
  const hypotheses = impactResult?.hypotheses ?? [];
  const direct = impactResult?.directImpacts ?? [];
  const transitive = impactResult?.transitiveImpacts ?? [];
  const crossService = impactResult?.crossServiceImpacts ?? [];
  const criticalRules = impactResult?.criticalRulesImpacted ?? [];
  const allHits = useMemo(() => [...confirmed, ...hypotheses], [confirmed, hypotheses]);

  const riskKey = String(impactResult?.riskLevel ?? "low").toLowerCase();
  const riskMeta = RISK_META[riskKey] ?? { label: riskKey, tone: "default" as const };

  const visibleHits = useMemo(() => {
    if (resultTab === "direct") return direct;
    if (resultTab === "transitive") return transitive;
    if (resultTab === "hypotheses") return hypotheses;
    return allHits;
  }, [resultTab, direct, transitive, hypotheses, allHits]);

  return (
    <div className="noema-stack">
      <SectionCard
        title="Análise de impacto"
        subtitle="Selecione regras, ADRs ou símbolos do projeto (ou digite IDs) para simular o raio de impacto no grafo."
        icon={<Zap size={15} />}
        actions={
          targets.length > 0 && (
            <button type="button" className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => setTargets([])}>
              Limpar ({targets.length})
            </button>
          )
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Alvos selecionados + entrada manual */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <div
              className="noema-input"
              style={{ flex: "1 1 340px", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "6px 8px", cursor: "text" }}
            >
              {targets.map((t) => {
                const found = itemById.get(t);
                return (
                  <span key={t} className="noema-chip selected" style={{ cursor: "default" }} title={found?.title}>
                    <span className="noema-mono">{t}</span>
                    {found && (
                      <span style={{ opacity: 0.78, fontSize: 11, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        · {found.title}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`Remover ${t}`}
                      onClick={() => setTargets((prev) => prev.filter((x) => x !== t))}
                      style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                );
              })}
              <input
                value={draft}
                onChange={(e) => {
                  const v = e.target.value;
                  if (/[,\s]$/.test(v)) addTargets(v);
                  else setDraft(v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (draft.trim()) addTargets(draft);
                    else runAnalysis();
                  }
                  if (e.key === "Backspace" && !draft && targets.length) setTargets((prev) => prev.slice(0, -1));
                }}
                placeholder={targets.length ? "Adicionar outro ID..." : "Selecione abaixo ou digite IDs (ex.: BR-NOEMA-001)..."}
                style={{ flex: 1, minWidth: 180, background: "transparent", border: "none", outline: "none", color: "inherit", fontSize: 13, padding: "3px 4px" }}
              />
            </div>
            <button
              className="noema-btn noema-btn-primary"
              onClick={() => runAnalysis()}
              disabled={loading || (targets.length === 0 && !draft.trim())}
            >
              {loading ? <Loader2 size={14} className="noema-spin" /> : <Zap size={14} />}
              Analisar{targets.length > 0 ? ` (${targets.length})` : ""}
            </button>
          </div>

          {/* Seletor rápido de itens do projeto */}
          {knowledgeItems.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 8, borderTop: "1px solid var(--border-subtle)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {TYPE_FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      className={`noema-chip ${typeFilter === f.id ? "selected" : ""}`}
                      onClick={() => setTypeFilter(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <div style={{ position: "relative", minWidth: 210, flex: "0 1 260px" }}>
                  <Search size={13} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
                  <input
                    className="noema-input"
                    value={pickerSearch}
                    onChange={(e) => setPickerSearch(e.target.value)}
                    placeholder="Filtrar itens por nome ou ID..."
                    style={{ width: "100%", paddingLeft: 30, fontSize: 12.5 }}
                  />
                </div>
              </div>

              {filteredCandidates.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "6px 2px" }}>
                  Nenhum item corresponde ao filtro atual.
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(240px, 100%), 1fr))", gap: 6, maxHeight: 210, overflowY: "auto", paddingRight: 2 }}>
                  {filteredCandidates.map((item) => {
                    const selected = targets.includes(item.id);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => toggleTarget(item.id)}
                        style={{
                          textAlign: "left",
                          padding: "8px 10px",
                          borderRadius: 9,
                          border: `1px solid ${selected ? "var(--accent-primary)" : "var(--border-subtle)"}`,
                          background: selected ? "rgba(99,102,241,0.12)" : "var(--bg-inset)",
                          color: "var(--text-primary)",
                          cursor: "pointer",
                          display: "flex",
                          flexDirection: "column",
                          gap: 3,
                          minWidth: 0
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                          <span className="noema-mono noema-truncate" style={{ fontSize: 11, color: selected ? "#a5b4fc" : "var(--text-muted)" }}>
                            {item.id}
                          </span>
                          <Badge tone={selected ? "accent" : "neutral"}>{item.type}</Badge>
                        </div>
                        <span className="noema-truncate" style={{ fontSize: 12.5, fontWeight: 550 }}>
                          {item.title}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </SectionCard>

      {impactResult ? (
        <>
          {/* KPIs do Resultado */}
          <div className="noema-grid-stats">
            <StatCard
              label="Nível de risco"
              value={riskMeta.label}
              tone={riskMeta.tone}
              icon={<ShieldAlert size={16} />}
              hint={`${confirmed.length} confirmados · ${hypotheses.length} hipóteses`}
            />
            <StatCard
              label="Impactos diretos"
              value={direct.length}
              tone={direct.length > 0 ? "warning" : "success"}
              icon={<Zap size={16} />}
              hint="Distância de 1 hop no grafo"
            />
            <StatCard
              label="Impactos transitivos"
              value={transitive.length}
              tone="accent"
              icon={<GitFork size={16} />}
              hint="Efeitos em cadeia (2+ hops)"
            />
            <StatCard
              label="Regras críticas"
              value={criticalRules.length}
              tone={criticalRules.length > 0 ? "danger" : "success"}
              icon={<AlertTriangle size={16} />}
              hint={`${crossService.length} contratos cross-service`}
            />
          </div>

          <SectionCard
            title="Itens e dependências afetadas"
            subtitle={`Alvos analisados: ${targets.join(", ")}`}
            icon={<Network size={15} />}
            flush={resultTab !== "json"}
            actions={
              <Segmented
                value={resultTab}
                onChange={setResultTab}
                options={[
                  { id: "all", label: `Todos (${allHits.length})` },
                  { id: "direct", label: `Diretos (${direct.length})` },
                  { id: "transitive", label: `Transitivos (${transitive.length})` },
                  { id: "hypotheses", label: `Hipóteses (${hypotheses.length})` },
                  { id: "rules", label: `Regras (${criticalRules.length})` },
                  { id: "cross", label: `Cross-Service (${crossService.length})` },
                  { id: "json", label: "JSON" }
                ]}
              />
            }
          >
            {resultTab === "json" ? (
              <pre className="noema-code">{JSON.stringify(impactResult, null, 2)}</pre>
            ) : resultTab === "rules" ? (
              criticalRules.length === 0 ? (
                <EmptyState icon={<CheckCircle2 size={18} />} title="Nenhuma regra crítica impactada" description="Nenhuma business_rule foi atingida diretamente nesta análise." />
              ) : (
                <div className="noema-list">
                  {criticalRules.map((r) => {
                    const found = itemById.get(r.id);
                    return (
                      <div key={r.id} className="noema-list-row" style={{ padding: "10px 16px" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                          <span className="noema-truncate" style={{ fontSize: 13, fontWeight: 550 }}>
                            {r.title || found?.title || r.id}
                          </span>
                          <span className="noema-mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {r.id}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                          <Badge tone={r.priority === "critical" || r.priority === "high" ? "danger" : "warning"}>
                            {r.priority}
                          </Badge>
                          {r.status && <Badge tone={statusTone(r.status)}>{r.status}</Badge>}
                          <button type="button" className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => runAnalysis([r.id])}>
                            Analisar este
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )
            ) : resultTab === "cross" ? (
              crossService.length === 0 ? (
                <EmptyState icon={<Layers size={18} />} title="Sem impacto cross-service" description="Nenhum contrato distribuído entre serviços foi atingido." />
              ) : (
                <div className="noema-list">
                  {crossService.map((c) => (
                    <div key={c.contractId} className="noema-list-row" style={{ padding: "10px 16px" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                        <strong className="noema-mono" style={{ fontSize: 13 }}>{c.contractId}</strong>
                        <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                          Serviços: {(c.impactedServices ?? []).join(", ") || "—"} · Projetos: {(c.impactedProjects ?? []).join(", ") || "—"}
                        </span>
                      </div>
                      <Badge tone="danger">Cross-service</Badge>
                    </div>
                  ))}
                </div>
              )
            ) : visibleHits.length === 0 ? (
              <EmptyState icon={<CheckCircle2 size={18} />} title="Nenhum impacto nesta categoria" description="Os alvos selecionados não possuem relações mapeadas neste recorte." />
            ) : (
              <div className="noema-list">
                {visibleHits.map((hit, i) => {
                  const found = itemById.get(hit.itemId);
                  return (
                    <div
                      key={`${hit.projectId}-${hit.itemId}-${hit.via}-${i}`}
                      className="noema-list-row"
                      style={{ padding: "10px 16px", cursor: found && onInspect ? "pointer" : "default" }}
                      onClick={() => {
                        if (found && onInspect) {
                          onInspect({
                            title: found.title,
                            subtitle: `${found.type} · ${found.sourceUri}`,
                            body: found.content,
                            itemId: found.id,
                            status: found.status as KnowledgeStatus,
                            meta: { via: hit.via, hops: hit.hops, isInferred: Boolean(hit.isInferred) }
                          });
                        }
                      }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                        <span className="noema-truncate" style={{ fontSize: 13, fontWeight: 550 }}>
                          {found?.title ?? hit.itemId}
                        </span>
                        <span className="noema-mono noema-truncate" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {hit.itemId}{found ? ` · ${found.type} · ${found.sourceUri}` : ""}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
                        <Badge tone="accent">{hit.via}</Badge>
                        <Badge tone={hit.hops <= 1 ? "warning" : "neutral"}>
                          {hit.hops} {hit.hops === 1 ? "hop" : "hops"}
                        </Badge>
                        <Badge tone={hit.isInferred ? "warning" : "success"} dot>
                          {hit.isInferred ? "Hipótese" : "Confirmado"}
                        </Badge>
                        <button
                          type="button"
                          className="noema-btn noema-btn-ghost noema-btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            runAnalysis([hit.itemId]);
                          }}
                        >
                          Pivotar
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>
        </>
      ) : (
        <section className="noema-card">
          <EmptyState
            icon={<Zap size={18} />}
            title="Nenhuma análise executada"
            description="Selecione um ou mais itens acima e clique em Analisar para mapear dependências, testes, regras críticas e contratos afetados."
          />
        </section>
      )}
    </div>
  );
}
