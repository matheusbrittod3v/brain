"use client";

import type { QueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Cpu, Database, Loader2, Plug, ScrollText, UserCog, Wallet, Zap } from "lucide-react";
import { useState } from "react";
import type { ApiFetchFn, NotifyFn } from "../../lib/types";
import { FinOpsBarChart } from "../Charts";
import { DataTable } from "../DataTable";
import { Badge, EmptyState, Field, SectionCard, StatCard } from "../UiPrimitives";

const PROVIDER_META: Record<string, { label: string; desc: string; color: string }> = {
  github: { label: "GitHub", desc: "Código, PRs e webhooks de push", color: "#e5e7eb" },
  slack: { label: "Slack", desc: "Notificações e aprovações interativas", color: "#e879f9" },
  teams: { label: "Microsoft Teams", desc: "Aprovações e alertas em canais", color: "#818cf8" },
  jira: { label: "Jira", desc: "Sincronização de issues e decisões", color: "#60a5fa" },
  clickup: { label: "ClickUp", desc: "Tarefas e status de entregas", color: "#a78bfa" },
  email: { label: "E-mail", desc: "Digests e aprovações por link", color: "#fbbf24" },
  confluence: { label: "Confluence", desc: "Documentação corporativa", color: "#38bdf8" },
  notion: { label: "Notion", desc: "Páginas e bases de conhecimento", color: "#f5f5f5" }
};

export function IntegrationsWorkspace(props: {
  projectId: string;
  notificationChannels: Array<{ provider: string; configured: boolean }>;
  apiFetch: ApiFetchFn;
  queryClient: QueryClient;
  notify: NotifyFn;
}) {
  const { projectId, notificationChannels, apiFetch, queryClient, notify } = props;
  const [fallbackProvider, setFallbackProvider] = useState(notificationChannels[0]?.provider ?? "github");
  const [fallbackOwner, setFallbackOwner] = useState("");
  const [saving, setSaving] = useState(false);
  const connected = notificationChannels.filter((c) => c.configured).length;

  const saveFallback = () => {
    if (!fallbackOwner.trim()) return notify("Informe o responsável de fallback.", "error");
    setSaving(true);
    void apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/integrations/${encodeURIComponent(fallbackProvider)}/fallback-owner`, {
      method: "PUT",
      body: JSON.stringify({ fallbackOwner: fallbackOwner.trim() })
    })
      .then(() => {
        notify("Responsável de fallback salvo.");
        setFallbackOwner("");
        return queryClient.invalidateQueries({ queryKey: ["integrations"] });
      })
      .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setSaving(false));
  };

  return (
    <div className="noema-stack">
      <SectionCard
        title="Canais conectados"
        subtitle={`${connected} de ${notificationChannels.length} integrações configuradas`}
        icon={<Plug size={15} />}
      >
        {notificationChannels.length === 0 ? (
          <EmptyState icon={<Plug size={18} />} title="Nenhum canal disponível" description="Configure as variáveis de ambiente das integrações na API." />
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
            {notificationChannels.map((ch) => {
              const meta = PROVIDER_META[ch.provider] ?? { label: ch.provider, desc: "Integração externa", color: "#94a3b8" };
              return (
                <div
                  key={ch.provider}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: 14,
                    borderRadius: 12,
                    border: `1px solid ${ch.configured ? "rgba(16,185,129,0.28)" : "var(--border-subtle)"}`,
                    background: ch.configured ? "rgba(16,185,129,0.04)" : "var(--bg-inset)"
                  }}
                >
                  <span
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      flexShrink: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 700,
                      fontSize: 14,
                      color: meta.color,
                      background: "rgba(148,163,184,0.08)",
                      border: "1px solid var(--border-subtle)"
                    }}
                  >
                    {meta.label.charAt(0)}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                      <strong style={{ fontSize: 13.5, fontWeight: 600 }}>{meta.label}</strong>
                      {ch.configured ? (
                        <CheckCircle2 size={15} color="#34d399" aria-label="Conectado" />
                      ) : (
                        <Circle size={15} color="var(--text-muted)" aria-label="Não configurado" />
                      )}
                    </div>
                    <div className="noema-truncate" style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                      {ch.configured ? meta.desc : "Opcional — não configurado"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Responsável de fallback"
        subtitle="Quem recebe aprovações e alertas quando a integração estiver indisponível."
        icon={<UserCog size={15} />}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveFallback();
          }}
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, alignItems: "end" }}
        >
          <Field label="Integração">
            <select className="noema-input" value={fallbackProvider} onChange={(e) => setFallbackProvider(e.target.value)}>
              {(notificationChannels.length ? notificationChannels.map((c) => c.provider) : ["github"]).map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_META[p]?.label ?? p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Responsável">
            <input className="noema-input" value={fallbackOwner} onChange={(e) => setFallbackOwner(e.target.value)} placeholder="ex.: maria.silva" />
          </Field>
          <button type="submit" className="noema-btn noema-btn-primary" disabled={saving}>
            {saving && <Loader2 size={14} className="noema-spin" />} Salvar
          </button>
        </form>
      </SectionCard>
    </div>
  );
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("pt-BR", { notation: n >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function OperationsWorkspace(props: {
  projectId: string;
  finops?: {
    estimatedLocalTokens: number;
    modelUsage: { calls: number; byModel: Array<{ model: string; totalTokens: number | null; providerCostUsd: number | null }> };
    infrastructureEstimate: { totalInfraAndEnergyUsd: number };
  };
  auditLogs: Array<{ id?: string; timestamp?: string; createdAt?: string; actorId: string; action: string; targetType: string; targetId: string }>;
  apiFetch: ApiFetchFn;
  queryClient: QueryClient;
  notify: NotifyFn;
}) {
  const { projectId, finops, auditLogs, apiFetch, queryClient, notify } = props;
  const [quotaDept, setQuotaDept] = useState("engineering");
  const [quotaTokens, setQuotaTokens] = useState("500000");
  const [quotaUsd, setQuotaUsd] = useState("50");
  const [saving, setSaving] = useState(false);

  const saveQuota = () => {
    setSaving(true);
    void apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/finops/quotas`, {
      method: "PUT",
      body: JSON.stringify({ department: quotaDept, monthlyTokenLimit: Number(quotaTokens), monthlyUsdLimit: Number(quotaUsd) })
    })
      .then(() => {
        notify("Cota FinOps salva.");
        return queryClient.invalidateQueries({ queryKey: ["finops"] });
      })
      .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setSaving(false));
  };

  const actionTone = (a: string) =>
    /delete|reject|revoke|erase/i.test(a) ? "danger" : /create|approve|grant/i.test(a) ? "success" : /update|sync/i.test(a) ? "accent" : "neutral";

  return (
    <div className="noema-stack">
      <div className="noema-grid-stats">
        <StatCard label="Chamadas de modelo" value={formatNumber(finops?.modelUsage?.calls ?? 0)} icon={<Cpu size={16} />} hint="Últimos 30 dias" />
        <StatCard label="Tokens estimados" value={formatNumber(finops?.estimatedLocalTokens ?? 0)} icon={<Database size={16} />} hint="Corpus local indexado" />
        <StatCard
          label="Custo infra + energia"
          value={`$${(finops?.infrastructureEstimate?.totalInfraAndEnergyUsd ?? 0).toFixed(4)}`}
          tone="accent"
          icon={<Zap size={16} />}
          hint="Estimativa mensal"
        />
      </div>

      <div className="noema-grid-2">
        <SectionCard title="Consumo por modelo" subtitle="Tokens totais por provedor/modelo">
          <FinOpsBarChart models={finops?.modelUsage?.byModel ?? []} />
        </SectionCard>
        <SectionCard title="Cota mensal por departamento" subtitle="Bloqueia execuções ao atingir o limite" icon={<Wallet size={15} />}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveQuota();
            }}
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
          >
            <Field label="Departamento">
              <input className="noema-input" value={quotaDept} onChange={(e) => setQuotaDept(e.target.value)} placeholder="engineering" />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <Field label="Limite de tokens">
                <input className="noema-input" type="number" min={0} value={quotaTokens} onChange={(e) => setQuotaTokens(e.target.value)} />
              </Field>
              <Field label="Limite (USD)">
                <input className="noema-input" type="number" min={0} step="0.01" value={quotaUsd} onChange={(e) => setQuotaUsd(e.target.value)} />
              </Field>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="submit" className="noema-btn noema-btn-primary" disabled={saving}>
                {saving && <Loader2 size={14} className="noema-spin" />} Salvar cota
              </button>
            </div>
          </form>
        </SectionCard>
      </div>

      <SectionCard title="Trilha de auditoria" subtitle="Toda ação humana ou de agente é registrada" icon={<ScrollText size={15} />}>
        <DataTable
          data={auditLogs}
          emptyText="Nenhum evento de auditoria"
          columns={[
            {
              header: "Quando",
              accessorFn: (r) => r.createdAt ?? r.timestamp ?? "",
              cell: ({ getValue }) => (
                <span style={{ color: "var(--text-secondary)", fontSize: 12, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                  {formatDate(String(getValue() ?? ""))}
                </span>
              )
            },
            { header: "Ator", accessorKey: "actorId", cell: ({ row }) => <strong style={{ fontWeight: 550 }}>{row.original.actorId}</strong> },
            { header: "Ação", accessorKey: "action", cell: ({ row }) => <Badge tone={actionTone(row.original.action)}>{row.original.action}</Badge> },
            { header: "Alvo", accessorKey: "targetType", cell: ({ row }) => <span style={{ color: "var(--text-secondary)" }}>{row.original.targetType}</span> },
            {
              header: "ID",
              accessorKey: "targetId",
              cell: ({ row }) => (
                <span className="noema-mono" style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  {row.original.targetId}
                </span>
              )
            }
          ]}
          searchPlaceholder="Filtrar por ator, ação ou alvo..."
        />
      </SectionCard>
    </div>
  );
}
