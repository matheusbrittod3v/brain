"use client";

import type { QueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Coins,
  Cpu,
  Database,
  FileText,
  GitBranch,
  Inbox,
  Layers,
  Loader2,
  Network,
  Play,
  Radar,
  ScrollText,
  Shield,
  ShieldCheck,
  Users,
  Wand2
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  ApiFetchFn,
  FinOpsData,
  InspectedItemState,
  KnowledgeHitItem,
  KnowledgeStatus,
  NotifyFn,
  ProposalItem,
  WorkspaceId
} from "../../lib/types";
import { DomainDistributionChart, HealthDonutChart } from "../Charts";
import { Badge, EmptyState, Field, SectionCard, StatCard, statusTone } from "../UiPrimitives";

export interface ProjectOverviewData {
  totalItems: number;
  approvedCount: number;
  draftCount: number;
  health: { healthScore?: number; untestedRuleIds?: string[]; staleItemIds?: string[] };
  graphHealth?: { healthScore?: number; untestedRuleIds?: string[]; staleItemIds?: string[] };
  alerts?: string[];
  summary?: {
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    byPolicy: Record<string, number>;
    rulesCount: number;
    testsCount: number;
    graphLinkedRulesCount: number;
    ciVerifiedRulesCount: number;
  };
}

function ProgressRow({
  label,
  valueLabel,
  percent,
  color = "var(--accent-primary)"
}: {
  label: string;
  valueLabel: string;
  percent: number;
  color?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
        <span style={{ color: "var(--text-secondary)" }}>{label}</span>
        <span className="noema-mono" style={{ color: "var(--text-primary)", fontWeight: 550 }}>
          {valueLabel}
        </span>
      </div>
      <div className="noema-progress">
        <span style={{ width: `${clamped}%`, background: color }} />
      </div>
    </div>
  );
}

export function ProjectsWorkspace(props: {
  projectId: string;
  projectMeta?: { projectId: string; name: string; description?: string; knowledgeRoot: string };
  overview?: ProjectOverviewData;
  loading?: boolean;
  domainDistribution: Array<{ name: string; count: number }>;
  knowledgeItems?: KnowledgeHitItem[];
  proposals?: ProposalItem[];
  draftItems?: KnowledgeHitItem[];
  recentJobs: Array<{ jobId: string; owner: string; repo: string; ref: string; state: string; createdAt?: string }>;
  pendingInboxCount?: number;
  graphNodesCount?: number;
  graphEdgesCount?: number;
  graphEdges?: Array<{ from: string; to: string; relation: string }>;
  runnerTasks?: Array<{
    taskId: string;
    instruction: string;
    status: string;
    priority: string;
    resultSummary?: string;
    createdAt?: string;
    pendingQuestion?: { questionId: string; question: string };
  }>;
  runnerSchedules?: Array<{ scheduleId: string; cron: string; instruction: string; priority: string }>;
  finops?: FinOpsData;
  auditLogs?: Array<{ id?: string; createdAt?: string; timestamp?: string; actorId: string; action: string; targetType: string; targetId: string }>;
  enterprise?: {
    techRadar: Array<{ id: string; title: string; ring: string; quadrant: string }>;
    qaCoverage?: { coveragePercent: number; rows: Array<{ ruleId: string; title: string; priority: string; covered: boolean }> };
    coverageMatrix?: Array<{ ruleId: string; title: string; priority: string; covered: boolean }>;
  };
  scaffoldRecommendations?: Array<{ id: string; title: string; sourceUri: string; summary?: string }>;
  accessSummary?: {
    roles: string[];
    membersCount: number;
    rolesCount: number;
    assignmentsCount: number;
  };
  onInspect?: (item: InspectedItemState) => void;
  onNavigate?: (workspace: WorkspaceId) => void;
  apiFetch: ApiFetchFn;
  queryClient: QueryClient;
  notify: NotifyFn;
}) {
  const {
    projectId,
    projectMeta,
    overview,
    loading,
    domainDistribution,
    knowledgeItems = [],
    proposals = [],
    draftItems = [],
    recentJobs,
    pendingInboxCount = 0,
    graphNodesCount = 0,
    graphEdgesCount = 0,
    graphEdges = [],
    runnerTasks = [],
    runnerSchedules = [],
    finops,
    auditLogs = [],
    enterprise,
    scaffoldRecommendations = [],
    accessSummary,
    onInspect,
    onNavigate,
    apiFetch,
    queryClient,
    notify
  } = props;

  const [githubOwner, setGithubOwner] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubRef, setGithubRef] = useState("main");
  const [submitting, setSubmitting] = useState(false);

  const total = overview?.totalItems ?? 0;
  const approved = overview?.approvedCount ?? 0;
  const drafts = overview?.draftCount ?? 0;
  const deprecatedCount = overview?.summary?.byStatus?.deprecated ?? 0;
  const health = overview?.graphHealth?.healthScore ?? overview?.health?.healthScore ?? 100;
  const ciHealth = overview?.health?.healthScore ?? health;
  const untested = overview?.graphHealth?.untestedRuleIds?.length ?? overview?.health?.untestedRuleIds?.length ?? 0;
  const staleCount = overview?.graphHealth?.staleItemIds?.length ?? overview?.health?.staleItemIds?.length ?? 0;
  const approvedPct = total > 0 ? Math.round((approved / total) * 100) : 0;

  const summary = overview?.summary;
  const rulesCount = summary?.rulesCount ?? 0;
  const testsCount = summary?.testsCount ?? 0;
  const graphLinkedRules = summary?.graphLinkedRulesCount ?? 0;
  const ciVerifiedRules = summary?.ciVerifiedRulesCount ?? 0;
  const rulesLinkPct = rulesCount > 0 ? Math.round((graphLinkedRules / rulesCount) * 100) : 100;
  const ciRulesPct = rulesCount > 0 ? Math.round((ciVerifiedRules / rulesCount) * 100) : 100;

  const runningTasks = runnerTasks.filter((t) => ["queued", "running", "in_progress"].includes(t.status)).length;
  const completedTasks = runnerTasks.filter((t) => ["completed", "succeeded", "done"].includes(t.status)).length;
  const failedTasks = runnerTasks.filter((t) => ["failed", "error"].includes(t.status)).length;
  const alerts = overview?.alerts ?? [];

  const qaRows = enterprise?.qaCoverage?.rows ?? enterprise?.coverageMatrix ?? [];
  const qaCoveredCount = qaRows.filter((r) => r.covered).length;
  const qaCoveragePct =
    enterprise?.qaCoverage?.coveragePercent ??
    (qaRows.length > 0 ? Math.round((qaCoveredCount / qaRows.length) * 100) : rulesLinkPct);
  const uncoveredRules = qaRows.filter((r) => !r.covered);

  const techRadarByRing = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of enterprise?.techRadar ?? []) {
      counts[item.ring] = (counts[item.ring] ?? 0) + 1;
    }
    return Object.entries(counts);
  }, [enterprise?.techRadar]);

  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of graphEdges) {
      counts.set(edge.relation, (counts.get(edge.relation) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [graphEdges]);

  const domainCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of knowledgeItems) {
      counts.set(item.domainId, (counts.get(item.domainId) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [knowledgeItems]);

  const recentKnowledge = useMemo(() => {
    return [...knowledgeItems]
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
      .slice(0, 6);
  }, [knowledgeItems]);

  const totalProviderCostUsd = useMemo(() => {
    const models = finops?.modelUsage?.byModel ?? [];
    return models.reduce((acc, m) => acc + (m.providerCostUsd ?? 0), 0);
  }, [finops?.modelUsage?.byModel]);

  const totalModelTokens = useMemo(() => {
    const models = finops?.modelUsage?.byModel ?? [];
    return models.reduce((acc, m) => acc + (m.totalTokens ?? 0), 0);
  }, [finops?.modelUsage?.byModel]);

  const graphDensity = graphNodesCount > 0 ? (graphEdgesCount / graphNodesCount).toFixed(1) : "0.0";

  const canSubmit = githubOwner.trim() && githubRepo.trim() && githubRef.trim() && !submitting;

  const submit = () => {
    if (!canSubmit) return;
    setSubmitting(true);
    void apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/github/ingest`, {
      method: "POST",
      body: JSON.stringify({ owner: githubOwner.trim(), repo: githubRepo.trim(), ref: githubRef.trim() })
    })
      .then(() => {
        notify(`Ingestão de ${githubOwner}/${githubRepo}@${githubRef} enfileirada.`);
        return queryClient.invalidateQueries({ queryKey: ["integrations"] });
      })
      .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setSubmitting(false));
  };

  return (
    <>
      {/* 1. Contexto Executivo do Projeto + Atalhos Rápidos */}
      {projectMeta && (
        <div
          className="noema-card"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 14,
            padding: "14px 18px"
          }}
        >
          <div style={{ minWidth: 0, flex: "1 1 320px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 15 }}>{projectMeta.name}</strong>
              <Badge tone="accent">{projectMeta.projectId}</Badge>
              <span className="noema-mono" style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                root: {projectMeta.knowledgeRoot}
              </span>
            </div>
            {projectMeta.description && (
              <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: 4 }}>{projectMeta.description}</div>
            )}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <Badge tone="neutral">{rulesCount} regras</Badge>
              <Badge tone="neutral">{testsCount} testes</Badge>
              <Badge tone={qaCoveragePct >= 80 ? "success" : "warning"}>QA {qaCoveragePct}%</Badge>
              {accessSummary && (
                <Badge tone="accent">
                  {accessSummary.membersCount} membros · {accessSummary.assignmentsCount} vínculos IA
                </Badge>
              )}
              {scaffoldRecommendations.length > 0 && (
                <Badge tone="neutral">{scaffoldRecommendations.length} templates</Badge>
              )}
            </div>
          </div>

          {onNavigate && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("knowledge")}>
                <FileText size={13} /> Conhecimento
              </button>
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("search")}>
                <Network size={13} /> Grafo
              </button>
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("inbox")}>
                <Inbox size={13} /> Inbox ({pendingInboxCount})
              </button>
              <button className="noema-btn noema-btn-primary noema-btn-sm" onClick={() => onNavigate("agents")}>
                <Bot size={13} /> Delegar ao Runner
              </button>
            </div>
          )}
        </div>
      )}

      {/* 2. KPIs Principais — Todos os Setores (8 cards) */}
      <div className="noema-grid-stats">
        <StatCard
          label="Itens indexados"
          value={total}
          icon={<Database size={16} />}
          loading={loading}
          progress={approvedPct}
          onClick={onNavigate ? () => onNavigate("knowledge") : undefined}
          hint={`${approved} aprovados (${approvedPct}%) · ${drafts} rascunhos${deprecatedCount > 0 ? ` · ${deprecatedCount} obsoletos` : ""}`}
        />
        <StatCard
          label="Health score (Grafo)"
          value={`${health}%`}
          tone={health >= 80 ? "success" : health >= 50 ? "warning" : "danger"}
          icon={<Activity size={16} />}
          loading={loading}
          progress={health}
          onClick={onNavigate ? () => onNavigate("enterprise") : undefined}
          hint={
            untested > 0
              ? `${untested} regras sem teste · ${staleCount} desatualizados`
              : ciHealth < health
                ? `Grafo: ${health}% · CI: ${ciHealth}%`
                : staleCount > 0
                  ? `${staleCount} itens >90d sem revisão`
                  : "Todas as regras verificadas"
          }
        />
        <StatCard
          label="Regras & Cobertura QA"
          value={`${graphLinkedRules}/${rulesCount}`}
          tone={rulesLinkPct === 100 ? "success" : "warning"}
          icon={<ShieldCheck size={16} />}
          loading={loading}
          progress={qaCoveragePct}
          onClick={onNavigate ? () => onNavigate("enterprise") : undefined}
          hint={`${ciVerifiedRules} em CI · QA corporativo ${qaCoveragePct}%`}
        />
        <StatCard
          label="Pendências (Inbox)"
          value={pendingInboxCount}
          tone={pendingInboxCount > 0 ? "warning" : "success"}
          icon={<Inbox size={16} />}
          loading={loading}
          onClick={onNavigate ? () => onNavigate("inbox") : undefined}
          hint={
            pendingInboxCount > 0
              ? `${proposals.length} propostas · ${draftItems.length} rascunhos`
              : "Caixa de entrada limpa"
          }
        />
        <StatCard
          label="Grafo & Conexões"
          value={graphEdgesCount}
          tone="accent"
          icon={<Network size={16} />}
          loading={loading}
          onClick={onNavigate ? () => onNavigate("search") : undefined}
          hint={`${graphNodesCount} nós · média ${graphDensity} relações/nó`}
        />
        <StatCard
          label="Agentes & Runner"
          value={runnerTasks.length}
          tone={failedTasks > 0 ? "danger" : runningTasks > 0 ? "warning" : "default"}
          icon={<Cpu size={16} />}
          loading={loading}
          onClick={onNavigate ? () => onNavigate("agents") : undefined}
          hint={`${runningTasks} ativas · ${completedTasks} concluídas · ${failedTasks} falhas`}
        />
        <StatCard
          label="FinOps & Consumo IA"
          value={finops ? `$${(totalProviderCostUsd + (finops.infrastructureEstimate?.totalInfraAndEnergyUsd ?? 0)).toFixed(3)}` : "—"}
          tone="accent"
          icon={<Coins size={16} />}
          loading={loading}
          onClick={onNavigate ? () => onNavigate("operations") : undefined}
          hint={`${finops?.modelUsage?.calls ?? 0} chamadas · ${((totalModelTokens || finops?.estimatedLocalTokens || 0) / 1000).toFixed(1)}k tokens`}
        />
        <StatCard
          label="Acesso & Templates"
          value={accessSummary ? `${accessSummary.membersCount} / ${scaffoldRecommendations.length}` : scaffoldRecommendations.length}
          tone="default"
          icon={<Users size={16} />}
          loading={loading}
          onClick={onNavigate ? () => onNavigate("access") : undefined}
          hint={
            accessSummary
              ? `${accessSummary.rolesCount} cargos · ${accessSummary.assignmentsCount} agentes · ${scaffoldRecommendations.length} templates`
              : `${scaffoldRecommendations.length} templates de arquitetura`
          }
        />
      </div>

      {/* 3. Alertas operacionais */}
      {alerts.length > 0 && (
        <SectionCard
          title={`Alertas de Governança (${alerts.length})`}
          icon={<AlertTriangle size={15} />}
          actions={
            onNavigate && (
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("enterprise")}>
                Ver Visões Corporativas
              </button>
            )
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {alerts.map((alert, idx) => (
              <div
                key={idx}
                style={{
                  fontSize: 12.5,
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(245,158,11,0.28)",
                  background: "rgba(245,158,11,0.06)",
                  color: "#fde68a"
                }}
              >
                {alert}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* 4. Gráficos & Cobertura de Engenharia */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(290px, 100%), 1fr))", gap: 14 }}>
        <SectionCard title="Saúde do conhecimento" subtitle="Aprovados × rascunhos × regras sem teste">
          <HealthDonutChart approved={approved} draft={drafts} untested={untested} />
        </SectionCard>
        <SectionCard title="Distribuição por tipo" subtitle="Quantidade de itens por categoria">
          {domainDistribution.length > 0 ? (
            <DomainDistributionChart items={domainDistribution} />
          ) : (
            <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 }}>
              Sem itens categorizados ainda
            </div>
          )}
        </SectionCard>
        <SectionCard
          title="Cobertura & Domínios"
          subtitle="Aderência de regras, testes e domínios"
          icon={<Layers size={15} />}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <ProgressRow
              label="Regras vinculadas no grafo"
              valueLabel={`${graphLinkedRules}/${rulesCount} (${rulesLinkPct}%)`}
              percent={rulesLinkPct}
              color="var(--accent-success)"
            />
            <ProgressRow
              label="Regras verificadas em CI"
              valueLabel={`${ciVerifiedRules}/${rulesCount} (${ciRulesPct}%)`}
              percent={ciRulesPct}
              color="var(--accent-secondary)"
            />
            <ProgressRow
              label="Cobertura QA Corporativa"
              valueLabel={`${qaCoveragePct}%`}
              percent={qaCoveragePct}
              color={qaCoveragePct >= 80 ? "var(--accent-success)" : "var(--accent-warning)"}
            />
            {domainCounts.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
                {domainCounts.map(([domainId, count]) => (
                  <Badge key={domainId} tone="neutral">
                    Domínio #{domainId}: {count}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </SectionCard>
      </div>

      {/* 5. Conhecimento Recente + Inbox / Aprovações */}
      <div className="noema-grid-2">
        <SectionCard
          title="Conhecimento recente"
          subtitle={`Últimos itens atualizados (${knowledgeItems.length} carregados)`}
          icon={<FileText size={15} />}
          flush
          actions={
            onNavigate && (
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("knowledge")}>
                Explorar base <ArrowUpRight size={13} />
              </button>
            )
          }
        >
          {recentKnowledge.length === 0 ? (
            <EmptyState icon={<FileText size={18} />} title="Base vazia" description="Ingira documentos ou conecte um repositório." />
          ) : (
            <div className="noema-list">
              {recentKnowledge.map((item) => (
                <div
                  key={item.id}
                  className="noema-list-row"
                  style={{ padding: "10px 16px", cursor: onInspect ? "pointer" : "default" }}
                  onClick={() =>
                    onInspect?.({
                      title: item.title,
                      subtitle: `${item.type} · ${item.sourceUri}`,
                      body: item.content,
                      itemId: item.id,
                      status: item.status as KnowledgeStatus,
                      meta: { domainId: item.domainId, accessPolicyId: item.accessPolicyId, updatedAt: item.updatedAt }
                    })
                  }
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span className="noema-truncate" style={{ fontSize: 13, fontWeight: 550 }}>
                      {item.title}
                    </span>
                    <span className="noema-mono noema-truncate" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {item.id} · {item.sourceUri}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                    <Badge tone="accent">{item.type}</Badge>
                    <Badge tone={statusTone(item.status)} dot>
                      {item.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Caixa de Entrada & Revisões"
          subtitle={`${proposals.length} propostas · ${draftItems.length} rascunhos`}
          icon={<Inbox size={15} />}
          flush
          actions={
            onNavigate && (
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("inbox")}>
                Revisar fila <ArrowUpRight size={13} />
              </button>
            )
          }
        >
          {proposals.length === 0 && draftItems.length === 0 ? (
            <EmptyState icon={<Inbox size={18} />} title="Tudo aprovado" description="Nenhuma proposta ou rascunho pendente." />
          ) : (
            <div className="noema-list">
              {proposals.slice(0, 4).map((p) => (
                <div key={p.proposalId} className="noema-list-row" style={{ padding: "10px 16px" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span className="noema-truncate" style={{ fontSize: 13, fontWeight: 550 }}>
                      {p.title || p.itemJson?.title || p.itemId}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      Proposta por <strong>{p.requestedBy}</strong>
                    </span>
                  </div>
                  <Badge tone={statusTone(p.status)} dot>
                    {p.status}
                  </Badge>
                </div>
              ))}
              {draftItems.slice(0, Math.max(0, 5 - proposals.slice(0, 4).length)).map((d) => (
                <div
                  key={d.id}
                  className="noema-list-row"
                  style={{ padding: "10px 16px", cursor: onInspect ? "pointer" : "default" }}
                  onClick={() =>
                    onInspect?.({
                      title: d.title,
                      subtitle: `${d.type} · ${d.sourceUri}`,
                      body: d.content,
                      itemId: d.id,
                      status: d.status as KnowledgeStatus
                    })
                  }
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span className="noema-truncate" style={{ fontSize: 13, fontWeight: 550 }}>
                      {d.title}
                    </span>
                    <span className="noema-mono noema-truncate" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      Rascunho · {d.type}
                    </span>
                  </div>
                  <Badge tone="warning" dot>
                    draft
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>

      {/* 6. Setores Especializados: Enterprise/Radar, Templates, Grafo, Governança, Integrações, FinOps */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(290px, 100%), 1fr))", gap: 14 }}>
        <SectionCard
          title="Visões Corporativas & Tech Radar"
          subtitle={`${enterprise?.techRadar?.length ?? 0} tecnologias · ${qaRows.length} regras avaliadas`}
          icon={<Radar size={15} />}
          actions={
            onNavigate && (
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("enterprise")}>
                Abrir
              </button>
            )
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {techRadarByRing.map(([ring, count]) => (
                <Badge key={ring} tone={ring === "adopt" ? "success" : ring === "hold" ? "danger" : "accent"}>
                  {ring}: {count}
                </Badge>
              ))}
              {techRadarByRing.length === 0 && (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Sem entradas no Tech Radar.</span>
              )}
            </div>
            {uncoveredRules.length > 0 ? (
              <div style={{ paddingTop: 8, borderTop: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Regras descobertas prioritárias:</span>
                {uncoveredRules.slice(0, 3).map((r) => (
                  <div key={r.ruleId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span className="noema-truncate">{r.title || r.ruleId}</span>
                    <Badge tone="warning">{r.priority}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              qaRows.length > 0 && (
                <div style={{ fontSize: 12, color: "var(--accent-success)", paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
                  Todas as {qaRows.length} regras avaliadas estão cobertas.
                </div>
              )
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Templates & Scaffold"
          subtitle="Padrões aprovados prontos para uso"
          icon={<Wand2 size={15} />}
          actions={
            onNavigate && (
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("templates")}>
                Ver todos
              </button>
            )
          }
        >
          {scaffoldRecommendations.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Nenhum template derivado ainda.</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {scaffoldRecommendations.slice(0, 4).map((rec) => (
                <div
                  key={rec.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    paddingBottom: 6,
                    borderBottom: "1px solid var(--border-subtle)"
                  }}
                >
                  <span className="noema-truncate" style={{ fontSize: 12.5, fontWeight: 550 }}>
                    {rec.title}
                  </span>
                  <span className="noema-mono noema-truncate" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    {rec.sourceUri}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Grafo & Relações"
          subtitle={`${graphNodesCount} nós · ${graphEdgesCount} arestas`}
          icon={<Network size={15} />}
          actions={
            onNavigate && (
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("search")}>
                Explorar
              </button>
            )
          }
        >
          {relationCounts.length === 0 ? (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Sem arestas carregadas no grafo raiz.</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {relationCounts.map(([rel, count]) => (
                  <Badge key={rel} tone="accent">
                    {rel}: {count}
                  </Badge>
                ))}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
                Densidade estrutural: <strong className="noema-mono">{graphDensity}</strong> conexões por nó.
              </div>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Governança, Acesso & Políticas"
          subtitle="Políticas, ciclo de vida e RBAC"
          icon={<Shield size={15} />}
          actions={
            onNavigate && (
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("access")}>
                Gerenciar
              </button>
            )
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {Object.entries(summary?.byPolicy ?? {}).map(([pol, count]) => (
                <Badge key={pol} tone="accent">
                  {pol}: {count}
                </Badge>
              ))}
              {Object.keys(summary?.byPolicy ?? {}).length === 0 && (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Sem políticas indexadas.</span>
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
              {Object.entries(summary?.byStatus ?? {}).map(([st, count]) => (
                <Badge key={st} tone={statusTone(st)} dot>
                  {st}: {count}
                </Badge>
              ))}
            </div>
            {accessSummary && (
              <div style={{ fontSize: 12, color: "var(--text-secondary)", paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
                Seu cargo: <strong>{accessSummary.roles.join(", ") || "padrão"}</strong> · {accessSummary.membersCount} membros
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Execuções & FinOps"
          subtitle="Consumo de IA, modelos e Runner"
          icon={<Bot size={15} />}
          actions={
            onNavigate && (
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("operations")}>
                FinOps
              </button>
            )
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-secondary)" }}>Tokens estimados</span>
              <strong className="noema-mono">{(finops?.estimatedLocalTokens ?? 0).toLocaleString("pt-BR")}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-secondary)" }}>Custo provedor + infra</span>
              <strong className="noema-mono">
                ${(totalProviderCostUsd + (finops?.infrastructureEstimate?.totalInfraAndEnergyUsd ?? 0)).toFixed(4)}
              </strong>
            </div>
            {(finops?.modelUsage?.byModel ?? []).slice(0, 2).map((m) => (
              <div key={m.model} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--text-muted)" }}>
                <span className="noema-truncate">{m.model}</span>
                <span className="noema-mono">{(m.totalTokens ?? 0).toLocaleString("pt-BR")} tok</span>
              </div>
            ))}
            {runnerTasks.slice(0, 2).map((t) => (
              <div
                key={t.taskId}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  paddingTop: 5,
                  borderTop: "1px solid var(--border-subtle)"
                }}
              >
                <span className="noema-truncate" style={{ fontSize: 12 }}>
                  {t.instruction}
                </span>
                <Badge tone={statusTone(t.status)}>{t.status}</Badge>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard
          title="Subagents, Runner & Agendamentos"
          subtitle={`${runnerTasks.length} execuções · ${runnerSchedules.length} crons ativos`}
          icon={<Cpu size={15} />}
          actions={
            onNavigate && (
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("agents")}>
                Gerenciar Runner
              </button>
            )
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <Badge tone={runningTasks > 0 ? "warning" : "neutral"}>{runningTasks} ativas</Badge>
              <Badge tone="success">{completedTasks} concluídas</Badge>
              {failedTasks > 0 && <Badge tone="danger">{failedTasks} falhas</Badge>}
              {runnerTasks.some((t) => t.pendingQuestion) && (
                <Badge tone="warning" dot>
                  {runnerTasks.filter((t) => t.pendingQuestion).length} aguardando resposta
                </Badge>
              )}
              <Badge tone="accent">{runnerSchedules.length} crons</Badge>
            </div>

            {runnerTasks
              .filter((t) => t.pendingQuestion)
              .slice(0, 2)
              .map((t) => (
                <div
                  key={`q-${t.taskId}`}
                  style={{
                    fontSize: 12,
                    padding: "6px 10px",
                    borderRadius: 8,
                    border: "1px solid rgba(245,158,11,0.28)",
                    background: "rgba(245,158,11,0.06)",
                    color: "#fde68a"
                  }}
                >
                  <strong>Subagent pergunta:</strong> {t.pendingQuestion!.question}
                </div>
              ))}

            {runnerSchedules.slice(0, 2).map((s) => (
              <div
                key={s.scheduleId}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  paddingTop: 5,
                  borderTop: "1px solid var(--border-subtle)",
                  fontSize: 12
                }}
              >
                <span className="noema-truncate">{s.instruction}</span>
                <Badge tone="accent">{s.cron}</Badge>
              </div>
            ))}

            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, paddingTop: 6, borderTop: "1px solid var(--border-subtle)" }}>
              {["send_message", "logs", "ask_local", "triage_inbox", "artifacts", "verify", "usage", "schedule", "retry"].map((tool) => (
                <span
                  key={tool}
                  className="noema-mono"
                  style={{
                    fontSize: 10.5,
                    padding: "1px 6px",
                    borderRadius: 6,
                    border: "1px solid var(--border-subtle)",
                    color: "var(--text-muted)"
                  }}
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>
        </SectionCard>
      </div>

      {/* 7. Auditoria Recente + Conectar GitHub & Ingestões */}
      <div className="noema-grid-2">
        <SectionCard
          title="Atividade recente (Auditoria)"
          subtitle="Últimas ações humanas e de agentes no projeto"
          icon={<ScrollText size={15} />}
          flush
          actions={
            onNavigate && (
              <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => onNavigate("operations")}>
                Ver tudo
              </button>
            )
          }
        >
          {auditLogs.length === 0 ? (
            <EmptyState icon={<FileText size={18} />} title="Sem eventos recentes" description="As ações em API e MCP aparecem aqui." />
          ) : (
            <div className="noema-list">
              {auditLogs.slice(0, 6).map((log, i) => (
                <div key={log.id ?? `${log.actorId}-${i}`} className="noema-list-row" style={{ padding: "9px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <Badge tone={/create|approve/i.test(log.action) ? "success" : "accent"}>{log.action}</Badge>
                    <span className="noema-truncate" style={{ fontSize: 12.5 }}>
                      <strong>{log.actorId}</strong> · {log.targetType}
                    </span>
                  </div>
                  <span className="noema-mono noema-truncate" style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 150 }}>
                    {log.targetId}
                  </span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <div className="noema-stack">
          <SectionCard
            title="Conectar repositório GitHub"
            subtitle="Ingere código, ADRs e regras a partir de um commit fixo"
            icon={<GitBranch size={15} />}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
              style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, alignItems: "end" }}
            >
              <Field label="Owner">
                <input className="noema-input" value={githubOwner} onChange={(e) => setGithubOwner(e.target.value)} placeholder="acme" />
              </Field>
              <Field label="Repositório">
                <input className="noema-input" value={githubRepo} onChange={(e) => setGithubRepo(e.target.value)} placeholder="backend" />
              </Field>
              <Field label="Branch / SHA">
                <input className="noema-input noema-mono" value={githubRef} onChange={(e) => setGithubRef(e.target.value)} placeholder="main" />
              </Field>
              <button type="submit" className="noema-btn noema-btn-primary" disabled={!canSubmit}>
                {submitting ? <Loader2 size={14} className="noema-spin" /> : <Play size={14} />}
                Ingerir
              </button>
            </form>
          </SectionCard>

          <SectionCard title="Ingestões recentes" subtitle="Últimos jobs do worker" flush>
            {recentJobs.length === 0 ? (
              <EmptyState icon={<GitBranch size={18} />} title="Nenhuma ingestão ainda" description="Conecte um repositório para começar." />
            ) : (
              <div className="noema-list">
                {recentJobs.slice(0, 4).map((job) => (
                  <div key={job.jobId} className="noema-list-row" style={{ padding: "9px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <GitBranch size={14} color="var(--text-muted)" />
                      <span className="noema-truncate" style={{ fontSize: 13 }}>
                        {job.owner}/<strong style={{ fontWeight: 550 }}>{job.repo}</strong>
                      </span>
                      <span className="noema-mono" style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                        @{job.ref.length > 12 ? job.ref.slice(0, 7) : job.ref}
                      </span>
                    </div>
                    <Badge tone={statusTone(job.state)} dot>
                      {job.state}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      </div>
    </>
  );
}
