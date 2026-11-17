"use client";

import { Radar, ShieldCheck, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { DataTable } from "../DataTable";
import { Badge, EmptyState, SectionCard, Segmented, StatCard } from "../UiPrimitives";

export function TemplatesWorkspace(props: {
  recommendations: Array<{ id: string; title: string; sourceUri: string; summary?: string }>;
  note?: string;
}) {
  const { recommendations, note } = props;

  if (recommendations.length === 0) {
    return (
      <section className="noema-card">
        <EmptyState
          icon={<Wand2 size={18} />}
          title="Nenhuma recomendação"
          description={note ?? "Aprove ADRs e padrões de arquitetura para receber templates de scaffold aqui."}
        />
      </section>
    );
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(300px, 100%), 1fr))", gap: 12 }}>
      {recommendations.map((rec) => (
        <article key={rec.id} className="noema-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(99,102,241,0.12)",
                color: "#a5b4fc",
                flexShrink: 0
              }}
            >
              <Wand2 size={15} />
            </span>
            <strong style={{ fontSize: 14, fontWeight: 600, minWidth: 0 }} className="noema-truncate">
              {rec.title}
            </strong>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", flex: 1 }}>{rec.summary ?? "Padrão aprovado de arquitetura interna."}</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span className="noema-mono noema-truncate" style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {rec.sourceUri}
            </span>
            <Badge tone="accent">{rec.id}</Badge>
          </div>
        </article>
      ))}
    </div>
  );
}

const RING_TONE: Record<string, "success" | "accent" | "warning" | "danger" | "neutral"> = {
  adopt: "success",
  trial: "accent",
  assess: "warning",
  hold: "danger"
};

export function EnterpriseWorkspace(props: {
  coverageRows: Array<{ ruleId: string; title: string; priority: string; covered: boolean }>;
  coveragePercent?: number;
  techRadar: Array<{ id: string; title: string; ring: string; quadrant: string }>;
}) {
  const { coverageRows, coveragePercent, techRadar } = props;
  const [coverageFilter, setCoverageFilter] = useState<"all" | "covered" | "uncovered">("all");

  const covered = coverageRows.filter((r) => r.covered).length;
  const pct = coveragePercent ?? (coverageRows.length ? Math.round((covered / coverageRows.length) * 100) : 0);
  const rows = useMemo(
    () => coverageRows.filter((r) => (coverageFilter === "all" ? true : coverageFilter === "covered" ? r.covered : !r.covered)),
    [coverageRows, coverageFilter]
  );

  const radarByRing = useMemo(() => {
    const m = new Map<string, typeof techRadar>();
    for (const t of techRadar) {
      const k = t.ring.toLowerCase();
      m.set(k, [...(m.get(k) ?? []), t]);
    }
    return ["adopt", "trial", "assess", "hold", ...[...m.keys()].filter((k) => !RING_TONE[k])]
      .filter((k) => m.has(k))
      .map((k) => [k, m.get(k)!] as const);
  }, [techRadar]);

  return (
    <div className="noema-stack">
      <div className="noema-grid-stats">
        <StatCard
          label="Cobertura de regras"
          value={`${pct}%`}
          tone={pct >= 80 ? "success" : pct >= 50 ? "warning" : "danger"}
          progress={pct}
          icon={<ShieldCheck size={16} />}
        />
        <StatCard label="Regras cobertas" value={covered} tone="success" hint={`de ${coverageRows.length} regras`} />
        <StatCard label="Sem teste" value={coverageRows.length - covered} tone="danger" hint="Prioridade para QA" />
      </div>

      <SectionCard title="Matriz de cobertura de regras" subtitle="Regras de negócio × testes verificados no HEAD da main">
        <DataTable
          data={rows}
          emptyText="Nenhuma regra registrada"
          toolbar={
            <Segmented
              value={coverageFilter}
              onChange={setCoverageFilter}
              options={[
                { id: "all", label: "Todas", count: coverageRows.length },
                { id: "covered", label: "Cobertas", count: covered },
                { id: "uncovered", label: "Sem teste", count: coverageRows.length - covered }
              ]}
            />
          }
          columns={[
            {
              header: "Regra",
              accessorKey: "title",
              cell: ({ row }) => (
                <div>
                  <div style={{ fontWeight: 550 }}>{row.original.title}</div>
                  <div className="noema-mono" style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    {row.original.ruleId}
                  </div>
                </div>
              )
            },
            {
              header: "Prioridade",
              accessorKey: "priority",
              cell: ({ row }) => (
                <Badge tone={/high|critical|alta/i.test(row.original.priority) ? "danger" : "neutral"}>{row.original.priority}</Badge>
              )
            },
            {
              header: "Cobertura",
              accessorKey: "covered",
              cell: ({ row }) => (
                <Badge tone={row.original.covered ? "success" : "danger"} dot>
                  {row.original.covered ? "Coberta" : "Sem teste"}
                </Badge>
              )
            }
          ]}
          searchPlaceholder="Filtrar regras..."
        />
      </SectionCard>

      {techRadar.length > 0 && (
        <SectionCard title="Tech Radar" subtitle="Tecnologias agrupadas por anel de adoção" icon={<Radar size={15} />}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            {radarByRing.map(([ring, items]) => (
              <div key={ring} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <Badge tone={RING_TONE[ring] ?? "neutral"}>{ring.toUpperCase()}</Badge>
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{items.length}</span>
                </div>
                {items.map((item) => (
                  <div key={item.id} style={{ padding: "9px 11px", borderRadius: 9, border: "1px solid var(--border-subtle)", background: "var(--bg-inset)" }}>
                    <div style={{ fontSize: 13, fontWeight: 550 }}>{item.title}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{item.quadrant}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </SectionCard>
      )}
    </div>
  );
}
