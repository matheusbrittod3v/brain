"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

const COLORS = ["#6366f1", "#38bdf8", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6"];

export function HealthDonutChart({
  approved,
  draft,
  untested
}: {
  approved: number;
  draft: number;
  untested: number;
}) {
  const data = [
    { name: "Aprovados", value: Math.max(0, approved - untested), color: "#10b981" },
    { name: "Rascunhos", value: draft, color: "#f59e0b" },
    { name: "Sem Teste", value: untested, color: "#ef4444" }
  ].filter((d) => d.value > 0);

  if (data.length === 0) {
    return (
      <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 }}>
        Sem itens indexados neste projeto
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: 190 }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius={48} outerRadius={74} paddingAngle={3}>
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.color} stroke="transparent" />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: "#0f172a",
              border: "1px solid rgba(148,163,184,0.25)",
              borderRadius: 8,
              fontSize: 12
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function FinOpsBarChart({
  models
}: {
  models: Array<{ model: string; totalTokens: number | null; providerCostUsd: number | null }>;
}) {
  const data = models.map((m) => ({
    name: m.model.slice(0, 18),
    tokens: m.totalTokens ?? 0,
    usd: Number((m.providerCostUsd ?? 0).toFixed(4))
  }));

  if (data.length === 0) {
    return (
      <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 }}>
        Sem execuções registradas ainda
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: 210 }}>
      <ResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid stroke="rgba(148,163,184,0.1)" vertical={false} />
          <XAxis dataKey="name" stroke="#64748b" fontSize={11} />
          <YAxis stroke="#64748b" fontSize={11} />
          <Tooltip
            contentStyle={{
              background: "#0f172a",
              border: "1px solid rgba(148,163,184,0.25)",
              borderRadius: 8,
              fontSize: 12
            }}
          />
          <Bar dataKey="tokens" fill="#6366f1" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DomainDistributionChart({
  items
}: {
  items: Array<{ name: string; count: number }>;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ width: "100%", height: 210 }}>
      <ResponsiveContainer>
        <BarChart data={items} layout="vertical" margin={{ left: 10, right: 16 }}>
          <CartesianGrid stroke="rgba(148,163,184,0.08)" horizontal={false} />
          <XAxis type="number" stroke="#64748b" fontSize={11} />
          <YAxis dataKey="name" type="category" stroke="#94a3b8" fontSize={11} width={110} />
          <Tooltip
            contentStyle={{
              background: "#0f172a",
              border: "1px solid rgba(148,163,184,0.25)",
              borderRadius: 8,
              fontSize: 12
            }}
          />
          <Bar dataKey="count" radius={[0, 6, 6, 0]}>
            {items.map((entry, idx) => (
              <Cell key={entry.name} fill={COLORS[idx % COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function InteractiveGraphCanvas({
  nodes,
  edges,
  onSelectNode
}: {
  nodes: Array<{ id: string; title?: string; type?: string; status?: string }>;
  edges: Array<{ from: string; to: string; relation: string }>;
  onSelectNode?: (id: string) => void;
}) {
  const visibleNodes = nodes.slice(0, 18);
  if (visibleNodes.length === 0) {
    return (
      <div style={{ height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 }}>
        Nenhum nó no grafo para exibir
      </div>
    );
  }
  const width = 640;
  const height = 280;
  const cx = width / 2;
  const cy = height / 2;
  const rx = 240;
  const ry = 104;

  const coords = new Map<string, { x: number; y: number }>();
  visibleNodes.forEach((n, idx) => {
    const angle = (idx / visibleNodes.length) * Math.PI * 2 - Math.PI / 2;
    coords.set(n.id, {
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry
    });
  });

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: 280, background: "rgba(6,9,19,0.55)", borderRadius: 12, border: "1px solid var(--border-subtle)" }}>
      {edges.map((e, i) => {
        const p1 = coords.get(e.from);
        const p2 = coords.get(e.to);
        if (!p1 || !p2) return null;
        return (
          <line
            key={`${e.from}-${e.to}-${i}`}
            x1={p1.x}
            y1={p1.y}
            x2={p2.x}
            y2={p2.y}
            stroke="rgba(99, 102, 241, 0.38)"
            strokeWidth={1.4}
          />
        );
      })}
      {visibleNodes.map((n) => {
        const pos = coords.get(n.id)!;
        const fill = n.status === "approved" ? "#10b981" : n.status === "draft" ? "#f59e0b" : "#38bdf8";
        return (
          <g key={n.id} style={{ cursor: onSelectNode ? "pointer" : "default" }} onClick={() => onSelectNode?.(n.id)}>
            <circle cx={pos.x} cy={pos.y} r={14} fill="rgba(15,23,42,0.95)" stroke={fill} strokeWidth={2.2} />
            <circle cx={pos.x} cy={pos.y} r={5} fill={fill} />
            <text
              x={pos.x}
              y={pos.y + 25}
              textAnchor="middle"
              fill="#cbd5e1"
              fontSize={9.5}
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {(n.id.length > 14 ? `${n.id.slice(0, 12)}…` : n.id)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

