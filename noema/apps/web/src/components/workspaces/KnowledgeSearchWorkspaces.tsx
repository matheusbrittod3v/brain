"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { FileSearch, Network, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { InspectedItemState, KnowledgeStatus, SearchHit } from "../../lib/types";
import { InteractiveGraphCanvas } from "../Charts";
import { DataTable } from "../DataTable";
import { Badge, DropzoneCard, EmptyState, Segmented, SectionCard, statusTone } from "../UiPrimitives";

const STATUS_OPTIONS: KnowledgeStatus[] = ["draft", "approved", "deprecated", "superseded"];
const STATUS_LABEL: Record<KnowledgeStatus, string> = {
  draft: "Rascunho",
  approved: "Aprovado",
  deprecated: "Deprecado",
  superseded: "Substituído"
};

function toInspected(hit: SearchHit): InspectedItemState {
  return {
    title: hit.item.title,
    subtitle: `${hit.item.id} • ${hit.item.sourceUri}`,
    body: hit.item.content,
    itemId: hit.item.id,
    status: hit.item.status as KnowledgeStatus,
    meta: hit.item as unknown as Record<string, unknown>
  };
}

export function KnowledgeWorkspace(props: {
  hits: SearchHit[];
  onFileDrop: (file: File) => Promise<void>;
  onChangeItemStatus: (itemId: string, status: KnowledgeStatus) => Promise<void>;
  onInspect: (item: InspectedItemState) => void;
}) {
  const { hits, onFileDrop, onChangeItemStatus, onInspect } = props;
  const [statusFilter, setStatusFilter] = useState<"all" | KnowledgeStatus>("all");

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const h of hits) c[h.item.status] = (c[h.item.status] ?? 0) + 1;
    return c;
  }, [hits]);

  const filtered = useMemo(
    () => (statusFilter === "all" ? hits : hits.filter((h) => h.item.status === statusFilter)),
    [hits, statusFilter]
  );

  const knowledgeColumns: ColumnDef<SearchHit, unknown>[] = [
    {
      header: "Título",
      accessorFn: (row) => row.item.title,
      cell: ({ row }) => (
        <div style={{ minWidth: 200 }}>
          <div style={{ fontWeight: 550 }}>{row.original.item.title}</div>
          <div className="noema-mono" style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
            {row.original.item.id}
          </div>
        </div>
      )
    },
    {
      header: "Tipo",
      accessorFn: (row) => row.item.type,
      cell: ({ row }) => <Badge tone="accent">{row.original.item.type}</Badge>
    },
    {
      header: "Status",
      accessorFn: (row) => row.item.status,
      cell: ({ row }) => {
        const st = row.original.item.status as KnowledgeStatus;
        const tone = statusTone(st);
        const color = tone === "success" ? "#34d399" : tone === "warning" ? "#fbbf24" : tone === "danger" ? "#f87171" : "#cbd5e1";
        return (
          <div onClick={(e) => e.stopPropagation()}>
            <select
              className="noema-input"
              aria-label={`Status de ${row.original.item.id}`}
              value={st}
              onChange={(e) => void onChangeItemStatus(row.original.item.id, e.target.value as KnowledgeStatus)}
              style={{ padding: "4px 8px", fontSize: 12, minWidth: 120, color, fontWeight: 550 }}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
        );
      }
    },
    {
      header: "Política",
      accessorFn: (row) => row.item.accessPolicyId,
      cell: ({ row }) => <Badge tone="neutral">{row.original.item.accessPolicyId}</Badge>
    }
  ];

  return (
    <div className="noema-stack">
      <DropzoneCard
        label="Ingerir documento"
        hint="Markdown, YAML, JSON, TXT, PDF ou DOCX — segredos e PII são verificados antes de salvar"
        accept=".md,.yaml,.yml,.txt,.json,.pdf,.docx"
        onFileSelected={(file) => void onFileDrop(file)}
      />
      <SectionCard>
        <DataTable
          data={filtered}
          columns={knowledgeColumns}
          searchPlaceholder="Filtrar por título, ID ou tipo..."
          emptyText="Nenhum item de conhecimento"
          onRowClick={(hit) => onInspect(toInspected(hit))}
          toolbar={
            <Segmented<"all" | KnowledgeStatus>
              ariaLabel="Filtrar por status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { id: "all", label: "Todos", count: hits.length },
                { id: "approved", label: "Aprovados", count: counts.approved ?? 0 },
                { id: "draft", label: "Rascunhos", count: counts.draft ?? 0 },
                { id: "deprecated", label: "Deprecados", count: counts.deprecated ?? 0 }
              ]}
            />
          }
        />
      </SectionCard>
    </div>
  );
}

export function SearchGraphWorkspace(props: {
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  hits: SearchHit[];
  graphNodes?: Array<{ id: string; title?: string; type?: string; status?: string }>;
  graphEdges: Array<{ from: string; to: string; relation: string }>;
  onInspect: (item: InspectedItemState) => void;
}) {
  const { searchQuery, onSearchQueryChange, hits, graphNodes, graphEdges, onInspect } = props;
  const nodes = graphNodes && graphNodes.length > 0 ? graphNodes : hits.map((h) => h.item);

  return (
    <div className="noema-stack">
      <div
        className="noema-card"
        style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 8px 6px 16px", borderColor: searchQuery ? "rgba(129,140,248,0.45)" : undefined }}
      >
        <Search size={17} color="#818cf8" />
        <input
          autoFocus
          className="noema-input"
          style={{ flex: 1, border: "none", background: "transparent", padding: "10px 0", fontSize: 15, boxShadow: "none" }}
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          placeholder="Pergunte ou busque: regras de negócio, ADRs, símbolos de código..."
          aria-label="Busca semântica"
        />
        {searchQuery && (
          <button className="noema-btn noema-btn-ghost noema-btn-sm noema-btn-icon" onClick={() => onSearchQueryChange("")} aria-label="Limpar busca">
            <X size={14} />
          </button>
        )}
        <Badge tone="accent">{hits.length} resultados</Badge>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(360px, 100%), 1fr))", gap: 14, alignItems: "start" }}>
        <SectionCard title="Resultados" subtitle="Ordenados por relevância híbrida (lexical + vetorial + grafo)" icon={<FileSearch size={15} />} flush>
          {hits.length === 0 ? (
            <EmptyState
              icon={<Search size={18} />}
              title={searchQuery ? "Nenhum resultado" : "Comece a digitar"}
              description={searchQuery ? "Tente termos diferentes ou mais genéricos." : "Os resultados aparecem em tempo real conforme você digita."}
            />
          ) : (
            <div className="noema-list" style={{ maxHeight: 560, overflowY: "auto" }}>
              {hits.slice(0, 40).map((h) => (
                <div key={h.item.id} className="noema-list-row clickable" style={{ alignItems: "flex-start" }} onClick={() => onInspect(toInspected(h))}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <strong className="noema-truncate" style={{ fontSize: 13.5, fontWeight: 550 }}>{h.item.title}</strong>
                      <Badge tone={statusTone(h.item.status)}>{h.item.status}</Badge>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        marginTop: 4,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden"
                      }}
                    >
                      {h.item.content}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "center" }}>
                      <span className="noema-mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{h.item.id}</span>
                      <Badge tone="neutral">{h.item.type}</Badge>
                    </div>
                  </div>
                  {typeof (h as { score?: number }).score === "number" && (
                    <span className="noema-mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {((h as { score?: number }).score ?? 0).toFixed(2)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Grafo interativo" subtitle={`${nodes.length} nós · ${graphEdges.length} arestas — clique em um nó para inspecionar`} icon={<Network size={15} />}>
          {nodes.length === 0 ? (
            <EmptyState icon={<Network size={18} />} title="Grafo vazio" description="Ingira conhecimento para visualizar as relações." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <InteractiveGraphCanvas
                nodes={nodes}
                edges={graphEdges}
                onSelectNode={(id) => {
                  const hit = hits.find((h) => h.item.id === id);
                  if (hit) onInspect(toInspected(hit));
                }}
              />
              {graphEdges.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)" }}>
                    Arestas ({graphEdges.length})
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 160, overflowY: "auto" }}>
                    {graphEdges.map((edge, idx) => (
                      <div
                        key={`${edge.from}-${edge.relation}-${edge.to}-${idx}`}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "4px 9px",
                          borderRadius: 8,
                          border: "1px solid var(--border-subtle)",
                          background: "var(--bg-inset)",
                          fontSize: 11.5
                        }}
                      >
                        <span className="noema-mono" style={{ color: "var(--text-primary)" }}>{edge.from}</span>
                        <Badge tone={edge.relation === "VERIFIED_BY" ? "success" : edge.relation === "IMPACTS" ? "warning" : "accent"}>
                          {edge.relation}
                        </Badge>
                        <span className="noema-mono" style={{ color: "var(--text-secondary)" }}>{edge.to}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
