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

export function getProviderColor(modelOrProvider: string): string {
  const s = modelOrProvider.toLowerCase();
  if (s.includes("anthropic") || s.includes("claude")) return "#a855f7"; // violet
  if (s.includes("openai") || s.includes("gpt") || s.includes("o1") || s.includes("o3")) return "#10b981"; // emerald
  if (s.includes("google") || s.includes("gemini")) return "#f59e0b"; // amber
  if (s.includes("ollama") || s.includes("llama") || s.includes("qwen") || s.includes("deepseek") || s.includes("local")) return "#38bdf8"; // sky
  return "#6366f1"; // indigo
}

export function FinOpsBarChart({
  models,
  metric = "tokens"
}: {
  models: Array<{
    model: string;
    totalTokens: number | null;
    providerCostUsd: number | null;
    calls?: number;
    provider?: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
  }>;
  metric?: "tokens" | "usd" | "calls" | "stacked_tokens";
}) {
  const data = models.map((m) => {
    const prompt = m.promptTokens ?? m.inputTokens ?? 0;
    const completion = m.completionTokens ?? m.outputTokens ?? 0;
    const total = m.totalTokens ?? prompt + completion;
    const calls = m.calls ?? 1;
    const usd = Number((m.providerCostUsd ?? 0).toFixed(4));
    const provider = m.provider ?? (m.model.startsWith("ollama:") ? "Ollama (Local)" : m.model.startsWith("claude") ? "Anthropic" : m.model.startsWith("gpt") ? "OpenAI" : "LLM Provedor");
    return {
      name: m.model.length > 20 ? `${m.model.slice(0, 18)}…` : m.model,
      fullName: m.model,
      provider,
      tokens: total,
      promptTokens: prompt,
      completionTokens: completion,
      usd,
      calls,
      color: getProviderColor(m.provider || m.model)
    };
  });

  if (data.length === 0) {
    return (
      <div style={{ height: 210, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12.5, gap: 6 }}>
        <span>Sem execuções ou telemetria registradas para os filtros atuais</span>
      </div>
    );
  }

  const formatYAxis = (val: number) => {
    if (metric === "usd") return `$${val < 1 ? val.toFixed(3) : val.toFixed(1)}`;
    if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
    if (val >= 1_000) return `${(val / 1_000).toFixed(0)}k`;
    return String(val);
  };

  return (
    <div style={{ width: "100%", height: 240 }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 12, right: 12, left: -4, bottom: 6 }}>
          <CartesianGrid stroke="rgba(148,163,184,0.08)" vertical={false} />
          <XAxis dataKey="name" stroke="#64748b" fontSize={11} tickLine={false} />
          <YAxis stroke="#64748b" fontSize={11} tickFormatter={formatYAxis} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{
              background: "rgba(15, 23, 42, 0.95)",
              border: "1px solid rgba(148,163,184,0.22)",
              borderRadius: 10,
              fontSize: 12,
              boxShadow: "0 12px 28px rgba(0,0,0,0.45)",
              padding: "10px 12px"
            }}
            formatter={(value: unknown, name?: string | number) => {
              const num = Number(value ?? 0);
              const label = String(name ?? "");
              if (label === "usd" || metric === "usd") return [`$${num.toFixed(4)} USD`, "Custo Provedor"];
              if (label === "calls" || metric === "calls") return [num.toLocaleString("pt-BR"), "Chamadas"];
              if (label === "promptTokens") return [num.toLocaleString("pt-BR"), "Prompt (Entrada)"];
              if (label === "completionTokens") return [num.toLocaleString("pt-BR"), "Completion (Saída)"];
              return [num.toLocaleString("pt-BR"), "Tokens Totais"];
            }}
            labelFormatter={(label: unknown, payload?: readonly { payload?: { fullName?: string; provider?: string } }[]) => {
              const item = payload?.[0]?.payload;
              return `${item?.fullName ?? label} (${item?.provider ?? "Provedor"})`;
            }}
          />
          {metric === "stacked_tokens" ? (
            <>
              <Bar dataKey="promptTokens" name="promptTokens" fill="#6366f1" stackId="tokens" radius={[0, 0, 0, 0]} />
              <Bar dataKey="completionTokens" name="completionTokens" fill="#38bdf8" stackId="tokens" radius={[6, 6, 0, 0]} />
            </>
          ) : (
            <Bar
              dataKey={metric === "usd" ? "usd" : metric === "calls" ? "calls" : "tokens"}
              radius={[6, 6, 0, 0]}
            >
              {data.map((entry, idx) => (
                <Cell key={`bar-${idx}`} fill={entry.color} />
              ))}
            </Bar>
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function FinOpsCostCompositionChart({
  providerCostUsd,
  computeCostUsd,
  energyCostUsd
}: {
  providerCostUsd: number;
  computeCostUsd: number;
  energyCostUsd: number;
}) {
  const total = providerCostUsd + computeCostUsd + energyCostUsd;
  const data = [
    { name: "Inferência / Provedores LLM", value: Number(providerCostUsd.toFixed(4)), color: "#6366f1" },
    { name: "Infraestrutura & Computação", value: Number(computeCostUsd.toFixed(4)), color: "#38bdf8" },
    { name: "Energia Elétrica & ESG", value: Number(energyCostUsd.toFixed(4)), color: "#10b981" }
  ].filter((d) => d.value > 0);

  if (total <= 0 || data.length === 0) {
    return (
      <div style={{ height: 210, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 12 }}>
        Sem dados suficientes de custos para compor o gráfico
      </div>
    );
  }

  return (
    <div style={{ width: "100%", height: 220, position: "relative" }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={56}
            outerRadius={84}
            paddingAngle={4}
            stroke="transparent"
          >
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: "rgba(15, 23, 42, 0.95)",
              border: "1px solid rgba(148,163,184,0.22)",
              borderRadius: 10,
              fontSize: 12,
              boxShadow: "0 12px 28px rgba(0,0,0,0.45)"
            }}
            formatter={(value: unknown) => {
              const num = Number(value ?? 0);
              const pct = total > 0 ? ((num / total) * 100).toFixed(1) : "0";
              return [`$${num.toFixed(4)} USD (${pct}%)`, "Fatia"];
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          textAlign: "center",
          pointerEvents: "none"
        }}
      >
        <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500, letterSpacing: "0.02em" }}>TOTAL</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
          ${total < 0.01 ? total.toFixed(4) : total.toFixed(3)}
        </div>
      </div>
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
        const stroke =
          e.relation === "VERIFIED_BY"
            ? "rgba(16, 185, 129, 0.72)"
            : e.relation === "IMPACTS"
              ? "rgba(245, 158, 11, 0.65)"
              : "rgba(99, 102, 241, 0.48)";
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        return (
          <g key={`${e.from}-${e.to}-${i}`}>
            <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={stroke} strokeWidth={1.6} />
            <text
              x={mx}
              y={my - 3}
              textAnchor="middle"
              fill={e.relation === "VERIFIED_BY" ? "#6ee7b7" : "#94a3b8"}
              fontSize={7.5}
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {e.relation}
            </text>
          </g>
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

