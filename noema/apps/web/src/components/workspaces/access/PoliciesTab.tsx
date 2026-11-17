"use client";

import { DataTable } from "../../DataTable";
import { Badge } from "../../UiPrimitives";
import type { AccessWorkspaceData } from "../AccessWorkspace";

export function PoliciesTab(props: { data?: AccessWorkspaceData }) {
  const { data } = props;
  const effectivePerms = data?.profile?.effectivePermissions ?? [];
  const policyCatalog = data?.profile?.policyCatalog ?? [];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="noema-card">
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>
          Catálogo de Políticas & Acesso ({effectivePerms.length} permissões ativas para o ator atual)
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          {policyCatalog.map((pol) => (
            <div
              key={pol.policyId}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--border-subtle)",
                background: "var(--bg-inset)"
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <strong style={{ fontSize: 13 }}>{pol.policyId}</strong>
                <Badge tone={pol.authorized ? "success" : "neutral"}>{pol.authorized ? "Autorizada" : "Restrita"}</Badge>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{pol.description}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{pol.itemCount} itens</div>
            </div>
          ))}
        </div>
      </div>

      <div className="noema-card">
        <DataTable
          data={data?.members ?? []}
          columns={[
            { header: "Ator", accessorKey: "actorId" },
            { header: "Papéis", accessorFn: (r) => r.roles.join(", ") },
            { header: "Políticas", accessorFn: (r) => r.allowedPolicies.join(", ") }
          ]}
          searchPlaceholder="Filtrar membros..."
        />
      </div>
    </div>
  );
}

