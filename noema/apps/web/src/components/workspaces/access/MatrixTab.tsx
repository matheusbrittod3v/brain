"use client";

import type { QueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type { ApiFetchFn, NotifyFn } from "../../../lib/types";
import type { AccessWorkspaceData } from "../AccessWorkspace";

export function MatrixTab(props: {
  projectId: string;
  data?: AccessWorkspaceData;
  apiFetch: ApiFetchFn;
  queryClient: QueryClient;
  notify: NotifyFn;
}) {
  const { projectId, data, apiFetch, queryClient, notify } = props;
  const roles = data?.rolesList ?? [];
  const permissionsCatalog = data?.permissionsCatalog ?? [];
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "menus" | "functions">("all");
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<string, Array<{ id: string; group: string; label: string }>>();
    for (const p of permissionsCatalog) {
      if (scope === "menus" && !p.id.startsWith("menu:")) continue;
      if (scope === "functions" && p.id.startsWith("menu:")) continue;
      if (q && !p.label.toLowerCase().includes(q) && !p.id.toLowerCase().includes(q) && !p.group.toLowerCase().includes(q)) {
        continue;
      }
      const list = map.get(p.group) ?? [];
      list.push(p);
      map.set(p.group, list);
    }
    return [...map.entries()];
  }, [permissionsCatalog, search, scope]);

  function toggleCell(role: AccessWorkspaceData["rolesList"][number], permId: string) {
    const hasPerm = role.permissions.includes(permId);
    const nextPerms = hasPerm ? role.permissions.filter((p) => p !== permId) : [...role.permissions, permId];
    const key = `${role.roleId}:${permId}`;
    setUpdatingKey(key);
    void apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/access/roles/${encodeURIComponent(role.roleId)}`, {
      method: "PUT",
      body: JSON.stringify({
        name: role.name,
        description: role.description,
        permissions: nextPerms,
        allowedPolicies: role.allowedPolicies
      })
    })
      .then(() => {
        notify(`${role.name}: '${permId}' ${hasPerm ? "removida" : "concedida"}.`);
        return queryClient.invalidateQueries({ queryKey: ["access"] });
      })
      .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setUpdatingKey(null));
  }

  return (
    <div className="noema-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Matriz de Permissões (Cargos × Recursos)</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Clique em qualquer célula para conceder ou revogar uma permissão diretamente no cargo.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="noema-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrar permissão..."
            style={{ width: 200, fontSize: 12 }}
          />
          <div style={{ display: "flex", gap: 4 }}>
            {(
              [
                { id: "all", label: "Todas" },
                { id: "menus", label: "Menus" },
                { id: "functions", label: "Funções" }
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`noema-btn ${scope === opt.id ? "noema-btn-primary" : "noema-btn-ghost"}`}
                style={{ fontSize: 11, padding: "5px 9px" }}
                onClick={() => setScope(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ overflowX: "auto", border: "1px solid var(--border-subtle)", borderRadius: 10 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 620 }}>
          <thead>
            <tr style={{ background: "var(--bg-inset)", borderBottom: "1px solid var(--border-subtle)" }}>
              <th style={{ textAlign: "left", padding: "10px 12px", color: "var(--text-secondary)", fontWeight: 600 }}>
                Recurso / Permissão
              </th>
              {roles.map((r) => (
                <th
                  key={r.roleId}
                  style={{
                    textAlign: "center",
                    padding: "10px 10px",
                    color: "var(--text-primary)",
                    fontWeight: 600,
                    minWidth: 105
                  }}
                >
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    {r.isSystem && <Lock size={11} color="#94a3b8" />}
                    <span>{r.name}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 400 }}>{r.permissions.length} perms</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grouped.map(([groupName, perms]) => (
              <Fragment key={`grp-${groupName}`}>
                <tr style={{ background: "rgba(99,102,241,0.08)" }}>
                  <td
                    colSpan={roles.length + 1}
                    style={{
                      padding: "6px 12px",
                      fontSize: 11,
                      fontWeight: 700,
                      color: "#93c5fd",
                      letterSpacing: "0.04em",
                      textTransform: "uppercase"
                    }}
                  >
                    {groupName}
                  </td>
                </tr>
                {perms.map((p) => (
                  <tr key={p.id} style={{ borderBottom: "1px solid rgba(148,163,184,0.08)" }}>
                    <td style={{ padding: "8px 12px" }}>
                      <div style={{ fontWeight: 500, color: "var(--text-primary)" }}>{p.label}</div>
                      <div className="noema-mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>
                        {p.id}
                      </div>
                    </td>
                    {roles.map((r) => {
                      const active = r.permissions.includes(p.id);
                      const busy = updatingKey === `${r.roleId}:${p.id}`;
                      return (
                        <td key={`${r.roleId}-${p.id}`} style={{ textAlign: "center", padding: "6px 8px" }}>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => toggleCell(r, p.id)}
                            title={`${r.name}: ${p.label}`}
                            style={{
                              width: 28,
                              height: 24,
                              borderRadius: 7,
                              border: active ? "1px solid rgba(16,185,129,0.5)" : "1px solid var(--border-subtle)",
                              background: active ? "rgba(16,185,129,0.18)" : "var(--bg-inset)",
                              color: active ? "#34d399" : "var(--text-muted)",
                              cursor: busy ? "wait" : "pointer",
                              fontSize: 12,
                              fontWeight: 700
                            }}
                          >
                            {busy ? "…" : active ? "✓" : "—"}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
