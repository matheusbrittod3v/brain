"use client";

import { Bot, CheckCircle2, FileText, GitPullRequest, Inbox, RotateCcw, Search, User, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import type { InspectedItemState, KnowledgeHitItem, KnowledgeStatus, ProposalItem } from "../../lib/types";
import { Badge, EmptyState, Segmented, statusTone } from "../UiPrimitives";

type Filter = "all" | "proposals" | "drafts";

function relativeTime(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "";
  const min = Math.round(diff / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

export function InboxWorkspace(props: {
  proposalsList: ProposalItem[];
  draftInboxItems: KnowledgeHitItem[];
  onInspect: (item: InspectedItemState) => void;
  onProposalDecision: (proposalId: string, decision: "approve" | "reject" | "request_changes") => Promise<void>;
  onChangeItemStatus: (itemId: string, status: KnowledgeStatus) => Promise<void>;
}) {
  const { proposalsList, draftInboxItems, onInspect, onProposalDecision, onChangeItemStatus } = props;
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const proposals = useMemo(
    () =>
      proposalsList.filter((p) =>
        !q ? true : `${p.itemJson?.title ?? p.title ?? p.itemId} ${p.proposalId} ${p.requestedBy}`.toLowerCase().includes(q)
      ),
    [proposalsList, q]
  );
  const drafts = useMemo(
    () => draftInboxItems.filter((d) => (!q ? true : `${d.title} ${d.id} ${d.sourceUri}`.toLowerCase().includes(q))),
    [draftInboxItems, q]
  );

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  };

  const showProposals = filter !== "drafts";
  const showDrafts = filter !== "proposals";
  const visibleCount = (showProposals ? proposals.length : 0) + (showDrafts ? drafts.length : 0);
  const totalCount = proposalsList.length + draftInboxItems.length;

  return (
    <div className="noema-stack">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Segmented<Filter>
          ariaLabel="Filtrar caixa de entrada"
          value={filter}
          onChange={setFilter}
          options={[
            { id: "all", label: "Tudo", count: totalCount },
            { id: "proposals", label: "Propostas", count: proposalsList.length, icon: <GitPullRequest size={13} /> },
            { id: "drafts", label: "Rascunhos", count: draftInboxItems.length, icon: <FileText size={13} /> }
          ]}
        />
        <div style={{ position: "relative", flex: "1 1 220px", maxWidth: 320 }}>
          <Search size={14} style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: "var(--text-muted)" }} />
          <input
            className="noema-input"
            style={{ width: "100%", paddingLeft: 32 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por título, ID ou autor..."
            aria-label="Buscar na caixa de entrada"
          />
        </div>
      </div>

      <section className="noema-card noema-card-flush">
        {visibleCount === 0 ? (
          <EmptyState
            icon={<Inbox size={20} />}
            title={totalCount === 0 ? "Tudo em dia" : "Nada encontrado"}
            description={
              totalCount === 0
                ? "Nenhuma proposta ou rascunho aguardando revisão. Novos itens aparecem aqui em tempo real."
                : "Ajuste o filtro ou a busca para ver outros itens."
            }
          />
        ) : (
          <div className="noema-list">
            {showProposals &&
              proposals.map((p) => {
                const title = p.itemJson?.title ?? p.title ?? p.itemId;
                const isAgent = p.actorType === "agent";
                const busy = busyId === p.proposalId;
                return (
                  <div
                    key={p.proposalId}
                    className="noema-list-row clickable"
                    onClick={() =>
                      onInspect({
                        title,
                        subtitle: `${p.proposalId} • ${p.requestedBy}`,
                        body: p.itemJson?.content ?? "",
                        itemId: p.itemId || p.proposalId,
                        status: (p.status as KnowledgeStatus) ?? "draft",
                        meta: p as unknown as Record<string, unknown>
                      })
                    }
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 9,
                          flexShrink: 0,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          background: "rgba(99,102,241,0.12)",
                          color: "#a5b4fc"
                        }}
                      >
                        <GitPullRequest size={15} />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <strong className="noema-truncate" style={{ fontSize: 13.5, fontWeight: 550 }}>{title}</strong>
                          <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", marginTop: 3, flexWrap: "wrap" }}>
                          <span className="noema-mono">{p.proposalId}</span>
                          <span>·</span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            {isAgent ? <Bot size={12} /> : <User size={12} />}
                            {p.requestedBy}
                          </span>
                          {p.createdAt && (
                            <>
                              <span>·</span>
                              <span>{relativeTime(p.createdAt)}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="noema-btn noema-btn-success noema-btn-sm"
                        disabled={busy}
                        onClick={() => void run(p.proposalId, () => onProposalDecision(p.proposalId, "approve"))}
                      >
                        <CheckCircle2 size={13} /> Aprovar
                      </button>
                      <button
                        className="noema-btn noema-btn-ghost noema-btn-sm"
                        disabled={busy}
                        title="Solicitar alterações"
                        onClick={() => void run(p.proposalId, () => onProposalDecision(p.proposalId, "request_changes"))}
                      >
                        <RotateCcw size={13} /> <span className="noema-hide-mobile">Revisar</span>
                      </button>
                      <button
                        className="noema-btn noema-btn-danger noema-btn-sm noema-btn-icon"
                        disabled={busy}
                        title="Rejeitar"
                        aria-label="Rejeitar proposta"
                        onClick={() => void run(p.proposalId, () => onProposalDecision(p.proposalId, "reject"))}
                      >
                        <XCircle size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            {showDrafts &&
              drafts.map((item) => {
                const busy = busyId === item.id;
                return (
                  <div
                    key={item.id}
                    className="noema-list-row clickable"
                    onClick={() =>
                      onInspect({
                        title: item.title,
                        subtitle: `${item.id} • ${item.sourceUri}`,
                        body: item.content,
                        itemId: item.id,
                        status: item.status as KnowledgeStatus,
                        meta: item as unknown as Record<string, unknown>
                      })
                    }
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: 1 }}>
                      <span
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 9,
                          flexShrink: 0,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          background: "rgba(245,158,11,0.12)",
                          color: "#fbbf24"
                        }}
                      >
                        <FileText size={15} />
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          <strong className="noema-truncate" style={{ fontSize: 13.5, fontWeight: 550 }}>{item.title}</strong>
                          <Badge tone="warning">rascunho</Badge>
                          <Badge tone="neutral">{item.accessPolicyId}</Badge>
                        </div>
                        <div className="noema-truncate" style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
                          <span className="noema-mono">{item.id}</span> · {item.sourceUri}
                        </div>
                      </div>
                    </div>
                    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="noema-btn noema-btn-success noema-btn-sm"
                        disabled={busy}
                        onClick={() => void run(item.id, () => onChangeItemStatus(item.id, "approved"))}
                      >
                        <CheckCircle2 size={13} /> Aprovar
                      </button>
                      <button
                        className="noema-btn noema-btn-danger noema-btn-sm"
                        disabled={busy}
                        onClick={() => void run(item.id, () => onChangeItemStatus(item.id, "deprecated"))}
                      >
                        <XCircle size={13} /> <span className="noema-hide-mobile">Deprecar</span>
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </section>
    </div>
  );
}
