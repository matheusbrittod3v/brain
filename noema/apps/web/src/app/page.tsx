"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  Bot,
  CheckCircle2,
  Command as CommandIcon,
  FileText,
  FolderGit2,
  FolderPlus,
  Inbox,
  KeyRound,
  Menu,
  Network,
  Plug,
  Radar,
  Search,
  Shield,
  Sparkles,
  Wand2,
  X,
  Zap
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CommandPalette } from "../components/CommandPalette";
import { Badge, Field, PageHeader, Segmented, SlideOverDrawer, statusTone } from "../components/UiPrimitives";
import { AccessWorkspace, type AccessWorkspaceData } from "../components/workspaces/AccessWorkspace";
import { AgentsWorkspace, ImpactWorkspace } from "../components/workspaces/AgentsImpactWorkspaces";
import { InboxWorkspace } from "../components/workspaces/InboxWorkspace";
import { KnowledgeWorkspace, SearchGraphWorkspace } from "../components/workspaces/KnowledgeSearchWorkspaces";
import { IntegrationsWorkspace, OperationsWorkspace } from "../components/workspaces/OperationsIntegrationsWorkspaces";
import { ProjectsWorkspace } from "../components/workspaces/ProjectsWorkspace";
import { EnterpriseWorkspace, TemplatesWorkspace } from "../components/workspaces/TemplatesEnterpriseWorkspaces";
import { useNoemaRealtime } from "../hooks/useNoemaRealtime";
import {
  normalizeSearchHits,
  type InspectedItemState,
  type KnowledgeHitItem,
  type KnowledgeStatus,
  type ProposalItem,
  type SearchHit,
  type WorkspaceId
} from "../lib/types";

const WORKSPACES: ReadonlyArray<{ id: WorkspaceId; label: string; icon: ReactNode; section: "Principal" | "Engenharia & IA" | "Governança" }> = [
  { id: "inbox", label: "Caixa de Entrada", icon: <Inbox size={15} />, section: "Principal" },
  { id: "projects", label: "Projetos", icon: <FolderGit2 size={15} />, section: "Principal" },
  { id: "knowledge", label: "Conhecimento", icon: <FileText size={15} />, section: "Principal" },
  { id: "search", label: "Busca & Grafo", icon: <Network size={15} />, section: "Principal" },
  { id: "agents", label: "Agentes & Runner", icon: <Bot size={15} />, section: "Engenharia & IA" },
  { id: "impact", label: "Impacto", icon: <Zap size={15} />, section: "Engenharia & IA" },
  { id: "integrations", label: "Integrações", icon: <Plug size={15} />, section: "Engenharia & IA" },
  { id: "templates", label: "Templates", icon: <Wand2 size={15} />, section: "Engenharia & IA" },
  { id: "operations", label: "Operação & FinOps", icon: <Activity size={15} />, section: "Governança" },
  { id: "access", label: "Acesso & Políticas", icon: <Shield size={15} />, section: "Governança" },
  { id: "enterprise", label: "Visões Corporativas", icon: <Radar size={15} />, section: "Governança" }
];

const WORKSPACE_DESCRIPTIONS: Record<WorkspaceId, string> = {
  inbox: "Propostas e rascunhos aguardando revisão humana — aprove, peça ajustes ou rejeite.",
  projects: "Visão geral da saúde do conhecimento e ingestão de repositórios do projeto.",
  knowledge: "Todo o conhecimento indexado: regras, ADRs, documentos e código.",
  search: "Busca híbrida (lexical + vetorial + grafo) e exploração visual de relações.",
  agents: "Delegue tarefas autônomas ao Brain Runner e acompanhe as execuções.",
  impact: "Descubra o que é afetado antes de alterar uma regra, ADR ou símbolo.",
  integrations: "Canais conectados e responsáveis de fallback para aprovações.",
  operations: "Consumo de modelos, custos, cotas por departamento e trilha de auditoria.",
  access: "Cargos, permissões granulares e vínculos entre usuários e seus agentes.",
  templates: "Templates de scaffold derivados de padrões de arquitetura aprovados.",
  enterprise: "Cobertura de regras por testes e Tech Radar corporativo."
};

export default function CommandCenterPage() {
  const queryClient = useQueryClient();
  const [workspace, setWorkspace] = useState<WorkspaceId>("projects");
  const [apiUrl, setApiUrl] = useState("http://localhost:3333");
  const [apiKey, setApiKey] = useState("change-me-local-dev-key");
  const [projectId, setProjectId] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [newProjectModalOpen, setNewProjectModalOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [inspectedItem, setInspectedItem] = useState<InspectedItemState | null>(null);

  const [newProjectSlug, setNewProjectSlug] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const savedUrl = window.localStorage.getItem("noema.apiUrl");
    const savedKey = window.localStorage.getItem("noema.apiKey");
    const savedProj = window.localStorage.getItem("noema.projectId");
    if (savedUrl) setApiUrl(savedUrl);
    if (savedKey) setApiKey(savedKey);
    if (savedProj) setProjectId(savedProj);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 260);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const notify = useCallback((text: string, tone: "info" | "error" = "info") => setToast({ text, tone }), []);

  const apiFetch = useCallback(
    async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(`${apiUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...(init?.headers ?? {})
        }
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
      if (!res.ok) {
        throw new Error(data.error?.message ?? `HTTP ${res.status}`);
      }
      return data;
    },
    [apiUrl, apiKey]
  );

  const wsStatus = useNoemaRealtime({ apiUrl, apiKey, projectId, apiFetch, queryClient });

  const projectsQuery = useQuery({
    queryKey: ["projects", apiUrl, apiKey],
    queryFn: () => apiFetch<{ projects: Array<{ projectId: string; name: string; description?: string; knowledgeRoot: string }> }>("/v1/projects"),
    enabled: Boolean(apiKey)
  });

  useEffect(() => {
    const projects = projectsQuery.data?.projects ?? [];
    if (projects.length === 0) return;
    if (!projectId || !projects.some((p) => p.projectId === projectId)) {
      const firstId = projects[0]!.projectId;
      setProjectId(firstId);
      window.localStorage.setItem("noema.projectId", firstId);
    }
  }, [projectsQuery.data, projectId]);

  const accessQuery = useQuery({
    queryKey: ["access", apiUrl, apiKey, projectId],
    queryFn: async (): Promise<AccessWorkspaceData> => {
      const [profile, members, permissionsCatalog, rolesRes, assignmentsRes] = await Promise.all([
        apiFetch<AccessWorkspaceData["profile"]>(`/v1/projects/${encodeURIComponent(projectId)}/access/profile`),
        apiFetch<{ members: AccessWorkspaceData["members"] }>(`/v1/projects/${encodeURIComponent(projectId)}/access/members`).catch(() => ({ members: [] })),
        apiFetch<{ permissions: AccessWorkspaceData["permissionsCatalog"] }>(`/v1/projects/${encodeURIComponent(projectId)}/access/permissions`).catch(() => ({ permissions: [] })),
        apiFetch<{ roles: AccessWorkspaceData["rolesList"] }>(`/v1/projects/${encodeURIComponent(projectId)}/access/roles`).catch(() => ({ roles: [] })),
        apiFetch<{ assignments: AccessWorkspaceData["assignments"] }>(`/v1/projects/${encodeURIComponent(projectId)}/access/assignments`).catch(() => ({ assignments: [] }))
      ]);
      return {
        profile,
        members: members.members,
        permissionsCatalog: permissionsCatalog.permissions,
        rolesList: rolesRes.roles,
        assignments: assignmentsRes.assignments
      };
    },
    enabled: Boolean(apiKey && projectId)
  });

  const effectivePerms = accessQuery.data?.profile?.effectivePermissions ?? [];
  const can = useCallback(
    (perm: string) => effectivePerms.length === 0 || effectivePerms.includes(perm),
    [effectivePerms]
  );

  const overviewQuery = useQuery({
    queryKey: ["overview", apiUrl, apiKey, projectId],
    queryFn: () =>
      apiFetch<{
        projectId: string;
        totalItems: number;
        approvedCount: number;
        draftCount: number;
        health: { healthScore?: number; untestedRuleIds?: string[]; staleItemIds?: string[]; gitVsConnectorConflicts?: unknown[] };
        alerts: string[];
      }>(`/v1/projects/${encodeURIComponent(projectId)}/overview`),
    enabled: Boolean(apiKey && projectId),
    refetchInterval: 30_000
  });

  const proposalsQuery = useQuery({
    queryKey: ["proposals", apiUrl, apiKey, projectId],
    queryFn: () => apiFetch<{ proposals: ProposalItem[] }>(`/v1/projects/${encodeURIComponent(projectId)}/proposals`),
    enabled: Boolean(apiKey && projectId && can("proposals:view")),
    refetchInterval: 30_000
  });

  const searchQueryRes = useQuery({
    queryKey: ["search", apiUrl, apiKey, projectId, debouncedQuery],
    queryFn: async () => {
      const raw = await apiFetch<{ items?: KnowledgeHitItem[]; hits?: SearchHit[] }>(
        `/v1/projects/${encodeURIComponent(projectId)}/search`,
        { method: "POST", body: JSON.stringify({ query: debouncedQuery, limit: 100 }) }
      );
      return { hits: normalizeSearchHits(raw) };
    },
    enabled: Boolean(apiKey && projectId && (can("knowledge:search") || can("knowledge:view")))
  });

  const graphRootId = searchQueryRes.data?.hits?.[0]?.item.id ?? "BR-1";

  const graphQuery = useQuery({
    queryKey: ["graph", apiUrl, apiKey, projectId, graphRootId],
    queryFn: () =>
      apiFetch<{ nodes?: Array<{ id: string; title?: string; type?: string; status?: string }>; edges: Array<{ from: string; to: string; relation: string }> }>(
        `/v1/projects/${encodeURIComponent(projectId)}/graph?rootId=${encodeURIComponent(graphRootId)}&depth=2`
      ),
    enabled: Boolean(apiKey && projectId && can("knowledge:search"))
  });

  const runnerQuery = useQuery({
    queryKey: ["runner", apiUrl, apiKey, projectId],
    queryFn: () =>
      apiFetch<{ tasks: Array<{ taskId: string; instruction: string; status: string; priority: string; resultSummary?: string; createdAt: string }> }>(
        `/v1/projects/${encodeURIComponent(projectId)}/runner/tasks`
      ),
    enabled: Boolean(apiKey && projectId && can("runner:view")),
    refetchInterval: 20_000
  });

  const integrationsQuery = useQuery({
    queryKey: ["integrations", apiUrl, apiKey, projectId],
    queryFn: () =>
      apiFetch<{
        github: { state: string; privateRepoAuthConfigured: boolean; recentJobs: Array<{ jobId: string; owner: string; repo: string; ref: string; state: string; createdAt: string }> };
        saas: { state: string };
        notificationChannels: Array<{ provider: string; configured: boolean }>;
      }>(`/v1/projects/${encodeURIComponent(projectId)}/integrations/status`),
    enabled: Boolean(apiKey && projectId && can("integrations:view"))
  });

  const finopsQuery = useQuery({
    queryKey: ["finops", apiUrl, apiKey, projectId],
    queryFn: () =>
      apiFetch<{
        indexedItems: number;
        estimatedLocalTokens: number;
        modelUsage: { calls: number; byModel: Array<{ model: string; totalTokens: number | null; providerCostUsd: number | null }> };
        infrastructureEstimate: { totalInfraAndEnergyUsd: number };
      }>(`/v1/projects/${encodeURIComponent(projectId)}/finops`),
    enabled: Boolean(apiKey && projectId && can("finops:view"))
  });

  const auditQuery = useQuery({
    queryKey: ["audit", apiUrl, apiKey, projectId],
    queryFn: () =>
      apiFetch<{
        logs?: Array<{ id?: string; timestamp?: string; createdAt?: string; actorId: string; action: string; targetType: string; targetId: string }>;
        events?: Array<{ timestamp?: string; createdAt?: string; actorId: string; action: string; targetType: string; targetId: string }>;
      }>(`/v1/audit-logs?projectId=${encodeURIComponent(projectId)}&limit=50`),
    enabled: Boolean(apiKey && projectId && can("audit:view"))
  });

  const scaffoldQuery = useQuery({
    queryKey: ["scaffold", apiUrl, apiKey, projectId],
    queryFn: () =>
      apiFetch<{ recommendations: Array<{ id: string; title: string; sourceUri: string; summary?: string }>; note?: string }>(
        `/v1/projects/${encodeURIComponent(projectId)}/scaffold/recommendations`
      ),
    enabled: Boolean(apiKey && projectId && can("templates:view"))
  });

  const enterpriseQuery = useQuery({
    queryKey: ["enterprise", apiUrl, apiKey, projectId],
    queryFn: () =>
      apiFetch<{
        techRadar: Array<{ id: string; title: string; ring: string; quadrant: string }>;
        qaCoverage?: { coveragePercent: number; rows: Array<{ ruleId: string; title: string; priority: string; covered: boolean }> };
        coverageMatrix?: Array<{ ruleId: string; title: string; priority: string; covered: boolean }>;
      }>(`/v1/projects/${encodeURIComponent(projectId)}/enterprise/views`),
    enabled: Boolean(apiKey && projectId && can("enterprise:view"))
  });

  async function handleCreateProject() {
    const slug = newProjectSlug.trim();
    if (!slug) return notify("Informe um slug (ex.: staf-web).", "error");
    try {
      const res = await apiFetch<{ created: boolean }>("/v1/projects", {
        method: "POST",
        body: JSON.stringify({ projectId: slug, name: newProjectName.trim() || slug, description: newProjectDesc.trim() || undefined })
      });
      setProjectId(slug);
      window.localStorage.setItem("noema.projectId", slug);
      setNewProjectModalOpen(false);
      setNewProjectSlug("");
      setNewProjectName("");
      setNewProjectDesc("");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["overview"] });
      notify(res.created ? `Projeto '${slug}' criado.` : `Projeto '${slug}' atualizado.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function handleProposalDecision(proposalId: string, decision: "approve" | "reject" | "request_changes", proposalVersion = 1) {
    try {
      await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/approvals/${encodeURIComponent(proposalId)}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision, proposalVersion })
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["proposals"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["search"] })
      ]);
      notify(`Proposta ${proposalId}: ${decision}`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function handleChangeItemStatus(itemId: string, status: KnowledgeStatus) {
    try {
      await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/knowledge/${encodeURIComponent(itemId)}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      setInspectedItem((prev) => (prev?.itemId === itemId ? { ...prev, status } : prev));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["search"] }),
        queryClient.invalidateQueries({ queryKey: ["overview"] }),
        queryClient.invalidateQueries({ queryKey: ["proposals"] }),
        queryClient.invalidateQueries({ queryKey: ["enterprise"] }),
        queryClient.invalidateQueries({ queryKey: ["audit"] })
      ]);
      notify(`Status de '${itemId}' alterado para '${status}'.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  async function handleFileDrop(file: File) {
    try {
      if (/\.(md|txt|ya?ml|json)$/i.test(file.name)) {
        const text = await file.text();
        await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/ingest`, {
          method: "POST",
          body: JSON.stringify({ filePath: `.brain/inbox/${file.name}`, rawContent: text })
        });
      } else {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
        await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/ingest-document`, {
          method: "POST",
          body: JSON.stringify({ filename: file.name, contentBase64: btoa(binary) })
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["search"] });
      await queryClient.invalidateQueries({ queryKey: ["overview"] });
      notify(`Arquivo '${file.name}' ingerido com sucesso.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  const domainDistribution = useMemo(() => {
    const counts = new Map<string, number>();
    for (const hit of searchQueryRes.data?.hits ?? []) {
      counts.set(hit.item.type, (counts.get(hit.item.type) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count })).slice(0, 6);
  }, [searchQueryRes.data]);

  const projectsList = projectsQuery.data?.projects ?? [];
  const proposalsList = proposalsQuery.data?.proposals ?? [];
  const proposalIdsSet = useMemo(() => new Set(proposalsList.map((p) => p.itemId || p.proposalId)), [proposalsList]);
  const draftInboxItems = useMemo(
    () => (searchQueryRes.data?.hits ?? []).map((h) => h.item).filter((item) => item.status === "draft" && !proposalIdsSet.has(item.id)),
    [searchQueryRes.data, proposalIdsSet]
  );
  const pendingCount = proposalsList.length + draftInboxItems.length;
  const visibleWorkspaces = useMemo(() => {
    if (effectivePerms.length === 0) return WORKSPACES;
    return WORKSPACES.filter((ws) => effectivePerms.includes(`menu:${ws.id}`));
  }, [effectivePerms]);

  useEffect(() => {
    if (visibleWorkspaces.length > 0 && !visibleWorkspaces.some((ws) => ws.id === workspace)) {
      setWorkspace(visibleWorkspaces[0]!.id);
    }
  }, [visibleWorkspaces, workspace]);

  const activeWorkspaceMeta = visibleWorkspaces.find((ws) => ws.id === workspace);
  const currentRoles = accessQuery.data?.profile?.roles ?? [];

  return (
    <div className="noema-shell">
      <div
        className={`noema-sidebar-backdrop ${mobileNavOpen ? "open" : ""}`}
        onClick={() => setMobileNavOpen(false)}
      />
      <aside className={`noema-sidebar ${mobileNavOpen ? "open" : ""}`}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 9, background: "linear-gradient(135deg, #6366f1, #38bdf8)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Sparkles size={17} color="#fff" />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.02em" }}>Noema</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Project Brain OS 2.0</div>
            </div>
          </div>
          <button
            className="noema-btn noema-btn-ghost noema-mobile-menu-btn"
            style={{ padding: 6 }}
            onClick={() => setMobileNavOpen(false)}
            aria-label="Fechar menu"
          >
            <X size={15} />
          </button>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {(["Principal", "Engenharia & IA", "Governança"] as const).map((section) => {
            const items = visibleWorkspaces.filter((ws) => ws.section === section);
            if (items.length === 0) return null;
            return (
              <div key={section} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div className="noema-nav-section">{section}</div>
                {items.map((ws) => {
                  const active = workspace === ws.id;
                  return (
                    <button
                      key={ws.id}
                      onClick={() => {
                        setWorkspace(ws.id);
                        setMobileNavOpen(false);
                      }}
                      className={`noema-nav-item ${active ? "active" : ""}`}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        {ws.icon}
                        {ws.label}
                      </span>
                      {ws.id === "inbox" && pendingCount > 0 && <Badge tone="warning">{pendingCount}</Badge>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div style={{ marginTop: "auto", padding: "10px 6px 0", borderTop: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 8 }}>
          {currentRoles.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "4px 6px", fontSize: 11 }}>
              <span style={{ color: "var(--text-muted)" }}>Perfil ativo</span>
              <Badge tone="accent">{currentRoles.join(", ")}</Badge>
            </div>
          )}
          <button className="noema-nav-item" style={{ justifyContent: "space-between" }} onClick={() => setAuthModalOpen(true)}>
            <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <KeyRound size={15} />
              Conexão
            </span>
            <span
              className={`noema-dot ${wsStatus === "connected" && !overviewQuery.isError ? "live" : ""}`}
              style={{ background: overviewQuery.isError ? "#ef4444" : wsStatus === "connected" ? "#10b981" : "#f59e0b" }}
              aria-label={overviewQuery.isError ? "Erro de conexão" : wsStatus === "connected" ? "Ao vivo" : "Conectando"}
            />
          </button>
        </div>
      </aside>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header className="noema-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" }}>
            <button
              className="noema-btn noema-btn-ghost noema-mobile-menu-btn"
              style={{ padding: 7 }}
              onClick={() => setMobileNavOpen(true)}
              aria-label="Abrir menu"
            >
              <Menu size={16} />
            </button>
            <select
              className="noema-input"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                window.localStorage.setItem("noema.projectId", e.target.value);
              }}
              aria-label="Selecionar projeto"
              style={{ maxWidth: 260 }}
            >
              {!projectsList.some((p) => p.projectId === projectId) && <option value={projectId}>{projectId}</option>}
              {projectsList.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.projectId} — {p.name}
                </option>
              ))}
            </select>
            {can("projects:create") && (
              <button className="noema-btn noema-btn-ghost noema-btn-icon" onClick={() => setNewProjectModalOpen(true)} title="Novo projeto" aria-label="Novo projeto">
                <FolderPlus size={15} />
              </button>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              className="noema-btn noema-btn-ghost noema-btn-sm noema-hide-mobile"
              onClick={() => setAuthModalOpen(true)}
              title="Status da conexão"
              style={{ gap: 7 }}
            >
              <span
                className={`noema-dot ${wsStatus === "connected" && !overviewQuery.isError ? "live" : ""}`}
                style={{ background: overviewQuery.isError ? "#ef4444" : wsStatus === "connected" ? "#10b981" : "#f59e0b" }}
              />
              {overviewQuery.isError ? "Offline" : wsStatus === "connected" ? "Ao vivo" : "Conectando"}
            </button>
            <button className="noema-btn noema-btn-ghost" onClick={() => setPaletteOpen(true)} style={{ justifyContent: "space-between", gap: 16, color: "var(--text-muted)" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Search size={14} />
                <span className="noema-hide-mobile">Buscar ou navegar...</span>
              </span>
              <span className="noema-kbd">
                <CommandIcon size={10} />K
              </span>
            </button>
          </div>
        </header>

        <main className="noema-main" key={workspace}>
          {toast && (
            <div
              className="noema-toast"
              role="status"
              aria-live="polite"
              style={{
                border: toast.tone === "error" ? "1px solid rgba(239,68,68,0.45)" : "1px solid rgba(16,185,129,0.4)",
                background: "rgba(15,19,28,0.96)",
                color: "#f8fafc"
              }}
            >
              {toast.tone === "error" ? (
                <AlertCircle size={16} color="#f87171" style={{ flexShrink: 0, marginTop: 1 }} />
              ) : (
                <CheckCircle2 size={16} color="#34d399" style={{ flexShrink: 0, marginTop: 1 }} />
              )}
              <span style={{ flex: 1 }}>{toast.text}</span>
              <button
                onClick={() => setToast(null)}
                aria-label="Fechar notificação"
                style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 0 }}
              >
                <X size={14} />
              </button>
            </div>
          )}

          {activeWorkspaceMeta && (
            <PageHeader
              title={activeWorkspaceMeta.label}
              description={WORKSPACE_DESCRIPTIONS[workspace]}
              icon={activeWorkspaceMeta.icon}
              actions={
                workspace === "inbox" && pendingCount > 0 ? (
                  <Badge tone="warning" dot>
                    {pendingCount} pendentes
                  </Badge>
                ) : workspace === "projects" && can("projects:create") ? (
                  <button className="noema-btn noema-btn-ghost noema-btn-sm" onClick={() => setNewProjectModalOpen(true)}>
                    <FolderPlus size={14} /> Novo projeto
                  </button>
                ) : undefined
              }
            />
          )}

          {workspace === "projects" && (
            <ProjectsWorkspace
              projectId={projectId}
              overview={overviewQuery.data}
              loading={overviewQuery.isLoading}
              domainDistribution={domainDistribution}
              recentJobs={integrationsQuery.data?.github?.recentJobs ?? []}
              apiFetch={apiFetch}
              queryClient={queryClient}
              notify={notify}
            />
          )}

          {workspace === "inbox" && (
            <InboxWorkspace
              proposalsList={proposalsList}
              draftInboxItems={draftInboxItems}
              onInspect={setInspectedItem}
              onProposalDecision={handleProposalDecision}
              onChangeItemStatus={handleChangeItemStatus}
            />
          )}

          {workspace === "knowledge" && (
            <KnowledgeWorkspace
              hits={searchQueryRes.data?.hits ?? []}
              onFileDrop={handleFileDrop}
              onChangeItemStatus={handleChangeItemStatus}
              onInspect={setInspectedItem}
            />
          )}

          {workspace === "search" && (
            <SearchGraphWorkspace
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              hits={searchQueryRes.data?.hits ?? []}
              graphNodes={graphQuery.data?.nodes}
              graphEdges={graphQuery.data?.edges ?? []}
              onInspect={setInspectedItem}
            />
          )}

          {workspace === "agents" && (
            <AgentsWorkspace projectId={projectId} tasks={runnerQuery.data?.tasks ?? []} apiFetch={apiFetch} queryClient={queryClient} notify={notify} />
          )}

          {workspace === "impact" && <ImpactWorkspace projectId={projectId} apiFetch={apiFetch} notify={notify} />}

          {workspace === "integrations" && (
            <IntegrationsWorkspace
              projectId={projectId}
              notificationChannels={integrationsQuery.data?.notificationChannels ?? []}
              apiFetch={apiFetch}
              queryClient={queryClient}
              notify={notify}
            />
          )}

          {workspace === "operations" && (
            <OperationsWorkspace
              projectId={projectId}
              finops={finopsQuery.data}
              auditLogs={auditQuery.data?.logs ?? auditQuery.data?.events ?? []}
              apiFetch={apiFetch}
              queryClient={queryClient}
              notify={notify}
            />
          )}

          {workspace === "access" && (
            <AccessWorkspace projectId={projectId} data={accessQuery.data} apiFetch={apiFetch} queryClient={queryClient} notify={notify} />
          )}

          {workspace === "templates" && (
            <TemplatesWorkspace recommendations={scaffoldQuery.data?.recommendations ?? []} note={scaffoldQuery.data?.note} />
          )}

          {workspace === "enterprise" && (
            <EnterpriseWorkspace
              coverageRows={enterpriseQuery.data?.qaCoverage?.rows ?? enterpriseQuery.data?.coverageMatrix ?? []}
              coveragePercent={enterpriseQuery.data?.qaCoverage?.coveragePercent}
              techRadar={enterpriseQuery.data?.techRadar ?? []}
            />
          )}
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        workspaces={visibleWorkspaces}
        projects={projectsList}
        onSelectWorkspace={(id) => setWorkspace(id as WorkspaceId)}
        onSelectProject={(id) => {
          setProjectId(id);
          window.localStorage.setItem("noema.projectId", id);
        }}
        onOpenNewProject={() => setNewProjectModalOpen(true)}
      />

      <SlideOverDrawer open={Boolean(inspectedItem)} onClose={() => setInspectedItem(null)} title={inspectedItem?.title ?? ""} subtitle={inspectedItem?.subtitle}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {inspectedItem?.status && (
              <Badge tone={statusTone(inspectedItem.status)} dot>
                {inspectedItem.status}
              </Badge>
            )}
            {typeof inspectedItem?.meta?.type === "string" && <Badge tone="accent">{inspectedItem.meta.type}</Badge>}
            {typeof inspectedItem?.meta?.accessPolicyId === "string" && <Badge tone="neutral">{inspectedItem.meta.accessPolicyId}</Badge>}
          </div>
          {inspectedItem?.itemId && (can("knowledge:approve") || can("knowledge:write")) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)" }}>
                Alterar status
              </span>
              <Segmented<KnowledgeStatus>
                ariaLabel="Alterar status do item"
                value={(inspectedItem.status as KnowledgeStatus) ?? "draft"}
                onChange={(st) => void handleChangeItemStatus(inspectedItem.itemId!, st)}
                options={[
                  { id: "draft", label: "Rascunho" },
                  { id: "approved", label: "Aprovado" },
                  { id: "deprecated", label: "Deprecado" },
                  { id: "superseded", label: "Substituído" }
                ]}
              />
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)" }}>
              Conteúdo
            </span>
            {inspectedItem?.body ? (
              <pre className="noema-code" style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--text-primary)", lineHeight: 1.6 }}>
                {inspectedItem.body}
              </pre>
            ) : (
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Sem conteúdo textual.</span>
            )}
          </div>
        </div>
      </SlideOverDrawer>

      <SlideOverDrawer
        open={newProjectModalOpen}
        onClose={() => setNewProjectModalOpen(false)}
        title="Novo projeto"
        subtitle="Registra o projeto no PostgreSQL/RLS para ingestão e governança."
        footer={
          <>
            <button className="noema-btn noema-btn-ghost" onClick={() => setNewProjectModalOpen(false)}>
              Cancelar
            </button>
            <button className="noema-btn noema-btn-primary" disabled={!newProjectSlug.trim()} onClick={() => void handleCreateProject()}>
              <FolderPlus size={15} /> Criar projeto
            </button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreateProject();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 14 }}
        >
          <Field label="Nome do projeto">
            <input
              autoFocus
              className="noema-input"
              value={newProjectName}
              onChange={(e) => {
                const name = e.target.value;
                setNewProjectName(name);
                const autoSlug = name
                  .normalize("NFD")
                  .replace(/[\u0300-\u036f]/g, "")
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "")
                  .slice(0, 48);
                setNewProjectSlug(autoSlug);
              }}
              placeholder="Ex.: Staf Web"
            />
          </Field>
          <Field label="Identificador (slug)" hint="Gerado a partir do nome; usado em URLs e na API.">
            <input className="noema-input noema-mono" value={newProjectSlug} onChange={(e) => setNewProjectSlug(e.target.value)} placeholder="staf-web" />
          </Field>
          <Field label="Descrição" hint="Opcional">
            <textarea className="noema-input" rows={3} value={newProjectDesc} onChange={(e) => setNewProjectDesc(e.target.value)} placeholder="Do que se trata este projeto?" />
          </Field>
          <button type="submit" hidden />
        </form>
      </SlideOverDrawer>

      <SlideOverDrawer
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        title="Conexão com o Hub Noema"
        subtitle="Credenciais salvas apenas neste navegador."
        footer={
          <>
            <button className="noema-btn noema-btn-ghost" onClick={() => setAuthModalOpen(false)}>
              Cancelar
            </button>
            <button
              className="noema-btn noema-btn-primary"
              onClick={() => {
                window.localStorage.setItem("noema.apiUrl", apiUrl);
                window.localStorage.setItem("noema.apiKey", apiKey);
                setAuthModalOpen(false);
                void queryClient.invalidateQueries();
                notify("Conexão atualizada.");
              }}
            >
              Salvar conexão
            </button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: 12,
              borderRadius: 10,
              border: "1px solid var(--border-subtle)",
              background: "var(--bg-inset)",
              fontSize: 12.5
            }}
          >
            <span
              className={`noema-dot ${wsStatus === "connected" ? "live" : ""}`}
              style={{ background: overviewQuery.isError ? "#ef4444" : wsStatus === "connected" ? "#10b981" : "#f59e0b" }}
            />
            <span style={{ flex: 1 }}>
              {overviewQuery.isError
                ? "Não foi possível conectar à API."
                : wsStatus === "connected"
                  ? "Conectado — atualizações em tempo real via WebSocket."
                  : "Conectado via HTTP — aguardando canal em tempo real."}
            </span>
          </div>
          <Field label="URL da API">
            <input className="noema-input noema-mono" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="http://localhost:3333" />
          </Field>
          <Field label="API Key / Bearer token" hint="Nunca é enviada a terceiros.">
            <input className="noema-input noema-mono" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="••••••••" />
          </Field>
        </div>
      </SlideOverDrawer>
    </div>
  );
}
