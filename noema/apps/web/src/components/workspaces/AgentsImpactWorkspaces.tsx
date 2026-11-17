"use client";

import type { QueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CheckCircle2, Clock, Loader2, Play, Sparkles, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import type { ApiFetchFn, NotifyFn } from "../../lib/types";
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

type ImpactResult = Record<string, unknown>;

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function ImpactWorkspace(props: { projectId: string; apiFetch: ApiFetchFn; notify: NotifyFn }) {
  const { projectId, apiFetch, notify } = props;
  const [targets, setTargets] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [impactResult, setImpactResult] = useState<ImpactResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const addTargets = (raw: string) => {
    const ids = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (ids.length) setTargets((prev) => [...new Set([...prev, ...ids])]);
    setDraft("");
  };

  const analyze = () => {
    const all = [...new Set([...targets, ...draft.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)])];
    if (all.length === 0 || loading) return;
    setTargets(all);
    setDraft("");
    setLoading(true);
    void apiFetch<ImpactResult>(`/v1/projects/${encodeURIComponent(projectId)}/change/impact`, {
      method: "POST",
      body: JSON.stringify({ targetIds: all })
    })
      .then((res) => setImpactResult(res))
      .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setLoading(false));
  };

  const summaryEntries = impactResult
    ? Object.entries(impactResult).filter(([, v]) => Array.isArray(v) || typeof v === "number" || typeof v === "string")
    : [];

  return (
    <div className="noema-stack">
      <SectionCard
        title="Análise de impacto"
        subtitle="Informe IDs de regras, ADRs ou símbolos para ver o que é afetado no grafo."
        icon={<Zap size={15} />}
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <div
            className="noema-input"
            style={{ flex: "1 1 320px", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "6px 8px", cursor: "text" }}
          >
            {targets.map((t) => (
              <span key={t} className="noema-chip selected" style={{ cursor: "default" }}>
                <span className="noema-mono">{t}</span>
                <button
                  type="button"
                  aria-label={`Remover ${t}`}
                  onClick={() => setTargets((prev) => prev.filter((x) => x !== t))}
                  style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}
                >
                  ×
                </button>
              </span>
            ))}
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
                  else analyze();
                }
                if (e.key === "Backspace" && !draft && targets.length) setTargets((prev) => prev.slice(0, -1));
              }}
              placeholder={targets.length ? "Adicionar outro ID..." : "Ex.: BR-NOEMA-001, ADR-NOEMA-001"}
              style={{ flex: 1, minWidth: 160, background: "transparent", border: "none", outline: "none", color: "inherit", fontSize: 13, padding: "3px 4px" }}
            />
          </div>
          <button className="noema-btn noema-btn-primary" onClick={analyze} disabled={loading || (targets.length === 0 && !draft.trim())}>
            {loading ? <Loader2 size={14} className="noema-spin" /> : <Zap size={14} />} Analisar
          </button>
        </div>
      </SectionCard>

      {impactResult ? (
        <SectionCard
          title="Resultado"
          actions={
            <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? "Ver resumo" : "Ver JSON"}
            </button>
          }
        >
          {showRaw || summaryEntries.length === 0 ? (
            <pre className="noema-code">{JSON.stringify(impactResult, null, 2)}</pre>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              {summaryEntries.map(([key, value]) => {
                const list = asArray(value);
                return (
                  <div key={key} style={{ padding: 12, borderRadius: 10, border: "1px solid var(--border-subtle)", background: "var(--bg-inset)" }}>
                    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", fontWeight: 600 }}>
                      {key.replace(/([A-Z])/g, " $1")}
                    </div>
                    {Array.isArray(value) ? (
                      <>
                        <div style={{ fontSize: 22, fontWeight: 650, marginTop: 4 }}>{list.length}</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                          {list.slice(0, 6).map((v, i) => (
                            <Badge key={i} tone="neutral">
                              {typeof v === "string" ? v : String((v as Record<string, unknown>)?.id ?? (v as Record<string, unknown>)?.itemId ?? i)}
                            </Badge>
                          ))}
                          {list.length > 6 && <Badge tone="neutral">+{list.length - 6}</Badge>}
                        </div>
                      </>
                    ) : (
                      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4, wordBreak: "break-word" }}>{String(value)}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
      ) : (
        <section className="noema-card">
          <EmptyState
            icon={<Zap size={18} />}
            title="Nenhuma análise executada"
            description="Adicione um ou mais IDs acima e pressione Enter para mapear dependências, testes e serviços afetados."
          />
        </section>
      )}
    </div>
  );
}
