"use client";

import type { QueryClient } from "@tanstack/react-query";
import { Activity, CheckCircle2, Database, FileText, GitBranch, Loader2, Play } from "lucide-react";
import { useState } from "react";
import type { ApiFetchFn, NotifyFn } from "../../lib/types";
import { DomainDistributionChart, HealthDonutChart } from "../Charts";
import { Badge, EmptyState, Field, SectionCard, StatCard, statusTone } from "../UiPrimitives";

export function ProjectsWorkspace(props: {
  projectId: string;
  overview?: {
    totalItems: number;
    approvedCount: number;
    draftCount: number;
    health: { healthScore?: number; untestedRuleIds?: string[] };
  };
  loading?: boolean;
  domainDistribution: Array<{ name: string; count: number }>;
  recentJobs: Array<{ jobId: string; owner: string; repo: string; ref: string; state: string }>;
  apiFetch: ApiFetchFn;
  queryClient: QueryClient;
  notify: NotifyFn;
}) {
  const { projectId, overview, loading, domainDistribution, recentJobs, apiFetch, queryClient, notify } = props;
  const [githubOwner, setGithubOwner] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubRef, setGithubRef] = useState("main");
  const [submitting, setSubmitting] = useState(false);

  const total = overview?.totalItems ?? 0;
  const approved = overview?.approvedCount ?? 0;
  const drafts = overview?.draftCount ?? 0;
  const health = overview?.health?.healthScore ?? 100;
  const untested = overview?.health?.untestedRuleIds?.length ?? 0;
  const approvedPct = total > 0 ? Math.round((approved / total) * 100) : 0;
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
      <div className="noema-grid-stats">
        <StatCard label="Itens indexados" value={total} icon={<Database size={16} />} loading={loading} hint="Total no grafo de conhecimento" />
        <StatCard
          label="Aprovados"
          value={approved}
          tone="success"
          icon={<CheckCircle2 size={16} />}
          loading={loading}
          progress={approvedPct}
          hint={`${approvedPct}% do total`}
        />
        <StatCard
          label="Rascunhos"
          value={drafts}
          tone="warning"
          icon={<FileText size={16} />}
          loading={loading}
          hint={drafts > 0 ? "Aguardando revisão na Caixa de Entrada" : "Nenhum pendente"}
        />
        <StatCard
          label="Health score"
          value={`${health}%`}
          tone={health >= 80 ? "success" : health >= 50 ? "warning" : "danger"}
          icon={<Activity size={16} />}
          loading={loading}
          progress={health}
          hint={untested > 0 ? `${untested} regras sem teste verificado` : "Todas as regras cobertas"}
        />
      </div>

      <div className="noema-grid-2">
        <SectionCard title="Saúde do conhecimento" subtitle="Aprovados × rascunhos × regras sem teste">
          <HealthDonutChart approved={approved} draft={drafts} untested={untested} />
        </SectionCard>
        <SectionCard title="Distribuição por tipo" subtitle="Quantidade de itens por categoria">
          <DomainDistributionChart items={domainDistribution} />
        </SectionCard>
      </div>

      <div className="noema-grid-2">
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
            style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, alignItems: "end" }}
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
              {recentJobs.slice(0, 6).map((job) => (
                <div key={job.jobId} className="noema-list-row" style={{ padding: "10px 16px" }}>
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
    </>
  );
}
