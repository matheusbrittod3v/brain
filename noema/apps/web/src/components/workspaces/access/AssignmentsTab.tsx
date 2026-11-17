"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { ApiFetchFn, NotifyFn } from "../../../lib/types";
import { Badge } from "../../UiPrimitives";
import type { AccessWorkspaceData } from "../AccessWorkspace";

const PRESET_AGENTS = ["codex", "antigravity", "claude-code", "*"];

export function AssignmentsTab(props: {
  projectId: string;
  data?: AccessWorkspaceData;
  apiFetch: ApiFetchFn;
  queryClient: QueryClient;
  notify: NotifyFn;
}) {
  const { projectId, data, apiFetch, queryClient, notify } = props;
  const rolesList = data?.rolesList ?? [];
  const assignments = data?.assignments ?? [];

  const knownUsers = useMemo(() => {
    const ids = new Set<string>(["local-dev"]);
    for (const m of data?.members ?? []) ids.add(m.actorId);
    for (const a of assignments) ids.add(a.userId);
    return [...ids];
  }, [data?.members, assignments]);

  const [assignUserId, setAssignUserId] = useState("local-dev");
  const [assignRoleIds, setAssignRoleIds] = useState<string[]>(["admin"]);
  const [assignAgents, setAssignAgents] = useState<string[]>(["codex", "antigravity", "*"]);
  const [customAgentInput, setCustomAgentInput] = useState("");
  const [assignInheritAgent, setAssignInheritAgent] = useState(true);
  const [saving, setSaving] = useState(false);

  const availableAgentChips = useMemo(() => {
    return [...new Set([...PRESET_AGENTS, ...assignAgents])];
  }, [assignAgents]);

  function handleSaveAssignment() {
    const uid = assignUserId.trim();
    if (!uid) return notify("Informe ou selecione um usuário.", "error");
    setSaving(true);
    void apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/access/assignments/${encodeURIComponent(uid)}`, {
      method: "PUT",
      body: JSON.stringify({
        roleIds: assignRoleIds,
        linkedAgentIds: assignAgents,
        inheritUserPermissions: assignInheritAgent
      })
    })
      .then(() => {
        notify(`Vínculo de '${uid}' salvo.`);
        return queryClient.invalidateQueries({ queryKey: ["access"] });
      })
      .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setSaving(false));
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* Formulário rápido */}
      <div className="noema-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Vincular Usuário, Cargos & Agentes</div>

        {/* Usuário com quick picks */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 600 }}>Usuário</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <input
              className="noema-input"
              list="noema-known-users"
              value={assignUserId}
              onChange={(e) => setAssignUserId(e.target.value)}
              placeholder="Selecione ou digite um usuário"
              style={{ flex: "1 1 200px", maxWidth: 280 }}
            />
            <datalist id="noema-known-users">
              {knownUsers.map((uid) => (
                <option key={uid} value={uid} />
              ))}
            </datalist>
            {knownUsers.slice(0, 6).map((uid) => (
              <button
                key={uid}
                type="button"
                onClick={() => {
                  setAssignUserId(uid);
                  const existing = assignments.find((a) => a.userId === uid);
                  if (existing) {
                    setAssignRoleIds(existing.roleIds);
                    setAssignAgents(existing.linkedAgentIds);
                    setAssignInheritAgent(existing.inheritUserPermissions);
                  }
                }}
                style={{
                  fontSize: 11,
                  padding: "4px 9px",
                  borderRadius: 999,
                  cursor: "pointer",
                  border: assignUserId === uid ? "1px solid #60a5fa" : "1px solid var(--border-subtle)",
                  background: assignUserId === uid ? "rgba(59,130,246,0.16)" : "var(--bg-inset)",
                  color: assignUserId === uid ? "#93c5fd" : "var(--text-secondary)"
                }}
              >
                {uid}
              </button>
            ))}
          </div>
        </div>

        {/* Cargos como chips clicáveis */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 600 }}>Cargos atribuídos</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {rolesList.map((r) => {
              const selected = assignRoleIds.includes(r.roleId);
              return (
                <button
                  key={r.roleId}
                  type="button"
                  onClick={() =>
                    setAssignRoleIds((prev) =>
                      selected ? prev.filter((x) => x !== r.roleId) : [...new Set([...prev, r.roleId])]
                    )
                  }
                  style={{
                    fontSize: 12,
                    padding: "5px 10px",
                    borderRadius: 999,
                    cursor: "pointer",
                    border: selected ? "1px solid #60a5fa" : "1px solid var(--border-subtle)",
                    background: selected ? "rgba(59,130,246,0.16)" : "var(--bg-inset)",
                    color: selected ? "#bfdbfe" : "var(--text-secondary)"
                  }}
                >
                  {selected ? "✓ " : ""}{r.name}
                </button>
              );
            })}
          </div>
        </div>

        {/* Agentes vinculados como chips clicáveis */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-secondary)", fontWeight: 600 }}>Agentes vinculados</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            {availableAgentChips.map((ag) => {
              const selected = assignAgents.includes(ag);
              return (
                <button
                  key={ag}
                  type="button"
                  onClick={() =>
                    setAssignAgents((prev) => (selected ? prev.filter((x) => x !== ag) : [...new Set([...prev, ag])]))
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
                  {selected ? "✓ " : ""}{ag === "*" ? "* (todos)" : ag}
                </button>
              );
            })}
            <input
              className="noema-input"
              value={customAgentInput}
              onChange={(e) => setCustomAgentInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customAgentInput.trim()) {
                  e.preventDefault();
                  const val = customAgentInput.trim();
                  setAssignAgents((prev) => [...new Set([...prev, val])]);
                  setCustomAgentInput("");
                }
              }}
              placeholder="+ outro agente"
              style={{ width: 130, fontSize: 11, padding: "4px 8px" }}
            />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={assignInheritAgent} onChange={(e) => setAssignInheritAgent(e.target.checked)} />
            <span>Agente vinculado herda tudo que o usuário pode fazer (sem separação humano/IA)</span>
          </label>
          <button className="noema-btn noema-btn-primary" disabled={saving} onClick={handleSaveAssignment}>
            {saving ? "Salvando..." : "Salvar Atribuição"}
          </button>
        </div>
      </div>

      {/* Lista de vínculos */}
      <div className="noema-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <strong style={{ fontSize: 13 }}>Vínculos Ativos ({assignments.length})</strong>
        {assignments.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Nenhum vínculo configurado ainda.</div>
        )}
        {assignments.map((a) => (
          <div
            key={a.userId}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid var(--border-subtle)",
              background: "var(--bg-inset)"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12 }}>
              <strong style={{ fontSize: 13 }}>{a.userId}</strong>
              {a.roleIds.map((rid) => (
                <Badge key={rid} tone="accent">{rid}</Badge>
              ))}
              <Badge tone={a.inheritUserPermissions ? "success" : "neutral"}>
                {a.inheritUserPermissions ? "Agente herda usuário" : "Somente usuário"}
              </Badge>
              {a.linkedAgentIds.map((ag) => (
                <Badge key={ag} tone="neutral">agente: {ag}</Badge>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="noema-btn noema-btn-ghost"
                style={{ fontSize: 12 }}
                onClick={() => {
                  setAssignUserId(a.userId);
                  setAssignRoleIds(a.roleIds);
                  setAssignAgents(a.linkedAgentIds);
                  setAssignInheritAgent(a.inheritUserPermissions);
                }}
              >
                Editar
              </button>
              <button
                className="noema-btn noema-btn-ghost"
                style={{ color: "#f87171", fontSize: 12 }}
                onClick={() => {
                  void apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/access/assignments/${encodeURIComponent(a.userId)}`, {
                    method: "DELETE"
                  })
                    .then(() => {
                      notify(`Atribuição de '${a.userId}' removida.`);
                      return queryClient.invalidateQueries({ queryKey: ["access"] });
                    })
                    .catch((e) => notify(e instanceof Error ? e.message : String(e), "error"));
                }}
              >
                Remover
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

