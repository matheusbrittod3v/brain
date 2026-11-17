"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ApiFetchFn, NotifyFn } from "../../../lib/types";
import { Badge } from "../../UiPrimitives";
import type { AccessWorkspaceData } from "../AccessWorkspace";

function slugifyRoleId(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

const ROLE_PRESETS: Array<{ label: string; description: string; match: (id: string) => boolean }> = [
  {
    label: "Somente Leitura",
    description: "Menus básicos + visualização e busca de conhecimento",
    match: (id) =>
      ["menu:projects", "menu:knowledge", "menu:search", "knowledge:view", "knowledge:read", "knowledge:search"].includes(id)
  },
  {
    label: "Desenvolvedor",
    description: "Leitura, criação de conhecimento, runner e handoffs",
    match: (id) =>
      id.startsWith("knowledge:") && id !== "knowledge:approve" && id !== "knowledge:delete"
        ? true
        : ["menu:projects", "menu:knowledge", "menu:search", "menu:agents", "menu:inbox", "runner:execute", "proposals:create"].includes(id)
  },
  {
    label: "Líder Técnico",
    description: "Desenvolvedor + aprovações, operações e integrações",
    match: (id) => !id.startsWith("roles:") && !id.startsWith("users:") && id !== "audit:export"
  }
];

export function RolesTab(props: {
  projectId: string;
  data?: AccessWorkspaceData;
  apiFetch: ApiFetchFn;
  queryClient: QueryClient;
  notify: NotifyFn;
}) {
  const { projectId, data, apiFetch, queryClient, notify } = props;
  const rolesList = data?.rolesList ?? [];
  const permissionsCatalog = data?.permissionsCatalog ?? [];
  const policyCatalog = data?.profile?.policyCatalog ?? [];

  const [mode, setMode] = useState<"create" | "edit">("create");
  const [roleSearch, setRoleSearch] = useState("");
  const [permSearch, setPermSearch] = useState("");
  const [permScopeFilter, setPermScopeFilter] = useState<"all" | "menus" | "functions">("all");
  const [idTouched, setIdTouched] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [roleFormId, setRoleFormId] = useState("");
  const [roleFormName, setRoleFormName] = useState("");
  const [roleFormDesc, setRoleFormDesc] = useState("");
  const [roleFormPolicies, setRoleFormPolicies] = useState<string[]>(["public-org", "internal-project"]);
  const [customPolicyInput, setCustomPolicyInput] = useState("");
  const [roleFormPerms, setRoleFormPerms] = useState<string[]>([
    "menu:projects",
    "menu:knowledge",
    "menu:search",
    "knowledge:view",
    "knowledge:read",
    "knowledge:search"
  ]);

  const filteredRoles = useMemo(() => {
    const q = roleSearch.trim().toLowerCase();
    if (!q) return rolesList;
    return rolesList.filter(
      (r) => r.name.toLowerCase().includes(q) || r.roleId.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
    );
  }, [rolesList, roleSearch]);

  const permissionGroups = useMemo(() => {
    const q = permSearch.trim().toLowerCase();
    const groups = new Map<string, Array<{ id: string; group: string; label: string }>>();
    for (const perm of permissionsCatalog) {
      if (permScopeFilter === "menus" && !perm.id.startsWith("menu:")) continue;
      if (permScopeFilter === "functions" && perm.id.startsWith("menu:")) continue;
      if (q && !perm.label.toLowerCase().includes(q) && !perm.id.toLowerCase().includes(q) && !perm.group.toLowerCase().includes(q)) {
        continue;
      }
      const list = groups.get(perm.group) ?? [];
      list.push(perm);
      groups.set(perm.group, list);
    }
    return [...groups.entries()];
  }, [permissionsCatalog, permSearch, permScopeFilter]);

  const availablePolicies = useMemo(() => {
    const set = new Set<string>(policyCatalog.map((p) => p.policyId));
    for (const p of roleFormPolicies) set.add(p);
    if (set.size === 0) {
      set.add("public-org");
      set.add("internal-project");
    }
    return [...set];
  }, [policyCatalog, roleFormPolicies]);

  function startNewRole() {
    setMode("create");
    setIdTouched(false);
    setConfirmDeleteId(null);
    setRoleFormId("");
    setRoleFormName("");
    setRoleFormDesc("");
    setRoleFormPolicies(["public-org", "internal-project"]);
    setRoleFormPerms(["menu:projects", "menu:knowledge", "menu:search", "knowledge:view", "knowledge:read", "knowledge:search"]);
  }

  function loadRoleIntoEditor(r: AccessWorkspaceData["rolesList"][number]) {
    setMode("edit");
    setIdTouched(true);
    setConfirmDeleteId(null);
    setRoleFormId(r.roleId);
    setRoleFormName(r.name);
    setRoleFormDesc(r.description);
    setRoleFormPolicies(r.allowedPolicies);
    setRoleFormPerms(r.permissions);
  }

  function handleSaveRole() {
    const rid = (roleFormId || slugifyRoleId(roleFormName)).trim().toLowerCase();
    if (!rid) return notify("Informe o nome ou ID do cargo (ex.: qa-lead).", "error");
    setSaving(true);
    void apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/access/roles/${encodeURIComponent(rid)}`, {
      method: "PUT",
      body: JSON.stringify({
        name: roleFormName.trim() || rid,
        description: roleFormDesc.trim(),
        permissions: roleFormPerms,
        allowedPolicies: roleFormPolicies
      })
    })
      .then(() => {
        notify(`Cargo '${roleFormName.trim() || rid}' salvo com ${roleFormPerms.length} permissões.`);
        setMode("edit");
        setRoleFormId(rid);
        setIdTouched(true);
        return queryClient.invalidateQueries({ queryKey: ["access"] });
      })
      .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setSaving(false));
  }

  function handleDeleteRole(roleId: string) {
    void apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/access/roles/${encodeURIComponent(roleId)}`, {
      method: "DELETE"
    })
      .then(() => {
        notify(`Cargo '${roleId}' removido.`);
        if (roleFormId === roleId) startNewRole();
        setConfirmDeleteId(null);
        return queryClient.invalidateQueries({ queryKey: ["access"] });
      })
      .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"));
  }

  const editingRole = rolesList.find((r) => r.roleId === roleFormId);

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
      {/* Coluna Esquerda: Lista de Cargos */}
      <div
        className="noema-card"
        style={{
          flex: "1 1 260px",
          maxWidth: 360,
          minWidth: 250,
          display: "flex",
          flexDirection: "column",
          gap: 10
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: 13 }}>Cargos ({rolesList.length})</strong>
          <button className="noema-btn noema-btn-primary" style={{ fontSize: 12, padding: "5px 10px" }} onClick={startNewRole}>
            + Novo Cargo
          </button>
        </div>
        <input
          className="noema-input"
          value={roleSearch}
          onChange={(e) => setRoleSearch(e.target.value)}
          placeholder="Buscar cargo..."
          style={{ fontSize: 12 }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 540, overflowY: "auto" }}>
          {filteredRoles.map((r) => {
            const active = mode === "edit" && roleFormId === r.roleId;
            return (
              <button
                key={r.roleId}
                type="button"
                onClick={() => loadRoleIntoEditor(r)}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: active ? "1px solid #60a5fa" : "1px solid var(--border-subtle)",
                  background: active ? "rgba(59,130,246,0.14)" : "var(--bg-inset)",
                  color: "inherit",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <strong style={{ fontSize: 13 }}>{r.name}</strong>
                  <Badge tone={r.isSystem ? "accent" : "success"}>{r.isSystem ? "Sistema" : "Custom"}</Badge>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                  {r.description || "Sem descrição"}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {r.permissions.length} permissões · {r.allowedPolicies.length} políticas
                </div>
              </button>
            );
          })}
          {filteredRoles.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 4px" }}>Nenhum cargo encontrado.</div>
          )}
        </div>
      </div>

      {/* Coluna Direita: Editor do Cargo */}
      <div
        className="noema-card"
        style={{
          flex: "2 1 440px",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 14
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>
              {mode === "edit" ? `Editando: ${roleFormName || roleFormId}` : "Criar Novo Cargo"}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {roleFormPerms.length} de {permissionsCatalog.length} permissões selecionadas
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {mode === "edit" && (
              <button
                className="noema-btn noema-btn-ghost"
                style={{ fontSize: 12 }}
                onClick={() => {
                  setMode("create");
                  setIdTouched(false);
                  const copyName = `${roleFormName || roleFormId} (Cópia)`;
                  setRoleFormName(copyName);
                  setRoleFormId(slugifyRoleId(copyName));
                }}
              >
                Duplicar
              </button>
            )}
            {mode === "edit" && editingRole && !editingRole.isSystem && (
              confirmDeleteId === editingRole.roleId ? (
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    className="noema-btn noema-btn-ghost"
                    style={{ fontSize: 12, color: "#f87171", borderColor: "#f87171" }}
                    onClick={() => handleDeleteRole(editingRole.roleId)}
                  >
                    Confirmar exclusão
                  </button>
                  <button className="noema-btn noema-btn-ghost" style={{ fontSize: 12 }} onClick={() => setConfirmDeleteId(null)}>
                    Cancelar
                  </button>
                </div>
              ) : (
                <button
                  className="noema-btn noema-btn-ghost"
                  style={{ fontSize: 12, color: "#f87171" }}
                  onClick={() => setConfirmDeleteId(editingRole.roleId)}
                >
                  Excluir
                </button>
              )
            )}
          </div>
        </div>

        {/* Metadados básicos */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>
            Nome do Cargo
            <input
              className="noema-input"
              value={roleFormName}
              onChange={(e) => {
                const nextName = e.target.value;
                setRoleFormName(nextName);
                if (mode === "create" && !idTouched) {
                  setRoleFormId(slugifyRoleId(nextName));
                }
              }}
              placeholder="Ex.: Líder de QA"
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>
            ID (slug automático)
            <input
              className="noema-input"
              value={roleFormId}
              disabled={mode === "edit"}
              onChange={(e) => {
                setIdTouched(true);
                setRoleFormId(e.target.value);
              }}
              placeholder="ex.: lider-de-qa"
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--text-secondary)" }}>
            Descrição
            <input
              className="noema-input"
              value={roleFormDesc}
              onChange={(e) => setRoleFormDesc(e.target.value)}
              placeholder="Resumo das responsabilidades"
            />
          </label>
        </div>

        {/* Políticas com chips clicáveis */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 600 }}>Políticas de Acesso Permitidas</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            {availablePolicies.map((polId) => {
              const selected = roleFormPolicies.includes(polId);
              return (
                <button
                  key={polId}
                  type="button"
                  onClick={() =>
                    setRoleFormPolicies((prev) =>
                      selected ? prev.filter((x) => x !== polId) : [...new Set([...prev, polId])]
                    )
                  }
                  style={{
                    fontSize: 12,
                    padding: "4px 10px",
                    borderRadius: 999,
                    cursor: "pointer",
                    border: selected ? "1px solid #34d399" : "1px solid var(--border-subtle)",
                    background: selected ? "rgba(16,185,129,0.16)" : "var(--bg-inset)",
                    color: selected ? "#6ee7b7" : "var(--text-secondary)"
                  }}
                >
                  {selected ? "✓ " : ""}{polId}
                </button>
              );
            })}
            <div style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <input
                className="noema-input"
                value={customPolicyInput}
                onChange={(e) => setCustomPolicyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customPolicyInput.trim()) {
                    e.preventDefault();
                    const p = customPolicyInput.trim();
                    setRoleFormPolicies((prev) => [...new Set([...prev, p])]);
                    setCustomPolicyInput("");
                  }
                }}
                placeholder="+ política custom"
                style={{ width: 135, fontSize: 11, padding: "4px 8px" }}
              />
            </div>
          </div>
        </div>

        {/* Presets rápidos + filtro de permissões */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
            paddingTop: 6,
            borderTop: "1px solid var(--border-subtle)"
          }}
        >
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Modelos rápidos:</span>
            {ROLE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                title={preset.description}
                className="noema-btn noema-btn-ghost"
                style={{ fontSize: 11, padding: "4px 8px" }}
                onClick={() => setRoleFormPerms(permissionsCatalog.filter((p) => preset.match(p.id)).map((p) => p.id))}
              >
                {preset.label}
              </button>
            ))}
            <button
              type="button"
              className="noema-btn noema-btn-ghost"
              style={{ fontSize: 11, padding: "4px 8px" }}
              onClick={() => setRoleFormPerms(permissionsCatalog.map((p) => p.id))}
            >
              Tudo
            </button>
            <button
              type="button"
              className="noema-btn noema-btn-ghost"
              style={{ fontSize: 11, padding: "4px 8px" }}
              onClick={() => setRoleFormPerms([])}
            >
              Limpar
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="noema-input"
            value={permSearch}
            onChange={(e) => setPermSearch(e.target.value)}
            placeholder="Filtrar permissões (ex.: menu, approve, runner)..."
            style={{ flex: "1 1 200px", fontSize: 12 }}
          />
          <div style={{ display: "flex", gap: 4 }}>
            {(
              [
                { id: "all", label: "Todas" },
                { id: "menus", label: "Menus" },
                { id: "functions", label: "Módulos & Funções" }
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`noema-btn ${permScopeFilter === tab.id ? "noema-btn-primary" : "noema-btn-ghost"}`}
                style={{ fontSize: 11, padding: "5px 9px" }}
                onClick={() => setPermScopeFilter(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Grupos de permissões */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10 }}>
          {permissionGroups.map(([groupName, perms]) => {
            const selectedInGroup = perms.filter((p) => roleFormPerms.includes(p.id)).length;
            const allSelected = selectedInGroup === perms.length && perms.length > 0;
            return (
              <div
                key={groupName}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid var(--border-subtle)",
                  background: "var(--bg-inset)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <strong style={{ fontSize: 12, color: "#93c5fd" }}>{groupName}</strong>
                  <button
                    type="button"
                    onClick={() => {
                      const groupIds = perms.map((p) => p.id);
                      setRoleFormPerms((prev) =>
                        allSelected
                          ? prev.filter((id) => !groupIds.includes(id))
                          : [...new Set([...prev, ...groupIds])]
                      );
                    }}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: allSelected ? "#6ee7b7" : "var(--text-muted)",
                      fontSize: 11,
                      cursor: "pointer",
                      padding: 0
                    }}
                  >
                    {selectedInGroup}/{perms.length} · {allSelected ? "Desmarcar" : "Marcar"}
                  </button>
                </div>
                {perms.map((p) => (
                  <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={roleFormPerms.includes(p.id)}
                      onChange={(e) =>
                        setRoleFormPerms((prev) =>
                          e.target.checked ? [...new Set([...prev, p.id])] : prev.filter((x) => x !== p.id)
                        )
                      }
                    />
                    <span>{p.label}</span>
                  </label>
                ))}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
          <button className="noema-btn noema-btn-primary" disabled={saving} onClick={handleSaveRole}>
            {saving ? "Salvando..." : mode === "edit" ? "Atualizar Cargo" : "Criar Cargo"}
          </button>
        </div>
      </div>
    </div>
  );
}

