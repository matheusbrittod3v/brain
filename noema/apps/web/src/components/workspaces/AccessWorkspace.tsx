"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ApiFetchFn, NotifyFn } from "../../lib/types";
import { Badge, Segmented } from "../UiPrimitives";
import { AssignmentsTab } from "./access/AssignmentsTab";
import { MatrixTab } from "./access/MatrixTab";
import { PoliciesTab } from "./access/PoliciesTab";
import { RolesTab } from "./access/RolesTab";

export interface AccessWorkspaceData {
  profile: {
    roles: string[];
    effectivePermissions?: string[];
    policyCatalog: Array<{ policyId: string; description: string; authorized: boolean; itemCount: number }>;
  };
  members: Array<{ actorId: string; roles: string[]; allowedPolicies: string[]; syncedWithKeycloak: boolean }>;
  permissionsCatalog: Array<{ id: string; group: string; label: string }>;
  rolesList: Array<{
    roleId: string;
    name: string;
    description: string;
    permissions: string[];
    allowedPolicies: string[];
    isSystem?: boolean;
  }>;
  assignments: Array<{
    userId: string;
    roleIds: string[];
    linkedAgentIds: string[];
    inheritUserPermissions: boolean;
  }>;
}

export function AccessWorkspace(props: {
  projectId: string;
  data?: AccessWorkspaceData;
  apiFetch: ApiFetchFn;
  queryClient: QueryClient;
  notify: NotifyFn;
}) {
  const { projectId, data, apiFetch, queryClient, notify } = props;
  const [activeTab, setActiveTab] = useState<"roles" | "matrix" | "assignments" | "policies">("roles");

  const rolesCount = data?.rolesList?.length ?? 0;
  const assignmentsCount = data?.assignments?.length ?? 0;
  const policiesCount = data?.profile?.policyCatalog?.length ?? 0;
  const effectiveCount = data?.profile?.effectivePermissions?.length ?? 0;

  return (
    <div className="noema-stack">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <Segmented
          ariaLabel="Seções de acesso"
          value={activeTab}
          onChange={setActiveTab}
          options={[
            { id: "roles", label: "Cargos", count: rolesCount },
            { id: "matrix", label: "Matriz" },
            { id: "assignments", label: "Usuários & Agentes", count: assignmentsCount },
            { id: "policies", label: "Políticas & Membros", count: policiesCount }
          ]}
        />
        <Badge tone="accent">{effectiveCount} permissões ativas para você</Badge>
      </div>

      {activeTab === "roles" && (
        <RolesTab projectId={projectId} data={data} apiFetch={apiFetch} queryClient={queryClient} notify={notify} />
      )}
      {activeTab === "matrix" && (
        <MatrixTab projectId={projectId} data={data} apiFetch={apiFetch} queryClient={queryClient} notify={notify} />
      )}
      {activeTab === "assignments" && (
        <AssignmentsTab projectId={projectId} data={data} apiFetch={apiFetch} queryClient={queryClient} notify={notify} />
      )}
      {activeTab === "policies" && <PoliciesTab data={data} />}
    </div>
  );
}
