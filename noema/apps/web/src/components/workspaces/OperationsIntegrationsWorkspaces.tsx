"use client";

import type { QueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDownRight,
  Bot,
  Calculator,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  Database,
  Download,
  Filter,
  Layers,
  Loader2,
  RefreshCw,
  ScrollText,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  User,
  Wallet,
  Zap
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ApiFetchFn, AuditLogEntry, FinOpsData, FinOpsDepartmentQuota, FinOpsModelUsage, NotifyFn } from "../../lib/types";
import { FinOpsBarChart, FinOpsCostCompositionChart, getProviderColor } from "../Charts";
import { DataTable } from "../DataTable";
import { Badge, EmptyState, Field, PageHeader, SectionCard, Segmented, SlideOverDrawer, StatCard } from "../UiPrimitives";

function formatNumber(n: number): string {
  return new Intl.NumberFormat("pt-BR", { notation: n >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

function formatCurrency(n: number, decimals = 4): string {
  return `$${n.toFixed(decimals)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const DOWNGRADE_MODELS = [
  { id: "ollama:qwen2.5-coder:7b", label: "Ollama Qwen 2.5 Coder 7B (Local / Custo Zero)", tag: "Local" },
  { id: "ollama:llama3.2", label: "Ollama Llama 3.2 3B (Local / Ultrarrápido)", tag: "Local" },
  { id: "deepseek-coder:6.7b", label: "DeepSeek Coder 6.7B (Local / Especializado)", tag: "Local" },
  { id: "gpt-4o-mini", label: "OpenAI GPT-4o Mini (Cloud / Baixo Custo)", tag: "Cloud" },
  { id: "claude-3-5-haiku", label: "Anthropic Claude 3.5 Haiku (Cloud / Rápido)", tag: "Cloud" }
];

const QUOTA_PRESETS = [
  { dept: "engineering", label: "Engenharia", tokens: "1000000", usd: "100", downgrade: "ollama:qwen2.5-coder:7b" },
  { dept: "product-ai", label: "Produto & IA", tokens: "500000", usd: "50", downgrade: "ollama:llama3.2" },
  { dept: "qa-testing", label: "QA & Automação", tokens: "250000", usd: "25", downgrade: "ollama:qwen2.5-coder:7b" },
  { dept: "sre-ops", label: "SRE & Operações", tokens: "750000", usd: "75", downgrade: "deepseek-coder:6.7b" },
  { dept: "research-lab", label: "Pesquisa & Lab", tokens: "2000000", usd: "200", downgrade: "gpt-4o-mini" }
];

export function OperationsWorkspace(props: {
  projectId: string;
  finops?: FinOpsData;
  auditLogs: AuditLogEntry[];
  apiFetch: ApiFetchFn;
  queryClient: QueryClient;
  notify: NotifyFn;
}) {
  const { projectId, finops, auditLogs, apiFetch, queryClient, notify } = props;

  // Navigation sub-views
  const [subView, setSubView] = useState<"overview" | "models" | "quotas" | "audit" | "simulator">("overview");

  // Selectors
  const [period, setPeriod] = useState<"7d" | "30d" | "90d" | "all">("30d");
  const [chartMetric, setChartMetric] = useState<"tokens" | "usd" | "calls" | "stacked_tokens">("tokens");
  const [providerFilter, setProviderFilter] = useState<string>("all");

  // Audit filters & inspection
  const [auditActorFilter, setAuditActorFilter] = useState<"all" | "agent" | "human" | "service">("all");
  const [auditActionFilter, setAuditActionFilter] = useState<"all" | "create" | "update" | "delete">("all");
  const [inspectedLog, setInspectedLog] = useState<AuditLogEntry | null>(null);
  const [copiedLogJson, setCopiedLogJson] = useState(false);

  // Quota form
  const [quotaDept, setQuotaDept] = useState("engineering");
  const [quotaTokens, setQuotaTokens] = useState("1000000");
  const [quotaUsd, setQuotaUsd] = useState("100");
  const [quotaDowngrade, setQuotaDowngrade] = useState("ollama:qwen2.5-coder:7b");
  const [savingQuota, setSavingQuota] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Simulator state
  const [simLocalMigrationPct, setSimLocalMigrationPct] = useState(40); // 40% local models
  const [simPromptCachePct, setSimPromptCachePct] = useState(30); // 30% prompt caching

  // Calculated metrics
  const models = useMemo(() => finops?.modelUsage?.byModel ?? [], [finops?.modelUsage?.byModel]);

  // Provider distribution
  const providers = useMemo(() => {
    const set = new Set<string>();
    models.forEach((m) => {
      const p = m.provider || (m.model.startsWith("ollama:") ? "ollama" : m.model.startsWith("claude") ? "anthropic" : m.model.startsWith("gpt") ? "openai" : "other");
      set.add(p.toLowerCase());
    });
    return Array.from(set);
  }, [models]);

  const filteredModels = useMemo(() => {
    if (providerFilter === "all") return models;
    return models.filter((m) => {
      const p = (m.provider || (m.model.startsWith("ollama:") ? "ollama" : m.model.startsWith("claude") ? "anthropic" : m.model.startsWith("gpt") ? "openai" : "other")).toLowerCase();
      return p.includes(providerFilter);
    });
  }, [models, providerFilter]);

  // Total costs
  const providerCost = finops?.modelUsage?.providerCostUsd ?? 0;
  const computeCost = finops?.infrastructureEstimate?.computeCostUsd ?? 0;
  const energyCost = finops?.infrastructureEstimate?.energyCostUsd ?? 0;
  const totalCost = Number((providerCost + (finops?.infrastructureEstimate?.totalInfraAndEnergyUsd ?? 0)).toFixed(4));

  const totalMeasuredTokens = useMemo(
    () => models.reduce((acc, m) => acc + (m.totalTokens ?? 0), 0),
    [models]
  );
  const effectiveTokens = totalMeasuredTokens > 0 ? totalMeasuredTokens : (finops?.estimatedLocalTokens ?? 0);
  const callsCount = finops?.modelUsage?.calls ?? 0;
  const avgCostPerCall = callsCount > 0 ? totalCost / callsCount : 0;
  const avgCostPer1kTokens = effectiveTokens > 0 ? (totalCost / effectiveTokens) * 1000 : 0;

  // Quotas calculations
  const departmentQuotas = finops?.departmentQuotas ?? [];
  const quotasInAlert = departmentQuotas.filter((q) => !q.withinQuota || (q.usedUsd && q.usedUsd / q.monthlyUsdLimit >= 0.8));

  // Audit logs filtering
  const filteredAuditLogs = useMemo(() => {
    return auditLogs.filter((log) => {
      if (auditActorFilter === "agent") {
        const isAgent = log.actorType === "agent" || log.actorId.toLowerCase().includes("agent") || log.actorId.toLowerCase().includes("runner");
        if (!isAgent) return false;
      } else if (auditActorFilter === "human") {
        const isHuman = log.actorType === "human" || (!log.actorId.toLowerCase().includes("agent") && !log.actorId.toLowerCase().includes("runner") && !log.actorId.toLowerCase().includes("service"));
        if (!isHuman) return false;
      } else if (auditActorFilter === "service") {
        if (log.actorType !== "service" && !log.actorId.toLowerCase().includes("service")) return false;
      }

      if (auditActionFilter === "create") {
        if (!/create|grant|approve/i.test(log.action)) return false;
      } else if (auditActionFilter === "update") {
        if (!/update|sync|edit|modify/i.test(log.action)) return false;
      } else if (auditActionFilter === "delete") {
        if (!/delete|revoke|reject|erase/i.test(log.action)) return false;
      }
      return true;
    });
  }, [auditLogs, auditActorFilter, auditActionFilter]);

  // Refresh handler
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["finops"] }),
        queryClient.invalidateQueries({ queryKey: ["audit"] })
      ]);
      notify("Métricas FinOps e auditoria atualizadas.");
    } catch {
      notify("Falha ao atualizar dados.", "error");
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  };

  // Save quota handler
  const saveQuota = () => {
    setSavingQuota(true);
    void apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/finops/quotas`, {
      method: "PUT",
      body: JSON.stringify({
        department: quotaDept,
        monthlyTokenLimit: Number(quotaTokens),
        monthlyUsdLimit: Number(quotaUsd),
        downgradeModel: quotaDowngrade
      })
    })
      .then(() => {
        notify(`Cota para ${quotaDept} configurada com sucesso.`);
        return queryClient.invalidateQueries({ queryKey: ["finops"] });
      })
      .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setSavingQuota(false));
  };

  // Export report
  const handleExportFinOps = () => {
    const report = {
      project: projectId,
      generatedAt: new Date().toISOString(),
      period,
      financialSummary: {
        totalCostUsd: totalCost,
        providerInferenceUsd: providerCost,
        computeInfrastructureUsd: computeCost,
        datacenterEnergyUsd: energyCost,
        energyKwh: finops?.infrastructureEstimate?.energyKwh ?? 0,
        avgCostPer1kTokens,
        avgCostPerCall
      },
      tokens: {
        totalTokens: effectiveTokens,
        corpusLocalTokens: finops?.estimatedLocalTokens ?? 0,
        modelUsageCalls: callsCount
      },
      modelsUsage: models,
      departmentQuotas
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `finops-report-${projectId}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify("Relatório FinOps exportado com sucesso.");
  };

  // Export Audit logs
  const handleExportAudit = () => {
    const blob = new Blob([JSON.stringify(filteredAuditLogs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-logs-${projectId}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify(`${filteredAuditLogs.length} eventos de auditoria exportados.`);
  };

  const copyLogJson = () => {
    if (!inspectedLog) return;
    navigator.clipboard.writeText(JSON.stringify(inspectedLog, null, 2));
    setCopiedLogJson(true);
    setTimeout(() => setCopiedLogJson(false), 2000);
    notify("Metadados copiados para a área de transferência.");
  };

  const actionTone = (a: string) =>
    /delete|reject|revoke|erase/i.test(a) ? "danger" : /create|approve|grant/i.test(a) ? "success" : /update|sync/i.test(a) ? "accent" : "neutral";

  // Simulation calculations
  const simSavingsUsd = useMemo(() => {
    const base = providerCost > 0 ? providerCost : 12.5;
    const localSavings = base * (simLocalMigrationPct / 100) * 0.92; // 92% savings by moving to local Ollama
    const cacheSavings = (base - localSavings) * (simPromptCachePct / 100) * 0.65; // 65% prompt cache savings
    return Number((localSavings + cacheSavings).toFixed(2));
  }, [providerCost, simLocalMigrationPct, simPromptCachePct]);

  const simAnnualSavings = (simSavingsUsd * 12).toFixed(2);
  const simCarbonReductionKg = ((effectiveTokens / 1_000_000) * (simLocalMigrationPct / 100) * 0.28).toFixed(2);

  return (
    <div className="noema-stack">
      {/* 1. Header Bar & Interactive Cockpit Controls */}
      <div className="noema-finops-header">
        <div>
          <PageHeader
            title="Operação & FinOps"
            description="Cockpit financeiro de IA, rastreamento de tokens por modelo, governança de cotas com downgrade autônomo e auditoria completa."
            icon={<Activity size={20} />}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
            <span className="noema-dot live" style={{ background: finops?.actualProviderUsageAvailable ? "#10b981" : "#f59e0b" }} />
            <span style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 500 }}>
              {finops?.actualProviderUsageAvailable ? "Telemetria de Provedor Ativa (PostgreSQL)" : "Estimativa Baseada em Telemetria de Corpus"}
            </span>
            {finops?.pgOperationalActive && (
              <Badge tone="success" dot>
                RLS Operacional
              </Badge>
            )}
            {finops?.pgTemporalActive && (
              <Badge tone="accent" dot>
                Temporal Workflows
              </Badge>
            )}
            {quotasInAlert.length > 0 && (
              <Badge tone="danger" dot>
                {quotasInAlert.length} {quotasInAlert.length === 1 ? "cota em alerta" : "cotas em alerta"}
              </Badge>
            )}
          </div>
        </div>

        <div className="noema-finops-controls">
          {/* Period selector */}
          <div style={{ display: "flex", background: "rgba(148, 163, 184, 0.08)", padding: 2, borderRadius: 999, border: "1px solid var(--border-subtle)" }}>
            {(["7d", "30d", "90d", "all"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`noema-finops-filter-pill ${period === p ? "active" : ""}`}
                style={{ padding: "3px 10px", border: "none" }}
                onClick={() => setPeriod(p)}
              >
                {p === "7d" ? "7D" : p === "30d" ? "30D (Mês)" : p === "90d" ? "90D" : "Total"}
              </button>
            ))}
          </div>

          {/* Quick Refresh */}
          <button
            type="button"
            className="noema-btn noema-btn-sm noema-btn-ghost"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Atualizar métricas agora"
          >
            <RefreshCw size={13} className={refreshing ? "noema-spin" : ""} />
            Atualizar
          </button>

          {/* Export Report */}
          <button
            type="button"
            className="noema-btn noema-btn-sm noema-btn-primary"
            onClick={handleExportFinOps}
            title="Exportar dados consolidados em JSON"
          >
            <Download size={13} />
            Exportar FinOps
          </button>
        </div>
      </div>

      {/* 2. Sub-views Tab Navigation */}
      <Segmented
        value={subView}
        onChange={(v) => setSubView(v as typeof subView)}
        options={[
          { id: "overview", label: "Visão Geral FinOps", icon: <Activity size={14} /> },
          { id: "models", label: "Modelos & Provedores", icon: <Cpu size={14} />, count: models.length },
          { id: "quotas", label: "Governança & Cotas", icon: <Wallet size={14} />, count: departmentQuotas.length },
          { id: "audit", label: "Trilha de Auditoria", icon: <ScrollText size={14} />, count: auditLogs.length },
          { id: "simulator", label: "Simulador de Otimização", icon: <Calculator size={14} /> }
        ]}
      />

      {/* TAB 1: VISÃO GERAL */}
      {subView === "overview" && (
        <>
          {/* StatCards Row */}
          <div className="noema-grid-stats">
            <StatCard
              label="Custo Operacional Total"
              value={formatCurrency(totalCost)}
              tone="accent"
              icon={<Zap size={16} />}
              hint={`$${avgCostPer1kTokens.toFixed(4)} por 1k tokens · ${period === "30d" ? "Últimos 30 dias" : period}`}
            />
            <StatCard
              label="Volume de Tokens"
              value={formatNumber(effectiveTokens)}
              tone="default"
              icon={<Database size={16} />}
              hint={`${totalMeasuredTokens > 0 ? "Tokens medidos em execuções" : "Corpus local indexado"}`}
            />
            <StatCard
              label="Chamadas de Modelo"
              value={formatNumber(callsCount)}
              tone="default"
              icon={<Cpu size={16} />}
              hint={callsCount > 0 ? `Média de $${avgCostPerCall.toFixed(4)}/chamada` : "Aguardando execuções"}
            />
            <StatCard
              label="Energia & Pegada ESG"
              value={`${(finops?.infrastructureEstimate?.energyKwh ?? 0).toFixed(3)} kWh`}
              tone="success"
              icon={<Sparkles size={16} />}
              hint={`Custo de energia: $${(finops?.infrastructureEstimate?.energyCostUsd ?? 0).toFixed(4)}`}
            />
            <StatCard
              label="Governança de Cotas"
              value={
                departmentQuotas.length > 0
                  ? `${departmentQuotas.length - quotasInAlert.length}/${departmentQuotas.length}`
                  : "0 cotas"
              }
              tone={quotasInAlert.length > 0 ? "danger" : "success"}
              icon={<Wallet size={16} />}
              hint={
                quotasInAlert.length > 0
                  ? `${quotasInAlert.length} área(s) em alerta ou downgrade`
                  : "Todas as áreas em conformidade"
              }
              onClick={() => setSubView("quotas")}
            />
          </div>

          {/* Gráficos Principais */}
          <div className="noema-grid-2">
            {/* Gráfico 1: Consumo por modelo com seletores */}
            <SectionCard
              title="Consumo por Modelo & Provedor"
              subtitle="Distribuição de volume, custo e requisições de IA"
              icon={<Cpu size={15} />}
              actions={
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  {/* Metric Switcher */}
                  <div style={{ display: "flex", background: "rgba(148, 163, 184, 0.08)", padding: 2, borderRadius: 6, border: "1px solid var(--border-subtle)" }}>
                    <button
                      type="button"
                      className={`noema-btn noema-btn-sm ${chartMetric === "tokens" ? "noema-btn-primary" : "noema-btn-ghost"}`}
                      style={{ padding: "2px 8px", fontSize: 11 }}
                      onClick={() => setChartMetric("tokens")}
                    >
                      Tokens
                    </button>
                    <button
                      type="button"
                      className={`noema-btn noema-btn-sm ${chartMetric === "usd" ? "noema-btn-primary" : "noema-btn-ghost"}`}
                      style={{ padding: "2px 8px", fontSize: 11 }}
                      onClick={() => setChartMetric("usd")}
                    >
                      USD ($)
                    </button>
                    <button
                      type="button"
                      className={`noema-btn noema-btn-sm ${chartMetric === "calls" ? "noema-btn-primary" : "noema-btn-ghost"}`}
                      style={{ padding: "2px 8px", fontSize: 11 }}
                      onClick={() => setChartMetric("calls")}
                    >
                      Chamadas
                    </button>
                    <button
                      type="button"
                      className={`noema-btn noema-btn-sm ${chartMetric === "stacked_tokens" ? "noema-btn-primary" : "noema-btn-ghost"}`}
                      style={{ padding: "2px 8px", fontSize: 11 }}
                      onClick={() => setChartMetric("stacked_tokens")}
                      title="Comparação Prompt vs Completion"
                    >
                      Prompt vs Saída
                    </button>
                  </div>
                </div>
              }
            >
              {/* Provider Quick Filter Chips */}
              <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)", marginRight: 2 }}>Provedor:</span>
                <span
                  className={`noema-finops-filter-pill ${providerFilter === "all" ? "active" : ""}`}
                  onClick={() => setProviderFilter("all")}
                >
                  Todos ({models.length})
                </span>
                {providers.map((p) => (
                  <span
                    key={p}
                    className={`noema-finops-filter-pill ${providerFilter === p ? "active" : ""}`}
                    onClick={() => setProviderFilter(p)}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: getProviderColor(p),
                        display: "inline-block"
                      }}
                    />
                    {p.toUpperCase()}
                  </span>
                ))}
              </div>

              <FinOpsBarChart models={filteredModels} metric={chartMetric} />

              {/* Legend bar */}
              <div style={{ display: "flex", gap: 14, justifyContent: "center", marginTop: 8, fontSize: 11, color: "var(--text-secondary)", flexWrap: "wrap" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: "#10b981" }} /> OpenAI
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: "#a855f7" }} /> Anthropic
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: "#38bdf8" }} /> Ollama / Local
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: "#f59e0b" }} /> Google
                </span>
              </div>
            </SectionCard>

            {/* Gráfico 2: Composição Tridimensional de Custos */}
            <SectionCard
              title="Decomposição de Custos"
              subtitle="Distribuição entre Inferência LLM, Servidores e Energia"
              icon={<Zap size={15} />}
            >
              <FinOpsCostCompositionChart
                providerCostUsd={providerCost}
                computeCostUsd={computeCost}
                energyCostUsd={energyCost}
              />

              {/* Breakdown cards */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 14 }}>
                <div style={{ background: "rgba(99, 102, 241, 0.08)", border: "1px solid rgba(99, 102, 241, 0.2)", borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Provedores LLM</div>
                  <div style={{ fontSize: 14, fontWeight: 650, color: "#a5b4fc" }}>${providerCost.toFixed(4)}</div>
                  <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                    {totalCost > 0 ? `${((providerCost / totalCost) * 100).toFixed(0)}% do total` : "0%"}
                  </div>
                </div>

                <div style={{ background: "rgba(56, 189, 248, 0.08)", border: "1px solid rgba(56, 189, 248, 0.2)", borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Infra Compute</div>
                  <div style={{ fontSize: 14, fontWeight: 650, color: "#7dd3fc" }}>${computeCost.toFixed(4)}</div>
                  <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                    {totalCost > 0 ? `${((computeCost / totalCost) * 100).toFixed(0)}% do total` : "0%"}
                  </div>
                </div>

                <div style={{ background: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.2)", borderRadius: 8, padding: "8px 10px" }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Energia ESG</div>
                  <div style={{ fontSize: 14, fontWeight: 650, color: "#6ee7b7" }}>${energyCost.toFixed(4)}</div>
                  <div style={{ fontSize: 10, color: "var(--text-secondary)" }}>
                    {totalCost > 0 ? `${((energyCost / totalCost) * 100).toFixed(0)}% do total` : "0%"}
                  </div>
                </div>
              </div>
            </SectionCard>
          </div>

          {/* Recomendações e Inteligência FinOps */}
          <SectionCard
            title="Insights & Recomendações FinOps"
            subtitle="Diagnóstico automático baseado nos padrões de execução e telemetria"
            icon={<Sparkles size={15} />}
          >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
              <div style={{ background: "rgba(148, 163, 184, 0.05)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <Sparkles size={16} color="#818cf8" />
                  <strong style={{ fontSize: 13 }}>Roteamento Autônomo para Modelos Locais</strong>
                </div>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
                  Utilizar modelos locais como <code>ollama:qwen2.5-coder:7b</code> para tarefas repetitivas de indexação e testes pode reduzir até <strong>85% dos custos de API</strong> com custo marginal zero de inferência.
                </p>
              </div>

              <div style={{ background: "rgba(148, 163, 184, 0.05)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <ShieldCheck size={16} color="#34d399" />
                  <strong style={{ fontSize: 13 }}>Proteção por Cota com Downgrade Suave</strong>
                </div>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
                  Configure limites por departamento. Quando um time consome mais de 100% de sua cota em USD ou tokens, o Noema faz downgrade transparente para um modelo local sem interromper tarefas críticas.
                </p>
              </div>

              <div style={{ background: "rgba(148, 163, 184, 0.05)", border: "1px solid var(--border-subtle)", borderRadius: 10, padding: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <Calculator size={16} color="#fbbf24" />
                  <strong style={{ fontSize: 13 }}>Simulação de Economia & ROI</strong>
                </div>
                <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
                  Acesse a aba <strong>Simulador</strong> para projetar o impacto financeiro de migrar 20%, 50% ou 80% do tráfego para servidores locais com GPUs compartilhadas.
                </p>
              </div>
            </div>
          </SectionCard>
        </>
      )}

      {/* TAB 2: MODELOS & PROVEDORES */}
      {subView === "models" && (
        <div className="noema-stack">
          {/* Resumo por Provedor */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {providers.map((p) => {
              const pModels = models.filter((m) => {
                const name = (m.provider || m.model).toLowerCase();
                return name.includes(p);
              });
              const pTokens = pModels.reduce((acc, m) => acc + (m.totalTokens ?? 0), 0);
              const pCost = pModels.reduce((acc, m) => acc + (m.providerCostUsd ?? 0), 0);
              const pCalls = pModels.reduce((acc, m) => acc + (m.calls ?? 1), 0);

              return (
                <div key={p} className="noema-card" style={{ padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: getProviderColor(p) }} />
                      <strong style={{ fontSize: 13, textTransform: "capitalize" }}>{p}</strong>
                    </div>
                    <Badge tone="neutral">{pModels.length} {pModels.length === 1 ? "modelo" : "modelos"}</Badge>
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "var(--text-primary)" }}>${pCost.toFixed(4)}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>
                    {formatNumber(pTokens)} tokens · {pCalls} chamadas
                  </div>
                </div>
              );
            })}
          </div>

          {/* Tabela Detalhada de Modelos */}
          <SectionCard
            title="Detalhamento por Modelo"
            subtitle="Métricas granulares de tokens de entrada (prompt), saída (completion) e custo efetivo"
            icon={<Cpu size={15} />}
          >
            <DataTable
              data={models}
              emptyText="Nenhum modelo de IA com telemetria registrada neste projeto"
              searchPlaceholder="Filtrar por nome do modelo ou provedor..."
              columns={[
                {
                  header: "Modelo",
                  accessorKey: "model",
                  cell: ({ row }) => {
                    const m = row.original;
                    const color = getProviderColor(m.provider || m.model);
                    return (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
                        <span className="noema-mono" style={{ fontWeight: 600, fontSize: 12 }}>
                          {m.model}
                        </span>
                      </div>
                    );
                  }
                },
                {
                  header: "Provedor",
                  accessorFn: (r) => r.provider ?? (r.model.startsWith("ollama:") ? "Ollama" : r.model.startsWith("claude") ? "Anthropic" : r.model.startsWith("gpt") ? "OpenAI" : "Outro"),
                  cell: ({ getValue }) => <Badge tone="neutral">{String(getValue())}</Badge>
                },
                {
                  header: "Chamadas",
                  accessorKey: "calls",
                  cell: ({ row }) => (
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {(row.original.calls ?? 1).toLocaleString("pt-BR")}
                    </span>
                  )
                },
                {
                  header: "Prompt (Entrada)",
                  accessorFn: (r) => r.promptTokens ?? r.inputTokens ?? 0,
                  cell: ({ getValue }) => (
                    <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                      {formatNumber(Number(getValue()))}
                    </span>
                  )
                },
                {
                  header: "Saída (Completion)",
                  accessorFn: (r) => r.completionTokens ?? r.outputTokens ?? 0,
                  cell: ({ getValue }) => (
                    <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                      {formatNumber(Number(getValue()))}
                    </span>
                  )
                },
                {
                  header: "Total Tokens",
                  accessorFn: (r) => r.totalTokens ?? 0,
                  cell: ({ getValue }) => (
                    <strong style={{ fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>
                      {formatNumber(Number(getValue()))}
                    </strong>
                  )
                },
                {
                  header: "Custo ($ USD)",
                  accessorKey: "providerCostUsd",
                  cell: ({ row }) => {
                    const cost = row.original.providerCostUsd;
                    return (
                      <span className="noema-mono" style={{ color: cost && cost > 0 ? "#818cf8" : "var(--text-muted)", fontWeight: 600 }}>
                        {cost !== null && cost !== undefined ? `$${cost.toFixed(4)}` : "—"}
                      </span>
                    );
                  }
                },
                {
                  header: "Ação Rápida",
                  id: "actions",
                  cell: ({ row }) => (
                    <button
                      type="button"
                      className="noema-btn noema-btn-sm noema-btn-ghost"
                      style={{ fontSize: 11, padding: "2px 8px" }}
                      onClick={() => {
                        setQuotaDowngrade(row.original.model);
                        setSubView("quotas");
                        notify(`Modelo ${row.original.model} selecionado como fallback.`);
                      }}
                    >
                      Definir como Fallback
                    </button>
                  )
                }
              ]}
            />
          </SectionCard>
        </div>
      )}

      {/* TAB 3: GOVERNANÇA DE COTAS & DOWNGRADE */}
      {subView === "quotas" && (
        <div className="noema-stack">
          {/* Header explicativo */}
          <div style={{ background: "linear-gradient(90deg, rgba(99, 102, 241, 0.08), rgba(56, 189, 248, 0.04))", border: "1px solid var(--border-subtle)", borderRadius: 12, padding: 16 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <ShieldAlert size={20} color="#818cf8" style={{ marginTop: 2, flexShrink: 0 }} />
              <div>
                <h4 style={{ fontSize: 14, fontWeight: 650, marginBottom: 4 }}>Política de Downgrade Autônomo e Bloqueio de Orçamento</h4>
                <p style={{ fontSize: 12.5, color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
                  As cotas por departamento limitam o consumo mensal em tokens e dólares. Ao atingir o teto estipulado, o agente não falha: o sistema de governança do Noema rebaixa autonomamente a inferência para o <strong>Modelo de Downgrade</strong> selecionado (como <code>ollama:qwen2.5-coder:7b</code>), mantendo a operação rodando a custo zero.
                </p>
              </div>
            </div>
          </div>

          {/* Cards de Cotas Existentes */}
          <SectionCard
            title="Cotas Configuradas por Departamento"
            subtitle="Acompanhamento em tempo real do orçamento consumido e estado de downgrade"
            icon={<Wallet size={15} />}
          >
            {departmentQuotas.length === 0 ? (
              <EmptyState
                icon={<Wallet size={28} />}
                title="Nenhuma cota configurada ainda"
                description="Use o formulário abaixo para definir limites de tokens e custos para seus departamentos."
              />
            ) : (
              <div className="noema-quota-grid">
                {departmentQuotas.map((q) => {
                  const usedTokens = q.usedTokens ?? 0;
                  const usedUsd = q.usedUsd ?? 0;
                  const tokenPct = q.monthlyTokenLimit > 0 ? Math.min(100, (usedTokens / q.monthlyTokenLimit) * 100) : 0;
                  const usdPct = q.monthlyUsdLimit > 0 ? Math.min(100, (usedUsd / q.monthlyUsdLimit) * 100) : 0;
                  const isOver = !q.withinQuota || tokenPct >= 100 || usdPct >= 100;
                  const isWarning = !isOver && (tokenPct >= 80 || usdPct >= 80);

                  const cardClass = isOver ? "danger" : isWarning ? "warning" : "success";

                  return (
                    <div key={q.department} className={`noema-quota-card ${cardClass}`}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontWeight: 650, fontSize: 14, textTransform: "capitalize" }}>
                            {q.department}
                          </span>
                        </div>
                        <Badge tone={isOver ? "danger" : isWarning ? "warning" : "success"} dot>
                          {isOver ? "Downgrade Ativo" : isWarning ? "Atenção (>80%)" : "Em Conformidade"}
                        </Badge>
                      </div>

                      {/* Token Progress */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
                          <span style={{ color: "var(--text-muted)" }}>Tokens Utilizados</span>
                          <span style={{ fontWeight: 600 }}>
                            {formatNumber(usedTokens)} / {formatNumber(q.monthlyTokenLimit)} ({tokenPct.toFixed(0)}%)
                          </span>
                        </div>
                        <div className="noema-progress">
                          <span
                            style={{
                              width: `${tokenPct}%`,
                              background: isOver ? "var(--accent-danger)" : isWarning ? "var(--accent-warning)" : "var(--accent-success)"
                            }}
                          />
                        </div>
                      </div>

                      {/* USD Progress */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
                          <span style={{ color: "var(--text-muted)" }}>Orçamento USD</span>
                          <span style={{ fontWeight: 600 }}>
                            ${usedUsd.toFixed(2)} / ${q.monthlyUsdLimit.toFixed(2)} ({usdPct.toFixed(0)}%)
                          </span>
                        </div>
                        <div className="noema-progress">
                          <span
                            style={{
                              width: `${usdPct}%`,
                              background: isOver ? "var(--accent-danger)" : isWarning ? "var(--accent-warning)" : "var(--accent-primary)"
                            }}
                          />
                        </div>
                      </div>

                      {/* Downgrade model badge */}
                      <div style={{ fontSize: 11, color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4, paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
                        <span>Fallback Autônomo:</span>
                        <code className="noema-mono" style={{ fontSize: 10.5, color: "#cbd5e1" }}>
                          {q.downgradeModel ?? q.recommendedDowngradeModel ?? "ollama:qwen2.5-coder:7b"}
                        </code>
                      </div>

                      {/* Quick Edit */}
                      <button
                        type="button"
                        className="noema-btn noema-btn-sm noema-btn-ghost"
                        style={{ width: "100%", justifyContent: "center", fontSize: 11.5, marginTop: 4 }}
                        onClick={() => {
                          setQuotaDept(q.department);
                          setQuotaTokens(String(q.monthlyTokenLimit));
                          setQuotaUsd(String(q.monthlyUsdLimit));
                          if (q.downgradeModel) setQuotaDowngrade(q.downgradeModel);
                          notify(`Cota de ${q.department} carregada no formulário de edição.`);
                        }}
                      >
                        Editar Parâmetros
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>

          {/* Formulário de Configuração / Edição de Cota */}
          <SectionCard
            title="Configurar Cota Departamental"
            subtitle="Defina o teto mensal de consumo e o modelo de contingência automática"
            icon={<Wallet size={15} />}
          >
            {/* Quick Presets */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Presets Rápidos de Orçamento:</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {QUOTA_PRESETS.map((p) => (
                  <button
                    key={p.dept}
                    type="button"
                    className="noema-finops-filter-pill"
                    onClick={() => {
                      setQuotaDept(p.dept);
                      setQuotaTokens(p.tokens);
                      setQuotaUsd(p.usd);
                      setQuotaDowngrade(p.downgrade);
                    }}
                  >
                    {p.label} (${p.usd} / {formatNumber(Number(p.tokens))} tokens)
                  </button>
                ))}
              </div>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveQuota();
              }}
              style={{ display: "flex", flexDirection: "column", gap: 14 }}
            >
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
                <Field label="Identificador do Departamento">
                  <input
                    className="noema-input"
                    value={quotaDept}
                    onChange={(e) => setQuotaDept(e.target.value)}
                    placeholder="ex: engineering, marketing, data"
                    required
                  />
                </Field>

                <Field label="Limite Mensal de Tokens">
                  <input
                    className="noema-input"
                    type="number"
                    min={0}
                    step={10000}
                    value={quotaTokens}
                    onChange={(e) => setQuotaTokens(e.target.value)}
                    required
                  />
                </Field>

                <Field label="Limite Mensal (USD $)">
                  <input
                    className="noema-input"
                    type="number"
                    min={0}
                    step="0.01"
                    value={quotaUsd}
                    onChange={(e) => setQuotaUsd(e.target.value)}
                    required
                  />
                </Field>

                <Field label="Modelo de Downgrade Autônomo">
                  <select
                    className="noema-input"
                    value={quotaDowngrade}
                    onChange={(e) => setQuotaDowngrade(e.target.value)}
                  >
                    {DOWNGRADE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              {/* Preview de impacto */}
              <div style={{ background: "rgba(148, 163, 184, 0.05)", border: "1px solid var(--border-subtle)", borderRadius: 8, padding: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                  Resumo da regra: Departamento <strong>{quotaDept}</strong> terá teto de <strong>{formatNumber(Number(quotaTokens || 0))} tokens</strong> e <strong>${Number(quotaUsd || 0).toFixed(2)} USD</strong>. Se exceder, migra para <code>{quotaDowngrade}</code>.
                </div>
                <button type="submit" className="noema-btn noema-btn-primary" disabled={savingQuota}>
                  {savingQuota && <Loader2 size={14} className="noema-spin" />} Salvar Cota FinOps
                </button>
              </div>
            </form>
          </SectionCard>
        </div>
      )}

      {/* TAB 4: TRILHA DE AUDITORIA & COMPLIANCE */}
      {subView === "audit" && (
        <div className="noema-stack">
          {/* Controles de Auditoria */}
          <SectionCard
            title="Trilha de Auditoria & Compliance"
            subtitle="Registro imutável de todas as ações executadas por humanos e agentes autônomos"
            icon={<ScrollText size={15} />}
            actions={
              <button
                type="button"
                className="noema-btn noema-btn-sm noema-btn-ghost"
                onClick={handleExportAudit}
              >
                <Download size={13} /> Exportar Logs ({filteredAuditLogs.length})
              </button>
            }
          >
            {/* Filter pills */}
            <div style={{ display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
              {/* Actor Filter */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Ator:</span>
                <span
                  className={`noema-finops-filter-pill ${auditActorFilter === "all" ? "active" : ""}`}
                  onClick={() => setAuditActorFilter("all")}
                >
                  Todos
                </span>
                <span
                  className={`noema-finops-filter-pill ${auditActorFilter === "agent" ? "active" : ""}`}
                  onClick={() => setAuditActorFilter("agent")}
                >
                  <Bot size={12} /> Agentes IA
                </span>
                <span
                  className={`noema-finops-filter-pill ${auditActorFilter === "human" ? "active" : ""}`}
                  onClick={() => setAuditActorFilter("human")}
                >
                  <User size={12} /> Humanos
                </span>
              </div>

              {/* Action Filter */}
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Ação:</span>
                <span
                  className={`noema-finops-filter-pill ${auditActionFilter === "all" ? "active" : ""}`}
                  onClick={() => setAuditActionFilter("all")}
                >
                  Todas
                </span>
                <span
                  className={`noema-finops-filter-pill ${auditActionFilter === "create" ? "active" : ""}`}
                  onClick={() => setAuditActionFilter("create")}
                >
                  Criações
                </span>
                <span
                  className={`noema-finops-filter-pill ${auditActionFilter === "update" ? "active" : ""}`}
                  onClick={() => setAuditActionFilter("update")}
                >
                  Atualizações
                </span>
                <span
                  className={`noema-finops-filter-pill ${auditActionFilter === "delete" ? "active" : ""}`}
                  onClick={() => setAuditActionFilter("delete")}
                >
                  Exclusões
                </span>
              </div>
            </div>

            <DataTable
              data={filteredAuditLogs}
              emptyText="Nenhum evento de auditoria encontrado com os filtros selecionados"
              searchPlaceholder="Buscar por ator, ação, alvo ou ID..."
              columns={[
                {
                  header: "Timestamp",
                  accessorFn: (r) => r.createdAt ?? r.timestamp ?? "",
                  cell: ({ getValue }) => (
                    <span style={{ color: "var(--text-secondary)", fontSize: 12, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                      {formatDate(String(getValue() ?? ""))}
                    </span>
                  )
                },
                {
                  header: "Ator",
                  accessorKey: "actorId",
                  cell: ({ row }) => {
                    const isAgent = row.original.actorType === "agent" || row.original.actorId.toLowerCase().includes("agent") || row.original.actorId.toLowerCase().includes("runner");
                    return (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {isAgent ? <Bot size={13} color="#a855f7" /> : <User size={13} color="#38bdf8" />}
                        <strong style={{ fontWeight: 550, fontSize: 12 }}>{row.original.actorId}</strong>
                        {row.original.actorType && (
                          <Badge tone="neutral" dot={false}>
                            {row.original.actorType}
                          </Badge>
                        )}
                      </div>
                    );
                  }
                },
                {
                  header: "Ação",
                  accessorKey: "action",
                  cell: ({ row }) => <Badge tone={actionTone(row.original.action)}>{row.original.action}</Badge>
                },
                {
                  header: "Tipo do Alvo",
                  accessorKey: "targetType",
                  cell: ({ row }) => (
                    <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{row.original.targetType}</span>
                  )
                },
                {
                  header: "ID do Alvo",
                  accessorKey: "targetId",
                  cell: ({ row }) => (
                    <span className="noema-mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {row.original.targetId.length > 24 ? `${row.original.targetId.slice(0, 22)}…` : row.original.targetId}
                    </span>
                  )
                },
                {
                  header: "Detalhes",
                  id: "inspect",
                  cell: ({ row }) => (
                    <button
                      type="button"
                      className="noema-btn noema-btn-sm noema-btn-ghost"
                      style={{ fontSize: 11, padding: "2px 8px" }}
                      onClick={() => setInspectedLog(row.original)}
                    >
                      Inspecionar
                    </button>
                  )
                }
              ]}
            />
          </SectionCard>
        </div>
      )}

      {/* TAB 5: SIMULADOR DE OTIMIZAÇÃO & ROI */}
      {subView === "simulator" && (
        <div className="noema-stack">
          <SectionCard
            title="Simulador de Otimização & ROI FinOps"
            subtitle="Calcule a redução de custo ao migrar workloads para inferência local e habilitar prompt caching"
            icon={<Calculator size={15} />}
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              {/* Sliders de Simulação */}
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <label style={{ fontSize: 13, fontWeight: 600 }}>Roteamento para Modelos Locais (Ollama / vLLM)</label>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#818cf8" }}>{simLocalMigrationPct}%</span>
                  </div>
                  <input
                    type="range"
                    className="noema-range-slider"
                    min={0}
                    max={100}
                    value={simLocalMigrationPct}
                    onChange={(e) => setSimLocalMigrationPct(Number(e.target.value))}
                  />
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                    Direciona tarefas de classificação, testes de regressão e indexação para GPUs locais com custo $0 de API.
                  </div>
                </div>

                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <label style={{ fontSize: 13, fontWeight: 600 }}>Adoção de Prompt Caching (Context Re-use)</label>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#38bdf8" }}>{simPromptCachePct}%</span>
                  </div>
                  <input
                    type="range"
                    className="noema-range-slider"
                    min={0}
                    max={80}
                    value={simPromptCachePct}
                    onChange={(e) => setSimPromptCachePct(Number(e.target.value))}
                  />
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                    Reutiliza KV-cache em chamadas sucessivas de agentes, reduzindo em até 65% o custo de tokens de prompt repetidos.
                  </div>
                </div>

                <div style={{ background: "rgba(99, 102, 241, 0.06)", border: "1px solid rgba(99, 102, 241, 0.18)", borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#a5b4fc", marginBottom: 4 }}>Estratégia Recomendada para o Projeto</div>
                  <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
                    Ao configurar o modelo de downgrade <code>ollama:qwen2.5-coder:7b</code> em combinação com prompt caching de regras arquiteturais, a economia anual estimada atinge <strong>${simAnnualSavings} USD</strong> sem perda de precisão técnica.
                  </p>
                </div>
              </div>

              {/* Painel de Resultados do Simulador */}
              <div style={{ background: "rgba(13, 16, 23, 0.9)", border: "1px solid var(--border-subtle)", borderRadius: 12, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
                <h4 style={{ fontSize: 13, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Projeção de Economia & Eficiência
                </h4>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div style={{ background: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.2)", borderRadius: 8, padding: 12 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Economia Mensal Estimada</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: "#34d399", marginTop: 2 }}>
                      ${simSavingsUsd} <span style={{ fontSize: 13, fontWeight: 500 }}>USD</span>
                    </div>
                  </div>

                  <div style={{ background: "rgba(99, 102, 241, 0.08)", border: "1px solid rgba(99, 102, 241, 0.2)", borderRadius: 8, padding: 12 }}>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Economia Anual Projetada</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: "#818cf8", marginTop: 2 }}>
                      ${simAnnualSavings} <span style={{ fontSize: 13, fontWeight: 500 }}>USD</span>
                    </div>
                  </div>
                </div>

                <div style={{ background: "rgba(56, 189, 248, 0.08)", border: "1px solid rgba(56, 189, 248, 0.2)", borderRadius: 8, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Redução de Emissão ESG Estimada</div>
                      <div style={{ fontSize: 16, fontWeight: 650, color: "#38bdf8", marginTop: 2 }}>
                        {simCarbonReductionKg} kg CO2e / ano
                      </div>
                    </div>
                    <Sparkles size={22} color="#38bdf8" />
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: "1px solid var(--border-subtle)" }}>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Retorno de Investimento (ROI) em Hardware:</span>
                  <Badge tone="success">
                    ~2.4 meses
                  </Badge>
                </div>
              </div>
            </div>
          </SectionCard>
        </div>
      )}

      {/* SlideOver Drawer para Inspeção de Evento de Auditoria */}
      <SlideOverDrawer
        open={Boolean(inspectedLog)}
        onClose={() => setInspectedLog(null)}
        title="Detalhes do Evento de Auditoria"
        subtitle={inspectedLog ? `${inspectedLog.action} em ${inspectedLog.targetType}` : undefined}
        footer={
          <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
            <button
              type="button"
              className="noema-btn noema-btn-sm noema-btn-ghost"
              onClick={copyLogJson}
            >
              {copiedLogJson ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
              {copiedLogJson ? "Copiado!" : "Copiar JSON"}
            </button>
            <button
              type="button"
              className="noema-btn noema-btn-sm noema-btn-primary"
              onClick={() => setInspectedLog(null)}
            >
              Fechar
            </button>
          </div>
        }
      >
        {inspectedLog && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div style={{ background: "rgba(148, 163, 184, 0.05)", padding: 10, borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Ator</div>
                <div style={{ fontWeight: 600, fontSize: 13, marginTop: 2 }}>{inspectedLog.actorId}</div>
              </div>

              <div style={{ background: "rgba(148, 163, 184, 0.05)", padding: 10, borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Tipo de Ator</div>
                <div style={{ fontWeight: 600, fontSize: 13, marginTop: 2 }}>
                  <Badge tone={inspectedLog.actorType === "agent" ? "accent" : "neutral"}>
                    {inspectedLog.actorType ?? "humano / padrão"}
                  </Badge>
                </div>
              </div>

              <div style={{ background: "rgba(148, 163, 184, 0.05)", padding: 10, borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Ação Executada</div>
                <div style={{ fontWeight: 600, fontSize: 13, marginTop: 2 }}>
                  <Badge tone={actionTone(inspectedLog.action)}>{inspectedLog.action}</Badge>
                </div>
              </div>

              <div style={{ background: "rgba(148, 163, 184, 0.05)", padding: 10, borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Recurso / Alvo</div>
                <div style={{ fontWeight: 600, fontSize: 13, marginTop: 2 }}>{inspectedLog.targetType}</div>
              </div>
            </div>

            <div style={{ background: "rgba(148, 163, 184, 0.05)", padding: 10, borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>ID do Alvo</div>
              <div className="noema-mono" style={{ fontSize: 12, marginTop: 2, wordBreak: "break-all" }}>
                {inspectedLog.targetId}
              </div>
            </div>

            <div style={{ background: "rgba(148, 163, 184, 0.05)", padding: 10, borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Data & Hora</div>
              <div style={{ fontSize: 12, marginTop: 2 }}>
                {formatDate(inspectedLog.createdAt ?? inspectedLog.timestamp ?? "")} (
                <span className="noema-mono" style={{ fontSize: 11 }}>
                  {inspectedLog.createdAt ?? inspectedLog.timestamp}
                </span>
                )
              </div>
            </div>

            {inspectedLog.accessPolicyId && (
              <div style={{ background: "rgba(148, 163, 184, 0.05)", padding: 10, borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Política de Acesso (OPA)</div>
                <div className="noema-mono" style={{ fontSize: 12, marginTop: 2 }}>
                  {inspectedLog.accessPolicyId}
                </div>
              </div>
            )}

            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Metadados do Evento (Payload JSON)</div>
              <pre className="noema-json-block">
                {JSON.stringify(inspectedLog.metadata ?? inspectedLog, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </SlideOverDrawer>
    </div>
  );
}
