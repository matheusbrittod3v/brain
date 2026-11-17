"use client";

import { useEffect, useState } from "react";

interface KnowledgeProposal {
  id: string;
  title: string;
  type?: string;
  domainId?: number;
  status: string;
  trustLevel?: string;
  sourceOrigin?: string;
  sourceUri: string;
  version: number;
  accessPolicyId?: string;
  relatedIds?: string[];
  assignedTo?: string;
  dueAt?: string;
  overdue?: boolean;
  content?: string;
  updatedAt?: string;
}

interface ApprovalReminderEvent {
  proposalId: string;
  eventType: "reminder" | "escalation";
  dueAt: string;
  createdAt: string;
}

interface NotificationPreferencesView {
  channels: Array<"slack" | "teams" | "jira" | "clickup" | "email">;
  categories: Array<"approval" | "runner_question">;
  frequency: "immediate" | "daily" | "weekly";
}

interface GraphEdgeView {
  itemId?: string;
  via?: string;
  hops?: number;
  fromItemId?: string;
  toItemId?: string;
  relationType?: string;
}

interface ProposalVersionView {
  version: number;
  content?: string | null;
  status: string;
}

interface ProposalAuditEventView {
  actorId: string;
  actorType: string;
  action: string;
  targetType: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

interface ProposalEvidenceView {
  coveragePercent: number | null;
  rows: Array<{ ruleId: string; title: string; covered: boolean; tests: string[] }>;
  testExecutionResults?: Array<{ testItemId: string; status: "passed" | "failed" | "skipped"; commitSha: string; executedAt: string }>;
  confirmedImpacts: GraphEdgeView[];
  hypotheses: GraphEdgeView[];
  riskLevel: "low" | "medium" | "high" | "critical";
  directImpacts: GraphEdgeView[];
  transitiveImpacts: GraphEdgeView[];
  crossServiceImpacts: Array<{ contractId: string; impactedProjects: string[]; impactedServices: Array<{ projectId: string; service: string; relation: string }> }>;
  criticalRulesImpacted: Array<{ id: string; title?: string; priority: "high" | "critical" }>;
}

type DiffLine = { kind: "same" | "added" | "removed"; text: string };

function compareLines(previousText: string, currentText: string): DiffLine[] | undefined {
  const previous = previousText.split("\n");
  const current = currentText.split("\n");
  if (previous.length * current.length > 490_000) return undefined;
  const width = current.length + 1;
  const table = new Uint16Array((previous.length + 1) * width);
  for (let i = previous.length - 1; i >= 0; i--) {
    for (let j = current.length - 1; j >= 0; j--) {
      table[i * width + j] = previous[i] === current[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < previous.length && j < current.length) {
    if (previous[i] === current[j]) {
      lines.push({ kind: "same", text: `  ${current[j]}` }); i++; j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      lines.push({ kind: "removed", text: `− ${previous[i]}` }); i++;
    } else {
      lines.push({ kind: "added", text: `+ ${current[j]}` }); j++;
    }
  }
  while (i < previous.length) lines.push({ kind: "removed", text: `− ${previous[i++]}` });
  while (j < current.length) lines.push({ kind: "added", text: `+ ${current[j++]}` });
  return lines;
}

interface RunnerTaskView {
  taskId: string;
  projectId: string;
  instruction: string;
  priority: string;
  status: string;
  resultSummary?: string | null;
  pendingQuestion?: { questionId: string; question: string };
  createdAt: string;
}

interface ProjectOverview {
  projectId: string;
  totalItems: number;
  approvedCount: number;
  draftCount: number;
  health: {
    healthScore: number;
    untestedRuleIds: string[];
    staleItemIds: string[];
    gitVsConnectorConflicts: Array<{ id: string }>;
  };
  alerts: string[];
}

interface GitHubIngestionJob {
  jobId: string;
  state: string;
  retries: number;
  owner: string;
  repo: string;
  ref: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result?: { ingested?: number; skippedSecrets?: number; errors?: number; chunksEmbedded?: number; warnings?: string[] } | null;
}

interface IntegrationStatusView {
  github: {
    state: string;
    privateRepoAuthConfigured: boolean;
    webhookConfigured: boolean;
    repositories: Array<{ repository: string; accessPolicyId: string }>;
    mainHeads?: Array<{ repository: string; branch: string; commitSha: string }>;
    recentJobs: Array<{ jobId: string; owner: string; repo: string; ref: string; state: string; retries: number; createdAt: string; completedAt: string | null; result?: { ingested?: number; errors?: number; warnings?: string[] } | null }>;
  };
  saas: {
    state: string;
    recentJobs: Array<{ jobId: string; provider: string; connectionId: string; state: string; retries: number; createdAt: string; completedAt: string | null; result?: { synced?: number; errors?: number; warnings?: string[] } | null }>;
  };
  notificationChannels: Array<{ provider: string; configured: boolean }>;
  slackInteractiveApprovalConfigured: boolean;
}

interface OperationsOverview {
  projectId: string;
  generatedAt: string;
  service: { api: string; postgresOperational: boolean; pgBoss: string };
  health: { score: number; activeItems: number; untestedRules: string[]; staleItems: string[]; gitConnectorConflicts: Array<{ id: string }> };
  quality: { qaCoveragePercent: number; rules: Array<{ ruleId: string; title: string; covered: boolean; tests: string[] }> };
  queues: {
    windowHours: number;
    counts: Array<{ queue: string; state: string; count: number; latestAt: string | null }>;
    recentFailures: Array<{ jobId: string; queue: string; failedAt: string; retries: number; errorSummary?: string | null }>;
  };
  telemetry?: {
    apiLatencyMs: { sampleCount: number; avgMs: number | null; p50Ms: number | null; p95Ms: number | null; maxMs: number | null };
  };
  finops: {
    estimatedIndexedTokens: number;
    tokenEstimateMethod: string;
    actualProviderUsageAvailable: boolean;
    actualCostUsd: number | null;
    modelUsage: { windowDays: number; modelUsageAvailable: boolean; calls: number; byModel: Array<{ provider: string; model: string; calls: number; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; providerCostUsd: number | null; costBasis: string }>; providerCostUsd: number | null; infrastructureCostAvailable: boolean };
    note: string;
  };
}

interface ScaffoldRecommendation {
  id: string;
  sourceProjectId?: string;
  title: string;
  summary: string;
  sourceUri: string;
  sourceVersion: string;
  status: string;
  sourceOrigin: string;
  matchReasons: string[];
  score: number;
}

interface PlannedTaskView {
  id: string;
  kind: "epic" | "story" | "task";
  step: number;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  targetFiles: string[];
  relatedRuleIds: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
}

interface LivingDocDraftView {
  id: string;
  targetItemId: string;
  targetUri: string;
  status: "draft";
  title: string;
  reason: string;
  matchedFiles: string[];
  proposedContent: string;
}

interface AuditLogView {
  id: string;
  projectId: string;
  actorId: string;
  actorType: string;
  accessPolicyId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: string;
}

interface AccessProfileView {
  projectId: string;
  tenantId: string;
  actorId: string;
  actorType: string;
  identitySource: string;
  opaConfigured?: boolean;
  roles: string[];
  allowedProjects: string[];
  allowedPolicies: string[];
  policyCatalog?: Array<{ policyId: string; description: string; authorized: boolean; itemCount: number }>;
  currentProjectAuthorized: boolean;
  managementAvailable: boolean;
  managementNote: string;
}

interface HandoffView {
  handoffId: string;
  taskId: string;
  projectId: string;
  fromAgent: string;
  repoUrl?: string;
  branch: string;
  baseCommitSha: string;
  modifiedFiles: string[];
  testsExecuted?: Array<{ command: string; passed: boolean }>;
  decisions?: string[];
  nextSteps: string[];
  createdAt?: string;
}

interface RunnerScheduleView {
  scheduleId: string;
  instruction: string;
  cron: string;
  priority: string;
  createdAt?: string;
}

interface SearchHitView {
  score: number;
  id: string;
  title: string;
  type: string;
  domainId: number;
  status: string;
  trustLevel: string;
  sourceOrigin: string;
  sourceUri: string;
  version: number;
  summary?: string;
  content: string;
  tags?: string[];
  updatedAt?: string;
}

interface ContextPackView {
  project: string;
  task: string;
  sessionId?: string;
  hitRate?: { hits: number; itemsSent: number; rate: number };
  tokenUsage?: { budget?: number; used?: number };
  context?: {
    businessRules?: Array<{ id: string; title: string; version?: string | number; status?: string; summary?: string; sourceUri?: string; trustLevel?: string }>;
    architecture?: Array<{ id: string; title: string; status?: string; sourceUri?: string; trustLevel?: string }>;
    services?: Array<{ id: string; path?: string; commit?: string }>;
    tests?: string[];
    tasks?: Array<{ id: string; title: string; status?: string }>;
  };
  warnings?: string[];
  conflicts?: unknown[];
  sources?: Array<{ id: string; title?: string; version?: string | number; status?: string; sourceUri?: string; trustLevel?: string; sourceOrigin?: string; explain?: string[] }>;
}

interface CrossServiceContractView {
  tenantId: string;
  fromProjectId: string;
  fromService: string;
  relation: string;
  toProjectId: string;
  contractId: string;
  schemaVersion: string;
  accessPolicyId: string;
}

interface BlastRadiusView {
  contractId: string;
  impactedProjects?: string[];
  impactedServices?: Array<{ projectId: string; service: string; relation: string }>;
}

interface ChangeImpactView {
  riskLevel: "low" | "medium" | "high" | "critical";
  confirmedImpacts?: GraphEdgeView[];
  hypotheses?: GraphEdgeView[];
  directImpacts?: GraphEdgeView[];
  transitiveImpacts?: GraphEdgeView[];
  criticalRulesImpacted?: Array<{ id: string; title?: string; priority?: string }>;
  crossServiceImpacts?: Array<{ contractId: string; impactedProjects: string[]; impactedServices: Array<{ projectId: string; service: string; relation: string }> }>;
}

interface EnterpriseViewsData {
  techRadar?: { adopted?: string[]; trials?: string[]; unapprovedDeviations?: Array<{ itemId?: string; title?: string; technology?: string }> };
  qaCoverage?: { coveragePercent: number | null; rows: Array<{ ruleId: string; title: string; priority?: string; covered: boolean; tests: string[] }> };
  testExecutionResults?: Array<{ testItemId: string; status: "passed" | "failed" | "skipped"; commitSha: string; executedAt: string }>;
  health?: { healthScore: number; untestedRuleIds: string[]; staleItemIds: string[]; gitVsConnectorConflicts: Array<{ id: string }> };
}

interface GatewayInfoView {
  gateway: string;
  mcpEndpoint?: string;
  transports?: string[];
  tools?: Array<{ name: string; mode?: string; description?: string }>;
}

type WorkspaceKey =
  | "inbox"
  | "projects"
  | "agents"
  | "knowledge"
  | "search"
  | "integrations"
  | "impact"
  | "operations"
  | "access"
  | "templates"
  | "enterprise";

const WORKSPACES: Array<{ key: WorkspaceKey; label: string; group: string }> = [
  { key: "inbox", label: "1. Caixa de Entrada", group: "HumanOps" },
  { key: "projects", label: "2. Projetos", group: "HumanOps" },
  { key: "agents", label: "3. Agentes e Execuções", group: "HumanOps" },
  { key: "knowledge", label: "4. Conhecimento", group: "Engenharia" },
  { key: "search", label: "5. Busca e Contexto", group: "Engenharia" },
  { key: "integrations", label: "6. Integrações", group: "Plataforma" },
  { key: "impact", label: "7. Impacto de Mudanças", group: "Engenharia" },
  { key: "operations", label: "8. Operação & FinOps", group: "Plataforma" },
  { key: "access", label: "9. Acesso e Políticas", group: "Governança" },
  { key: "templates", label: "10. Modelos e Padrões", group: "Governança" },
  { key: "enterprise", label: "11. Visões Corporativas", group: "Corporativo" }
];

const cardStyle: React.CSSProperties = {
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: 10,
  padding: 16,
  marginBottom: 16
};

const btnStyle: React.CSSProperties = {
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: 13
};

const inputStyle: React.CSSProperties = {
  background: "#0f172a",
  color: "#f9fafb",
  border: "1px solid #334155",
  borderRadius: 6,
  padding: "7px 10px",
  fontSize: 13
};

function randomBase64Url(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function loadOidcDiscovery(issuer: string): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
  const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`Falha ao carregar OIDC discovery: HTTP ${response.status}`);
  const config = await response.json() as { authorization_endpoint?: string; token_endpoint?: string };
  if (!config.authorization_endpoint || !config.token_endpoint) throw new Error("OIDC discovery não informou endpoints de autorização/token.");
  return { authorization_endpoint: config.authorization_endpoint, token_endpoint: config.token_endpoint };
}

export default function CommandCenterPage() {
  const [workspace, setWorkspace] = useState<WorkspaceKey>(() => {
    if (typeof window === "undefined") return "inbox";
    const requested = new URLSearchParams(window.location.search).get("workspace");
    return WORKSPACES.some((entry) => entry.key === requested) ? requested as WorkspaceKey : "inbox";
  });
  const [apiUrl, setApiUrl] = useState("http://localhost:3333");
  const [apiKey, setApiKey] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [authMe, setAuthMe] = useState<{
    tenantId: string;
    actorId: string;
    roles: string[];
    allowedProjects: string[];
    visibilityScope: "org" | "project" | "self";
  } | null>(null);
  const [oidcRefreshToken, setOidcRefreshToken] = useState<string | null>(null);
  const [oidcExpiresAt, setOidcExpiresAt] = useState(0);
  const [projectId, setProjectId] = useState(() => {
    if (typeof window === "undefined") return "noema";
    return new URLSearchParams(window.location.search).get("projectId") || "noema";
  });
  const [statusMsg, setStatusMsg] = useState("Pronto para conectar à API.");

  // Inbox / Proposals
  const [proposals, setProposals] = useState<KnowledgeProposal[]>([]);
  const [approvalReminders, setApprovalReminders] = useState<ApprovalReminderEvent[]>([]);
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferencesView>({
    channels: ["slack", "teams", "jira", "clickup", "email"], categories: ["approval", "runner_question"], frequency: "immediate"
  });
  const [selectedProposal, setSelectedProposal] = useState<KnowledgeProposal | null>(null);
  const [reviewComment, setReviewComment] = useState("");
  const [reviewerProvider, setReviewerProvider] = useState("jira");
  const [reviewerExternalId, setReviewerExternalId] = useState("");
  const [selectedProposalHistory, setSelectedProposalHistory] = useState<ProposalVersionView[]>([]);
  const [selectedProposalAudit, setSelectedProposalAudit] = useState<ProposalAuditEventView[]>([]);
  const [selectedProposalEvidence, setSelectedProposalEvidence] = useState<ProposalEvidenceView | null>(null);

  // Projects / Overview
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [githubOwner, setGithubOwner] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubRef, setGithubRef] = useState("main");
  const [githubJobs, setGithubJobs] = useState<GitHubIngestionJob[]>([]);

  // Agents & Runner
  const [runnerTasks, setRunnerTasks] = useState<RunnerTaskView[]>([]);
  const [runnerSchedules, setRunnerSchedules] = useState<RunnerScheduleView[]>([]);
  const [newTaskInstruction, setNewTaskInstruction] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState<"low" | "normal" | "high">("normal");
  const [runnerAnswers, setRunnerAnswers] = useState<Record<string, string>>({});
  const [runnerAnswerKeys, setRunnerAnswerKeys] = useState<Record<string, string>>({});
  const [handoffsList, setHandoffsList] = useState<HandoffView[]>([]);

  // Knowledge / Graph / Temporal
  const [graphRootId, setGraphRootId] = useState("docs/02-specifications/knowledge-structure-guide.md");
  const [graphEdges, setGraphEdges] = useState<GraphEdgeView[]>([]);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeTypeFilter, setKnowledgeTypeFilter] = useState("all");
  const [knowledgeCatalog, setKnowledgeCatalog] = useState<SearchHitView[]>([]);
  const [knowledgeVersions, setKnowledgeVersions] = useState<ProposalVersionView[]>([]);
  const [temporalItems, setTemporalItems] = useState<Array<{ id: string; title: string; type?: string; status?: string; version?: number; sourceUri?: string }>>([]);
  const [revisionItem, setRevisionItem] = useState<KnowledgeProposal | null>(null);
  const [revisionContent, setRevisionContent] = useState("");
  const [atTimestamp, setAtTimestamp] = useState(new Date().toISOString());

  // Search & Context
  const [contextTask, setContextTask] = useState("RLS fail-closed brain_app brain_system migrations");
  const [contextPack, setContextPack] = useState<ContextPackView | null>(null);
  const [searchResults, setSearchResults] = useState<SearchHitView[]>([]);
  const [searchDomainFilter, setSearchDomainFilter] = useState("");
  const [contextSessionId, setContextSessionId] = useState("");
  const [contextSourceIds, setContextSourceIds] = useState<string[]>([]);

  // Integrations
  const [gatewayInfo, setGatewayInfo] = useState<GatewayInfoView | null>(null);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatusView | null>(null);
  const [saasProvider, setSaasProvider] = useState("jira");
  const [saasConnectionId, setSaasConnectionId] = useState("");

  // Impact
  const [contractId, setContractId] = useState("POST /v1/invoices");
  const [impactTargets, setImpactTargets] = useState("docs/00-normative-decisions.md");
  const [crossServiceContracts, setCrossServiceContracts] = useState<CrossServiceContractView[]>([]);
  const [blastResult, setBlastResult] = useState<BlastRadiusView | null>(null);
  const [impactResult, setImpactResult] = useState<ChangeImpactView | null>(null);

  // Operations / FinOps / Enterprise Views
  const [operationsOverview, setOperationsOverview] = useState<OperationsOverview | null>(null);
  const [enterpriseViews, setEnterpriseViews] = useState<EnterpriseViewsData | null>(null);

  // Access & Audit Logs
  const [auditLogs, setAuditLogs] = useState<AuditLogView[] | null>(null);
  const [accessProfile, setAccessProfile] = useState<AccessProfileView | null>(null);
  const [devPkgManager, setDevPkgManager] = useState("npm");
  const [devTestLayout, setDevTestLayout] = useState("co-located");
  const [devArchStyle, setDevArchStyle] = useState("layered");
  const [devHarness, setDevHarness] = useState("antigravity");
  const [devConventions, setDevConventions] = useState("");
  const [devOptInCrossProject, setDevOptInCrossProject] = useState(true);

  // Project blueprinting
  const [scaffoldName, setScaffoldName] = useState("new-service");
  const [scaffoldObjective, setScaffoldObjective] = useState("");
  const [scaffoldDomain, setScaffoldDomain] = useState("general");
  const [scaffoldCriticality, setScaffoldCriticality] = useState("medium");
  const [scaffoldStack, setScaffoldStack] = useState("node-ts");
  const [scaffoldCommunication, setScaffoldCommunication] = useState("sync");
  const [scaffoldHandlesPii, setScaffoldHandlesPii] = useState(false);
  const [scaffoldHandlesPayments, setScaffoldHandlesPayments] = useState(false);
  const [scaffoldCrossProject, setScaffoldCrossProject] = useState(true);
  const [selectedAdrIds, setSelectedAdrIds] = useState<string[]>([]);
  const [scaffoldCommand, setScaffoldCommand] = useState("");
  const [scaffoldRecommendations, setScaffoldRecommendations] = useState<ScaffoldRecommendation[] | null>(null);
  const [scaffoldRecommendationNote, setScaffoldRecommendationNote] = useState("");

  // Autonomous Task Planner & Living Documentation
  const [epicInput, setEpicInput] = useState("");
  const [plannedTasks, setPlannedTasks] = useState<PlannedTaskView[]>([]);
  const [livingDocFiles, setLivingDocFiles] = useState("");
  const [livingDocSummary, setLivingDocSummary] = useState("");
  const [livingDocDrafts, setLivingDocDrafts] = useState<LivingDocDraftView[]>([]);

  const oidcIssuer = process.env.NEXT_PUBLIC_OIDC_ISSUER ?? "";
  const oidcClientId = process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? "";

  async function refreshOidcAccessToken() {
    if (!oidcIssuer || !oidcClientId || !oidcRefreshToken) {
      throw new Error("Sessão expirada. Entre novamente para continuar.");
    }
    const discovery = await loadOidcDiscovery(oidcIssuer);
    const response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: oidcClientId,
        refresh_token: oidcRefreshToken
      })
    });
    const tokens = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
    if (!response.ok || !tokens.access_token) throw new Error(tokens.error_description ?? "A sessão OIDC expirou. Entre novamente.");
    setApiKey(tokens.access_token);
    if (tokens.refresh_token) setOidcRefreshToken(tokens.refresh_token);
    setOidcExpiresAt(Date.now() + (tokens.expires_in ?? 300) * 1000);
    return tokens.access_token;
  }

  async function startOidcLogin() {
    if (!oidcIssuer || !oidcClientId) {
      setStatusMsg("Configure NEXT_PUBLIC_OIDC_ISSUER e NEXT_PUBLIC_OIDC_CLIENT_ID para habilitar OIDC.");
      return;
    }
    try {
      const discovery = await loadOidcDiscovery(oidcIssuer);
      const verifier = randomBase64Url(48);
      const state = randomBase64Url();
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      const redirectUri = `${window.location.origin}${window.location.pathname}${window.location.search}`;
      sessionStorage.setItem("noema_oidc_state", state);
      sessionStorage.setItem("noema_oidc_verifier", verifier);
      sessionStorage.setItem("noema_oidc_redirect", redirectUri);
      const authorize = new URL(discovery.authorization_endpoint);
      authorize.search = new URLSearchParams({
        client_id: oidcClientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid profile email",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256"
      }).toString();
      window.location.assign(authorize.toString());
    } catch (error) {
      setStatusMsg(`Falha ao iniciar OIDC: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) return;
    const returnedState = params.get("state");
    const expectedState = sessionStorage.getItem("noema_oidc_state");
    const verifier = sessionStorage.getItem("noema_oidc_verifier");
    const redirectUri = sessionStorage.getItem("noema_oidc_redirect");
    params.delete("code");
    params.delete("state");
    params.delete("session_state");
    params.delete("iss");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    sessionStorage.removeItem("noema_oidc_state");
    sessionStorage.removeItem("noema_oidc_verifier");
    sessionStorage.removeItem("noema_oidc_redirect");
    if (!expectedState || returnedState !== expectedState || !verifier || !redirectUri || !oidcIssuer || !oidcClientId) {
      setStatusMsg("Callback OIDC inválido ou expirado. Inicie o login novamente.");
      return;
    }
    void (async () => {
      try {
        const discovery = await loadOidcDiscovery(oidcIssuer);
        const response = await fetch(discovery.token_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code", client_id: oidcClientId,
            code, redirect_uri: redirectUri, code_verifier: verifier
          })
        });
        const tokens = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
        if (!response.ok || !tokens.access_token) throw new Error(tokens.error_description ?? "O provedor OIDC recusou o código de autorização.");
        const validation = await fetch(`${apiUrl}/v1/projects/${encodeURIComponent(projectId)}/overview`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        if (!validation.ok) throw new Error("O token foi emitido, mas não tem acesso ao projeto selecionado.");
        setApiKey(tokens.access_token);
        setOidcRefreshToken(tokens.refresh_token ?? null);
        setOidcExpiresAt(Date.now() + (tokens.expires_in ?? 300) * 1000);
        setAuthenticated(true);
        setStatusMsg("Sessão OIDC iniciada; token mantido somente em memória.");
      } catch (error) {
        setStatusMsg(`Falha no login OIDC: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }, []);

  async function apiFetch(path: string, init?: RequestInit) {
    if (!authenticated && !apiKey) throw new Error("Entre para acessar os dados do projeto.");
    let token = apiKey;
    if (oidcRefreshToken && oidcExpiresAt && Date.now() >= oidcExpiresAt - 30_000) token = await refreshOidcAccessToken();
    const request = (bearer: string) => fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "content-type": "application/json" } : {}),
        Authorization: `Bearer ${bearer}`,
        ...(init?.headers ?? {})
      }
    });
    let res = await request(token);
    if (res.status === 401 && oidcRefreshToken) {
      token = await refreshOidcAccessToken();
      res = await request(token);
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error((data as { message?: string }).message ?? `HTTP ${res.status}`);
    }
    return data;
  }

  async function loadGitHubJobs() {
    try {
      const data = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/github/jobs?limit=20`) as { jobs?: GitHubIngestionJob[] };
      setGithubJobs(data.jobs ?? []);
    } catch (err) {
      setStatusMsg(`Erro ao carregar ingestões GitHub: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function startGitHubIngestion() {
    if (!githubOwner.trim() || !githubRepo.trim() || !githubRef.trim()) {
      setStatusMsg("Informe owner, repositório e branch ou tag do GitHub.");
      return;
    }
    try {
      const result = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/github/ingest`, {
        method: "POST",
        body: JSON.stringify({ owner: githubOwner.trim(), repo: githubRepo.trim(), ref: githubRef.trim() })
      }) as { jobId: string };
      setStatusMsg(`Ingestão ${result.jobId} enfileirada para ${githubOwner}/${githubRepo}@${githubRef}.`);
      await loadGitHubJobs();
    } catch (err) {
      setStatusMsg(`Erro ao iniciar ingestão GitHub: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function loadIntegrationStatus() {
    try {
      const data = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/integrations/status`) as IntegrationStatusView;
      setIntegrationStatus(data);
    } catch (err) {
      setStatusMsg(`Erro ao carregar integrações: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function startSaasSync() {
    if (!saasConnectionId.trim()) {
      setStatusMsg("Informe o connection ID criado no Nango.");
      return;
    }
    try {
      const response = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/integrations/${encodeURIComponent(saasProvider)}/sync`, {
        method: "POST", body: JSON.stringify({ connectionId: saasConnectionId.trim() })
      }) as { jobId: string };
      setStatusMsg(`Sincronização ${response.jobId} enfileirada para ${saasProvider}.`);
      await loadIntegrationStatus();
    } catch (err) {
      setStatusMsg(`Erro ao iniciar sincronização SaaS: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function loadOperationsOverview() {
    try {
      const data = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/operations/overview`) as OperationsOverview;
      setOperationsOverview(data);
      setStatusMsg(`Operação atualizada em ${new Date(data.generatedAt).toLocaleTimeString()}.`);
    } catch (err) {
      setStatusMsg(`Erro ao carregar operação: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  useEffect(() => {
    if (!authenticated || workspace !== "projects") return;
    void loadGitHubJobs();
    const timer = window.setInterval(() => void loadGitHubJobs(), 5000);
    return () => window.clearInterval(timer);
  }, [authenticated, workspace, projectId, apiUrl, apiKey]);

  useEffect(() => {
    if (!authenticated || workspace !== "operations") return;
    void loadOperationsOverview();
    const timer = window.setInterval(() => void loadOperationsOverview(), 15_000);
    return () => window.clearInterval(timer);
  }, [authenticated, workspace, projectId, apiUrl, apiKey]);

  useEffect(() => {
    if (!authenticated || workspace !== "integrations") return;
    void loadIntegrationStatus();
    const timer = window.setInterval(() => void loadIntegrationStatus(), 10_000);
    return () => window.clearInterval(timer);
  }, [authenticated, workspace, projectId, apiUrl, apiKey]);

  async function loadProposals() {
    try {
      const [data, reminderData, preferenceData] = await Promise.all([
        apiFetch(`/v1/projects/${projectId}/proposals`) as Promise<{ proposals?: KnowledgeProposal[] }>,
        apiFetch(`/v1/projects/${projectId}/approval-reminders`) as Promise<{ reminders?: ApprovalReminderEvent[] }>,
        apiFetch(`/v1/projects/${projectId}/notification-preferences`) as Promise<{ preferences?: NotificationPreferencesView }>
      ]);
      const list = data.proposals ?? [];
      setProposals(list);
      setApprovalReminders(reminderData.reminders ?? []);
      if (preferenceData.preferences) setNotificationPreferences(preferenceData.preferences);
      if (list.length > 0 && !selectedProposal) setSelectedProposal(list[0]!);
      setStatusMsg(`Carregadas ${list.length} proposta(s) pendente(s) em '${projectId}'.`);
    } catch (err) {
      setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function saveNotificationPreferences() {
    try {
      const response = await apiFetch(`/v1/projects/${projectId}/notification-preferences`, {
        method: "PUT", body: JSON.stringify(notificationPreferences)
      }) as { preferences: NotificationPreferencesView };
      setNotificationPreferences(response.preferences);
      setStatusMsg("Preferências de notificação salvas para sua identidade autenticada.");
    } catch (err) {
      setStatusMsg(`Erro ao salvar preferências: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function resetNotificationPreferences() {
    try {
      const response = await apiFetch(`/v1/projects/${projectId}/notification-preferences`, { method: "DELETE" }) as { preferences: NotificationPreferencesView };
      setNotificationPreferences(response.preferences);
      setStatusMsg("Preferências restauradas para os canais e categorias padrão.");
    } catch (err) {
      setStatusMsg(`Erro ao restaurar preferências: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function toggleNotificationChannel(channel: NotificationPreferencesView["channels"][number]) {
    setNotificationPreferences((current) => ({
      ...current,
      channels: current.channels.includes(channel) ? current.channels.filter((item) => item !== channel) : [...current.channels, channel]
    }));
  }

  function toggleNotificationCategory(category: NotificationPreferencesView["categories"][number]) {
    setNotificationPreferences((current) => ({
      ...current,
      categories: current.categories.includes(category) ? current.categories.filter((item) => item !== category) : [...current.categories, category]
    }));
  }

  async function decideProposal(id: string, proposalVersion: number, decision: "approve" | "reject" | "request_changes") {
    try {
      const encodedId = encodeURIComponent(id);
      const data = (await apiFetch(`/v1/projects/${projectId}/approvals/${encodedId}/decision`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          proposalVersion,
          comment: reviewComment.trim() || ({
            approve: "Aprovado via Command Center",
            reject: "Rejeitado via Command Center",
            request_changes: "Alterações solicitadas via Command Center"
          }[decision]),
          channel: "web-command-center"
        })
      })) as { decision?: string; status?: string };
      setStatusMsg(`Decisão '${data.decision}' registrada para '${id}' (status: ${data.status}).`);
      setReviewComment("");
      setSelectedProposal(null);
      await loadProposals();
    } catch (err) {
      setStatusMsg(`Erro ao decidir proposta: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function assignSelectedProposal() {
    if (!selectedProposal || !reviewerExternalId.trim()) return;
    try {
      const assigned = await apiFetch(`/v1/projects/${projectId}/proposals/${encodeURIComponent(selectedProposal.id)}/assign`, {
        method: "POST", body: JSON.stringify({ provider: reviewerProvider, externalUserId: reviewerExternalId.trim() })
      }) as { assignedTo: string };
      setSelectedProposal({ ...selectedProposal, assignedTo: assigned.assignedTo });
      setReviewerExternalId("");
      await loadProposals();
      setStatusMsg(`Revisão atribuída a ${assigned.assignedTo}.`);
    } catch (err) {
      setStatusMsg(`Erro ao atribuir revisão: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function loadRunnerTasks() {
    try {
      const [tasksRes, handoffsRes, schedulesRes] = await Promise.all([
        apiFetch(`/v1/projects/${projectId}/runner/tasks`) as Promise<{ tasks?: RunnerTaskView[] }>,
        apiFetch(`/v1/projects/${projectId}/handoffs?limit=10`) as Promise<{ handoffs?: HandoffView[] }>,
        apiFetch(`/v1/projects/${projectId}/runner/schedules`).catch(() => ({ schedules: [] })) as Promise<{ schedules?: RunnerScheduleView[] }>
      ]);
      setRunnerTasks(tasksRes.tasks ?? []);
      setHandoffsList(handoffsRes.handoffs ?? []);
      setRunnerSchedules(schedulesRes.schedules ?? []);
      setStatusMsg(`Carregadas ${(tasksRes.tasks ?? []).length} tarefa(s) e ${(handoffsRes.handoffs ?? []).length} handoff(s).`);
    } catch (err) {
      setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function cancelRunnerTask(taskId: string) {
    try {
      await apiFetch(`/v1/projects/${projectId}/runner/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({})
      });
      setStatusMsg(`Tarefa '${taskId}' cancelada.`);
      await loadRunnerTasks();
    } catch (err) {
      setStatusMsg(`Erro ao cancelar tarefa: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function cancelRunnerSchedule(scheduleId: string) {
    try {
      await apiFetch(`/v1/projects/${projectId}/runner/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
      setStatusMsg(`Agendamento '${scheduleId}' cancelado.`);
      await loadRunnerTasks();
    } catch (err) {
      setStatusMsg(`Erro ao cancelar agendamento: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function loadKnowledgeCatalog() {
    try {
      const data = await apiFetch(`/v1/projects/${projectId}/search`, {
        method: "POST",
        body: JSON.stringify({ query: knowledgeQuery.trim(), limit: 50 })
      }) as { items?: SearchHitView[] };
      setKnowledgeCatalog(data.items ?? []);
      setStatusMsg(`Catálogo carregado: ${(data.items ?? []).length} item(ns).`);
    } catch (err) {
      setStatusMsg(`Erro ao carregar catálogo: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function loadCrossServiceContracts() {
    try {
      const data = await apiFetch(`/v1/cross-service/contracts?projectId=${encodeURIComponent(projectId)}`) as { contracts?: CrossServiceContractView[] };
      setCrossServiceContracts(data.contracts ?? []);
    } catch {
      setCrossServiceContracts([]);
    }
  }

  async function loadEnterpriseViews() {
    try {
      const data = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/enterprise/views`) as EnterpriseViewsData;
      setEnterpriseViews(data);
      setStatusMsg(`Visões corporativas carregadas para '${projectId}'.`);
    } catch (err) {
      setStatusMsg(`Erro ao carregar visões corporativas: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  useEffect(() => {
    if (!authenticated) return;
    if (workspace === "agents") void loadRunnerTasks();
    if (workspace === "knowledge") void loadKnowledgeCatalog();
    if (workspace === "impact") void loadCrossServiceContracts();
    if (workspace === "enterprise") void loadEnterpriseViews();
    if (workspace === "access") {
      void (async () => {
        try {
          const profile = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/access/profile`) as AccessProfileView;
          setAccessProfile(profile);
          const dev = await apiFetch("/v1/profile/developer") as {
            profile?: {
              preferredPackageManager?: string;
              preferredTestLayout?: string;
              preferredArchitectureStyle?: string;
              preferredHarness?: string;
              codingConventions?: string[];
              optInCrossProject?: boolean;
            };
          };
          if (dev.profile) {
            if (dev.profile.preferredPackageManager) setDevPkgManager(dev.profile.preferredPackageManager);
            if (dev.profile.preferredTestLayout) setDevTestLayout(dev.profile.preferredTestLayout);
            if (dev.profile.preferredArchitectureStyle) setDevArchStyle(dev.profile.preferredArchitectureStyle);
            if (dev.profile.preferredHarness) setDevHarness(dev.profile.preferredHarness);
            setDevConventions((dev.profile.codingConventions ?? []).join(", "));
            setDevOptInCrossProject(dev.profile.optInCrossProject ?? true);
          }
        } catch {
          // handled on manual click
        }
      })();
    }
  }, [authenticated, workspace, projectId, apiUrl, apiKey]);

  async function enqueueRunnerTask() {
    if (!newTaskInstruction.trim()) return;
    try {
      const created = (await apiFetch(`/v1/projects/${projectId}/runner/tasks`, {
        method: "POST",
        body: JSON.stringify({ instruction: newTaskInstruction, priority: newTaskPriority })
      })) as RunnerTaskView;
      setNewTaskInstruction("");
      setStatusMsg(`Tarefa '${created.taskId}' enfileirada para o Brain Runner.`);
      await loadRunnerTasks();
    } catch (err) {
      setStatusMsg(`Erro ao enfileirar tarefa: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function answerRunnerQuestion(task: RunnerTaskView) {
    const response = runnerAnswers[task.taskId]?.trim();
    if (!task.pendingQuestion || !response) return;
    const idempotencyKey = runnerAnswerKeys[task.taskId] ?? crypto.randomUUID();
    setRunnerAnswerKeys((current) => ({ ...current, [task.taskId]: idempotencyKey }));
    try {
      const result = (await apiFetch(`/v1/projects/${projectId}/runner/tasks/${task.taskId}/responses`, {
        method: "POST",
        body: JSON.stringify({
          questionId: task.pendingQuestion.questionId,
          response,
          idempotencyKey
        })
      })) as { status: string; duplicate?: boolean };
      setRunnerAnswers((current) => ({ ...current, [task.taskId]: "" }));
      setRunnerAnswerKeys((current) => {
        const next = { ...current };
        delete next[task.taskId];
        return next;
      });
      setStatusMsg(`Resposta registrada; tarefa '${task.taskId}' ${result.duplicate ? "já estava retomada" : "voltou para a fila"}.`);
      await loadRunnerTasks();
    } catch (err) {
      setStatusMsg(`Erro ao responder pergunta do Runner: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function loadProjectOverview() {
    try {
      const data = (await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/overview`)) as ProjectOverview;
      setOverview(data);
      setStatusMsg(`Painel do projeto '${data.projectId}' atualizado com ${data.totalItems} item(ns) de conhecimento.`);
    } catch (err) {
      setStatusMsg(`Erro ao carregar projeto: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "#030712", color: "#f9fafb", fontFamily: "system-ui, sans-serif" }}>
      <aside style={{ width: 250, borderRight: "1px solid #1f2937", padding: 18, background: "#090d16" }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Noema</div>
        <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>Project Brain OS 2.0</div>
        {authenticated && authMe && (
          <div style={{ background: "#111827", border: "1px solid #1f2937", borderRadius: 8, padding: 10, marginBottom: 14, fontSize: 11, color: "#cbd5e1" }}>
            <div style={{ fontWeight: 600, color: "#f9fafb" }}>{authMe.actorId}</div>
            <div>Tenant: <code>{authMe.tenantId}</code></div>
            <div>Escopo: <code>{authMe.visibilityScope}</code></div>
            <div>Papéis: <code>{authMe.roles.join(", ")}</code></div>
          </div>
        )}
        <nav style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {WORKSPACES.filter((w) => {
            if (!authenticated || !authMe) return true;
            if (w.key === "access") return authMe.visibilityScope === "org" || authMe.visibilityScope === "project";
            return true;
          }).map((w) => (
            <button
              key={w.key}
              onClick={() => setWorkspace(w.key)}
              style={{
                textAlign: "left",
                padding: "9px 11px",
                borderRadius: 6,
                border: "none",
                cursor: "pointer",
                fontSize: 13,
                background: workspace === w.key ? "#1d4ed8" : "transparent",
                color: workspace === w.key ? "#fff" : "#d1d5db"
              }}
            >
              {w.label}
            </button>
          ))}
        </nav>
      </aside>

      <main style={{ flex: 1, padding: 24, maxWidth: 1120 }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 18 }}>
          <div>
            <h1 style={{ fontSize: 22, margin: 0 }}>
              {WORKSPACES.find((w) => w.key === workspace)?.label}
            </h1>
            <p style={{ color: "#9ca3af", margin: "4px 0 0", fontSize: 13 }}>{statusMsg}</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input style={inputStyle} value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="API URL" />
            {authenticated && authMe && authMe.allowedProjects.length > 0 ? (
              <select style={{ ...inputStyle, width: 140 }} value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Projeto autorizado">
                {authMe.allowedProjects.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            ) : (
              <input style={{ ...inputStyle, width: 120 }} value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="Project ID" />
            )}
            {!authenticated && <input style={inputStyle} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Chave local / token Bearer" type="password" aria-label="Chave local ou token Bearer" />}
            {!authenticated ? <>
              <button style={btnStyle} onClick={async () => {
                try {
                  const me = await apiFetch("/v1/auth/me") as {
                    tenantId: string;
                    actorId: string;
                    roles: string[];
                    allowedProjects: string[];
                    visibilityScope: "org" | "project" | "self";
                  };
                  await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/overview`);
                  setAuthMe(me);
                  setAuthenticated(true);
                  setStatusMsg(`Sessão autenticada (${me.actorId} · escopo ${me.visibilityScope}).`);
                } catch (error) {
                  setStatusMsg(`Não foi possível autenticar: ${error instanceof Error ? error.message : String(error)}`);
                }
              }}>Conectar</button>
              {oidcIssuer && oidcClientId && <button style={{ ...btnStyle, background: "#334155" }} onClick={() => void startOidcLogin()}>Entrar via OIDC</button>}
            </> : <button style={{ ...btnStyle, background: "#334155" }} onClick={() => {
              setApiKey(""); setAuthMe(null); setOidcRefreshToken(null); setOidcExpiresAt(0); setAuthenticated(false);
              setStatusMsg("Sessão encerrada.");
            }}>Sair</button>}
          </div>
        </header>

        {!authenticated ? (
          <section style={cardStyle} aria-label="Autenticação requerida">
            <h2 style={{ marginTop: 0 }}>Entre para abrir o Command Center</h2>
            <p style={{ color: "#cbd5e1", fontSize: 14 }}>Use uma chave local ou token Bearer autorizado para o projeto selecionado. Nenhuma credencial padrão é incluída no navegador.</p>
            {oidcIssuer && oidcClientId && <button style={btnStyle} onClick={() => void startOidcLogin()}>Entrar com OIDC</button>}
          </section>
        ) : <>
        {workspace === "inbox" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 16 }}>
            <section style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <h2 style={{ fontSize: 16, margin: 0 }}>Propostas Pendentes</h2>
                <button style={btnStyle} onClick={loadProposals}>Atualizar Caixa</button>
              </div>
              <section aria-label="Preferências pessoais de notificação" style={{ border: "1px solid #334155", borderRadius: 6, padding: 10, marginBottom: 12 }}>
                <strong style={{ fontSize: 12 }}>Minhas notificações</strong>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                  {(["slack", "teams", "jira", "clickup", "email"] as const).map((channel) => <label key={channel} style={{ fontSize: 11, color: "#cbd5e1" }}>
                    <input type="checkbox" checked={notificationPreferences.channels.includes(channel)} onChange={() => toggleNotificationChannel(channel)} /> {channel}
                  </label>)}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                  {(["approval", "runner_question"] as const).map((category) => <label key={category} style={{ fontSize: 11, color: "#cbd5e1" }}>
                    <input type="checkbox" checked={notificationPreferences.categories.includes(category)} onChange={() => toggleNotificationCategory(category)} /> {category === "approval" ? "Aprovações" : "Perguntas do Runner"}
                  </label>)}
                </div>
                <label style={{ display: "block", fontSize: 11, color: "#cbd5e1", marginTop: 8 }}>
                  Frequência de envio: {" "}
                  <select style={inputStyle} value={notificationPreferences.frequency} onChange={(event) => setNotificationPreferences((current) => ({ ...current, frequency: event.target.value as NotificationPreferencesView["frequency"] }))}>
                    <option value="immediate">Imediata</option>
                    <option value="daily">Resumo diário às 09:00 UTC</option>
                    <option value="weekly">Resumo semanal às segundas, 09:00 UTC</option>
                  </select>
                </label>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button style={btnStyle} onClick={saveNotificationPreferences}>Salvar preferências</button>
                  <button style={{ ...btnStyle, background: "#475569" }} onClick={resetNotificationPreferences}>Restaurar padrão</button>
                </div>
              </section>
              {approvalReminders.length > 0 && <section aria-label="Lembretes de aprovação" style={{ border: "1px solid #713f12", background: "#1c1917", borderRadius: 6, padding: 9, marginBottom: 12 }}>
                <strong style={{ fontSize: 12 }}>Lembretes e escalonamentos</strong>
                {approvalReminders.slice(0, 8).map((event, index) => <div key={`${event.proposalId}-${event.eventType}-${event.dueAt}-${index}`} style={{ fontSize: 11, color: "#fde68a", marginTop: 4 }}>
                  {event.eventType === "reminder" ? "Lembrete" : "Escalonada"}: {event.proposalId} · prazo {new Date(event.dueAt).toLocaleString()}
                </div>)}
              </section>}
              {proposals.length === 0 ? (
                <p style={{ color: "#9ca3af", fontSize: 13 }}>Clique em &quot;Atualizar Caixa&quot; para carregar itens em revisão.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  {proposals.map((p) => (
                    <li
                      key={p.id}
                      onClick={async () => {
                        setSelectedProposal(p);
                        setSelectedProposalHistory([]);
                        setSelectedProposalAudit([]);
                      setSelectedProposalEvidence(null);
                        try {
                        const targets = [...new Set([p.id, ...(p.relatedIds ?? [])])];
                        const [history, views, impact, audit] = await Promise.all([
                          apiFetch(`/v1/projects/${projectId}/knowledge/${encodeURIComponent(p.id)}/versions`) as Promise<{ versions?: ProposalVersionView[] }>,
                          apiFetch(`/v1/projects/${projectId}/enterprise/views`) as Promise<{ qaCoverage?: { coveragePercent: number; rows: ProposalEvidenceView["rows"] }; testExecutionResults?: ProposalEvidenceView["testExecutionResults"] }>,
                          apiFetch(`/v1/projects/${projectId}/change/impact`, { method: "POST", body: JSON.stringify({ targetIds: targets }) }) as Promise<Partial<ProposalEvidenceView>>,
                          apiFetch(`/v1/projects/${projectId}/proposals/${encodeURIComponent(p.id)}/history`) as Promise<{ events?: ProposalAuditEventView[] }>
                        ]);
                          setSelectedProposalHistory(history.versions ?? []);
                          setSelectedProposalAudit(audit.events ?? []);
                        setSelectedProposalEvidence({
                          coveragePercent: views.qaCoverage?.coveragePercent ?? null,
                          rows: views.qaCoverage?.rows ?? [],
                            testExecutionResults: views.testExecutionResults ?? [],
                          confirmedImpacts: impact.confirmedImpacts ?? [],
                          hypotheses: impact.hypotheses ?? [],
                          riskLevel: impact.riskLevel ?? "low",
                          directImpacts: impact.directImpacts ?? [],
                          transitiveImpacts: impact.transitiveImpacts ?? [],
                          crossServiceImpacts: impact.crossServiceImpacts ?? [],
                          criticalRulesImpacted: impact.criticalRulesImpacted ?? []
                        });
                        } catch (err) {
                          setStatusMsg(`Histórico da proposta indisponível: ${err instanceof Error ? err.message : String(err)}`);
                        }
                      }}
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        cursor: "pointer",
                        background: selectedProposal?.id === p.id ? "#1e293b" : "#0f172a",
                        border: selectedProposal?.id === p.id ? "1px solid #3b82f6" : "1px solid #1f2937"
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{p.title}</div>
                      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>
                        {p.id} · {p.status} · {p.sourceUri} · prazo {p.dueAt ? new Date(p.dueAt).toLocaleString() : "não definido"}{p.overdue ? " · vencida" : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Painel de Revisão Auditada</h2>
              {!selectedProposal ? (
                <p style={{ color: "#9ca3af", fontSize: 13 }}>Selecione uma proposta à esquerda para inspecionar evidências, conteúdo e decidir.</p>
              ) : (
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{selectedProposal.title}</div>
                  <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 10 }}>
                    ID: <code>{selectedProposal.id}</code> · Origem: <code>{selectedProposal.sourceUri}</code> · Política:{" "}
                    <code>{selectedProposal.accessPolicyId ?? "internal-project"}</code> · Confiança:{" "}
                    <code>{selectedProposal.trustLevel ?? "verified"}</code>
                  </div>
                  <section style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, border: "1px solid #334155", borderRadius: 6, padding: 9, marginBottom: 10 }}>
                    <span style={{ color: "#cbd5e1", fontSize: 12 }}>Responsável: <strong>{selectedProposal.assignedTo ?? "não atribuído"}</strong></span>
                    <span style={{ color: selectedProposal.overdue ? "#fca5a5" : "#cbd5e1", fontSize: 12 }}>Prazo: <strong>{selectedProposal.dueAt ? new Date(selectedProposal.dueAt).toLocaleString() : "não definido"}{selectedProposal.overdue ? " · vencido, aguardando decisão humana" : ""}</strong></span>
                    <input style={{ ...inputStyle, width: 92 }} value={reviewerProvider} onChange={(event) => setReviewerProvider(event.target.value)} aria-label="Provedor do revisor" />
                    <input style={{ ...inputStyle, width: 180 }} value={reviewerExternalId} onChange={(event) => setReviewerExternalId(event.target.value)} placeholder="ID externo do revisor" aria-label="ID externo do revisor" />
                    <button style={btnStyle} onClick={assignSelectedProposal} disabled={!reviewerExternalId.trim()}>Atribuir</button>
                  </section>
                  {(() => {
                    const previous = selectedProposalHistory
                      .filter((version) => version.version < selectedProposal.version)
                      .sort((a, b) => b.version - a.version)[0];
                    if (!previous) return <p style={{ color: "#9ca3af", fontSize: 12 }}>Não há uma versão anterior autorizada para comparar.</p>;
                    const diff = compareLines(previous.content ?? "", selectedProposal.content ?? "");
                    return (
                      <section style={{ border: "1px solid #334155", borderRadius: 6, marginBottom: 10, overflow: "hidden" }}>
                        <div style={{ padding: "8px 10px", background: "#0f172a", color: "#cbd5e1", fontSize: 12 }}>
                          Diff da versão {previous.version} para {selectedProposal.version}
                        </div>
                        {diff ? (
                          <pre style={{ background: "#030712", padding: 10, margin: 0, maxHeight: 220, overflow: "auto", fontSize: 11, whiteSpace: "pre-wrap" }}>
                            {diff.map((line, index) => <span key={`${index}-${line.kind}`} style={{ display: "block", color: line.kind === "added" ? "#86efac" : line.kind === "removed" ? "#fca5a5" : "#9ca3af" }}>{line.text || " "}</span>)}
                          </pre>
                        ) : (
                          <p style={{ color: "#9ca3af", padding: 10, fontSize: 12 }}>O conteúdo é extenso para diff linha a linha; abra o histórico para comparar as versões completas.</p>
                        )}
                      </section>
                    );
                  })()}
                  <section style={{ border: "1px solid #334155", borderRadius: 6, marginBottom: 10, padding: 10 }}>
                    <div style={{ color: "#e2e8f0", fontSize: 13, fontWeight: 600 }}>Histórico de revisão</div>
                    {selectedProposalAudit.length === 0 ? <div style={{ color: "#9ca3af", fontSize: 12, marginTop: 6 }}>Nenhum evento de auditoria disponível.</div> : (
                      <ol style={{ margin: "8px 0 0", paddingLeft: 20, color: "#cbd5e1", fontSize: 11 }}>
                        {selectedProposalAudit.map((event, index) => {
                          const comment = typeof event.metadata?.comment === "string" ? event.metadata.comment : undefined;
                          const version = typeof event.metadata?.version === "number" ? ` · versão ${event.metadata.version}` : "";
                          return <li key={`${event.createdAt}-${index}`} style={{ marginBottom: 5 }}>
                            <strong>{event.action}</strong>{version} · {event.actorId} ({event.actorType}) · {new Date(event.createdAt).toLocaleString()}
                            {comment ? <div style={{ color: "#9ca3af", marginTop: 2 }}>{comment}</div> : null}
                          </li>;
                        })}
                      </ol>
                    )}
                  </section>
                  {selectedProposalEvidence && (() => {
                    const evidence = selectedProposalEvidence;
                    const linkedIds = new Set<string>([selectedProposal.id, ...(selectedProposal.relatedIds ?? [])]);
                    for (const edge of evidence.confirmedImpacts) {
                      if (edge.fromItemId) linkedIds.add(edge.fromItemId);
                      if (edge.toItemId) linkedIds.add(edge.toItemId);
                      if (edge.itemId) linkedIds.add(edge.itemId);
                    }
                    const linkedRows = evidence.rows.filter((row) => linkedIds.has(row.ruleId));
                    const rows = linkedRows.length > 0 ? linkedRows : evidence.rows;
                    return (
                      <section style={{ border: "1px solid #334155", borderRadius: 6, marginBottom: 10, padding: 10 }}>
                        <div style={{ color: "#e2e8f0", fontSize: 13, fontWeight: 600 }}>Evidências do projeto</div>
                        <div style={{ color: "#9ca3af", fontSize: 12, marginTop: 5 }}>
                          Risco calculado: <strong style={{ color: evidence.riskLevel === "critical" || evidence.riskLevel === "high" ? "#f87171" : evidence.riskLevel === "medium" ? "#fbbf24" : "#86efac" }}>{evidence.riskLevel}</strong> · Cobertura QA: {evidence.coveragePercent === null ? "indisponível" : `${evidence.coveragePercent}%`} · {evidence.directImpacts.length} impacto(s) direto(s), {evidence.transitiveImpacts.length} transitivo(s), {evidence.hypotheses.length} hipótese(s)
                        </div>
                        {evidence.criticalRulesImpacted.length > 0 && <div style={{ color: "#fca5a5", fontSize: 11, marginTop: 5 }}>
                          Regras críticas afetadas: {evidence.criticalRulesImpacted.map((rule) => `${rule.id} (${rule.priority})`).join(", ")}
                        </div>}
                        {evidence.crossServiceImpacts.length > 0 && <div style={{ color: "#c4b5fd", fontSize: 11, marginTop: 5 }}>
                          Raio entre serviços: {evidence.crossServiceImpacts.map((impact) => `${impact.contractId}: ${impact.impactedProjects.join(", ")}`).join(" · ")}
                        </div>}
                        <div style={{ color: "#9ca3af", fontSize: 11, marginTop: 5 }}>
                          `VERIFIED_BY` confirma o vínculo estrutural. O status abaixo vem da execução mais recente registrada para cada arquivo.
                        </div>
                        {linkedRows.length === 0 && <div style={{ color: "#fbbf24", fontSize: 11, marginTop: 5 }}>Sem vínculo de impacto confirmado para esta proposta; as regras abaixo são a cobertura geral do projeto.</div>}
                        {rows.length === 0 ? <div style={{ color: "#9ca3af", fontSize: 12, marginTop: 8 }}>Nenhuma regra de negócio disponível para avaliar cobertura.</div> : (
                          <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "#cbd5e1" }}>
                            {rows.map((row) => <li key={row.ruleId} style={{ marginBottom: 5 }}>
                              <strong>{row.ruleId}</strong> · {row.title} · {row.covered ? `coberta por ${row.tests.map((testId) => {
                                const result = evidence.testExecutionResults?.find((entry) => entry.testItemId === testId);
                                return `${testId} (${result ? `${result.status}, ${result.commitSha.slice(0, 8)}` : "resultado de execução não registrado"})`;
                              }).join(", ")}` : "sem teste VERIFIED_BY"}
                            </li>)}
                          </ul>
                        )}
                      </section>
                    );
                  })()}
                  <pre style={{ background: "#030712", padding: 12, borderRadius: 6, maxHeight: 240, overflow: "auto", fontSize: 12, whiteSpace: "pre-wrap" }}>
                    {selectedProposal.content ?? "(sem conteúdo)"}
                  </pre>
                  <textarea
                    style={{ ...inputStyle, width: "100%", minHeight: 64, marginTop: 10, boxSizing: "border-box" }}
                    value={reviewComment}
                    onChange={(e) => setReviewComment(e.target.value)}
                    placeholder="Justificativa / comentário da revisão (registrado em audit_logs)..."
                  />
                  <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
                    <button style={{ ...btnStyle, background: "#059669" }} onClick={() => decideProposal(selectedProposal.id, selectedProposal.version, "approve")}>
                      Aprovar Oficialmente
                    </button>
                    <button style={{ ...btnStyle, background: "#d97706" }} onClick={() => decideProposal(selectedProposal.id, selectedProposal.version, "request_changes")}>
                      Solicitar Alterações
                    </button>
                    <button style={{ ...btnStyle, background: "#dc2626" }} onClick={() => decideProposal(selectedProposal.id, selectedProposal.version, "reject")}>
                      Rejeitar Proposta
                    </button>
                    <button
                      style={{ ...btnStyle, background: "#475569" }}
                      onClick={async () => {
                        try {
                          const res = (await apiFetch(`/v1/projects/${projectId}/proposals/${encodeURIComponent(selectedProposal.id)}/notify`, {
                            method: "POST",
                            body: JSON.stringify({ channel: "slack" })
                          })) as { delivered?: boolean; reason?: string };
                          setStatusMsg(res.delivered ? "Notificação enviada para Slack." : res.reason ?? "Webhook Slack não configurado.");
                        } catch (err) {
                          setStatusMsg(`Erro ao notificar: ${err instanceof Error ? err.message : String(err)}`);
                        }
                      }}
                    >
                      Notificar Slack
                    </button>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {workspace === "projects" && (
          <div>
            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, margin: "0 0 6px" }}>Conectar repositório GitHub</h2>
              <p style={{ color: "#9ca3af", fontSize: 13, marginTop: 0 }}>A ingestão é somente leitura, fixada no commit recebido e processada em segundo plano. Repositórios públicos entram como referência externa não confiável.</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input style={{ ...inputStyle, width: 150 }} value={githubOwner} onChange={(event) => setGithubOwner(event.target.value)} placeholder="Owner / organização" aria-label="Owner do GitHub" />
                <input style={{ ...inputStyle, width: 180 }} value={githubRepo} onChange={(event) => setGithubRepo(event.target.value)} placeholder="Repositório" aria-label="Repositório GitHub" />
                <input style={{ ...inputStyle, width: 150 }} value={githubRef} onChange={(event) => setGithubRef(event.target.value)} placeholder="Branch, tag ou SHA" aria-label="Branch, tag ou SHA" />
                <button style={btnStyle} onClick={() => void startGitHubIngestion()}>Iniciar ingestão</button>
                <button style={{ ...btnStyle, background: "#334155" }} onClick={() => void loadGitHubJobs()}>Atualizar estado</button>
              </div>
            </section>
            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>Fontes GitHub e ingestões recentes</h2>
              {githubJobs.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 0 }}>Nenhuma ingestão remota registrada para este projeto.</p> : (
                <div style={{ display: "grid", gap: 8 }}>
                  {githubJobs.slice(0, 10).map((job) => {
                    const hasErrors = Number(job.result?.errors ?? 0) > 0;
                    const hasWarnings = (job.result?.warnings?.length ?? 0) > 0;
                    const label = job.state === "completed" && hasErrors ? "Concluída com erros" : job.state === "completed" && hasWarnings ? "Concluída com avisos" : job.state === "completed" ? "Concluída" : job.state === "active" ? "Processando" : job.state === "failed" || job.state === "expired" ? "Falhou" : job.state === "retry" ? "Aguardando nova tentativa" : "Na fila";
                    const color = job.state === "completed" && !hasErrors ? "#34d399" : hasErrors || job.state === "failed" || job.state === "expired" ? "#f87171" : "#fbbf24";
                    return <div key={job.jobId} style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap", border: "1px solid #1f2937", borderRadius: 7, padding: 10 }}>
                      <div>
                        <strong style={{ fontSize: 13 }}>{job.owner}/{job.repo}</strong>
                        <div style={{ color: "#9ca3af", fontSize: 11, marginTop: 3 }}>Ref: {job.ref} · iniciada {new Date(job.createdAt).toLocaleString()}</div>
                        {job.result && <div style={{ color: hasErrors ? "#fca5a5" : "#9ca3af", fontSize: 11, marginTop: 4 }}>
                          {job.result.ingested ?? 0} itens · {job.result.chunksEmbedded ?? 0} chunks vetorizados · {job.result.skippedSecrets ?? 0} arquivos barrados por segredo
                        </div>}
                        {job.result?.warnings?.map((warning, index) => <div key={`${job.jobId}-warning-${index}`} style={{ color: "#fbbf24", fontSize: 11, marginTop: 3 }}>{warning}</div>)}
                        {job.retries > 0 && <div style={{ color: "#fbbf24", fontSize: 11 }}>Tentativas: {job.retries}</div>}
                      </div>
                      <span style={{ color, fontSize: 12, fontWeight: 600 }}>{label}</span>
                    </div>;
                  })}
                </div>
              )}
            </section>
            <section style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <div>
                <h2 style={{ fontSize: 16, margin: "0 0 5px" }}>Saúde do projeto</h2>
                <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>Resumo calculado a partir do conhecimento autorizado para este projeto.</p>
              </div>
              <button style={btnStyle} onClick={loadProjectOverview}>Atualizar painel</button>
            </section>
            {!overview ? (
              <section style={cardStyle}>
                <h3 style={{ fontSize: 15, marginTop: 0 }}>Conecte e carregue seus dados</h3>
                <p style={{ color: "#9ca3af", fontSize: 13 }}>Informe a API, o projeto e a credencial no topo; depois carregue o painel para ver itens aprovados, rascunhos e alertas de saúde.</p>
                <button style={btnStyle} onClick={loadProjectOverview}>Carregar dados de {projectId}</button>
              </section>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 16 }}>
                  {[
                    { label: "Saúde", value: `${overview.health.healthScore}%`, detail: "índice de saúde do conhecimento", color: overview.health.healthScore >= 80 ? "#34d399" : "#fbbf24" },
                    { label: "Conhecimento ativo", value: String(overview.totalItems), detail: "itens visíveis neste projeto", color: "#93c5fd" },
                    { label: "Aprovados", value: String(overview.approvedCount), detail: "conhecimento oficial", color: "#34d399" },
                    { label: "Em rascunho", value: String(overview.draftCount), detail: "aguardando revisão", color: "#fbbf24" }
                  ].map((metric) => (
                    <section key={metric.label} style={{ ...cardStyle, marginBottom: 0 }}>
                      <div style={{ color: "#9ca3af", fontSize: 12 }}>{metric.label}</div>
                      <div style={{ color: metric.color, fontSize: 28, fontWeight: 700, margin: "5px 0" }}>{metric.value}</div>
                      <div style={{ color: "#9ca3af", fontSize: 11 }}>{metric.detail}</div>
                    </section>
                  ))}
                </div>
                <section style={cardStyle}>
                  <h2 style={{ fontSize: 16, marginTop: 0 }}>Atenção necessária <span style={{ color: "#9ca3af", fontSize: 12, fontWeight: 400 }}>({overview.alerts.length})</span></h2>
                  {overview.alerts.length === 0 ? (
                    <p style={{ color: "#34d399", fontSize: 13, marginBottom: 0 }}>Nenhum alerta encontrado para os dados atuais.</p>
                  ) : (
                    <ul style={{ paddingLeft: 20, marginBottom: 0, color: "#fbbf24", fontSize: 13 }}>
                      {overview.alerts.map((alert, index) => <li key={`${index}-${alert}`} style={{ marginBottom: 7 }}>{alert}</li>)}
                    </ul>
                  )}
                </section>
                <section style={{ ...cardStyle, color: "#9ca3af", fontSize: 12 }}>
                  Regras sem testes: {overview.health.untestedRuleIds.length} · Itens desatualizados: {overview.health.staleItemIds.length} · Conflitos de origem: {overview.health.gitVsConnectorConflicts.length}
                </section>
              </>
            )}
          </div>
        )}

        {workspace === "agents" && (
          <div>
            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Delegar Tarefa ao Brain Runner</h2>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  style={{ ...inputStyle, flex: 1, minWidth: 260 }}
                  value={newTaskInstruction}
                  onChange={(e) => setNewTaskInstruction(e.target.value)}
                  placeholder="Instrução para o Brain Runner (modo draft-only)..."
                />
                <select style={inputStyle} value={newTaskPriority} onChange={(e) => setNewTaskPriority(e.target.value as "low" | "normal" | "high")}>
                  <option value="low">low</option>
                  <option value="normal">normal</option>
                  <option value="high">high</option>
                </select>
                <button style={btnStyle} onClick={enqueueRunnerTask}>Enfileirar Tarefa</button>
                <button style={{ ...btnStyle, background: "#334155" }} onClick={loadRunnerTasks}>Atualizar Fila &amp; Handoffs</button>
              </div>
            </section>

            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Execuções do Brain Runner</h2>
              {runnerTasks.length === 0 ? (
                <p style={{ color: "#9ca3af", fontSize: 13 }}>Nenhuma tarefa carregada. Clique em &quot;Atualizar Fila &amp; Handoffs&quot;.</p>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ textAlign: "left", borderBottom: "1px solid #1f2937", color: "#9ca3af" }}>
                      <th style={{ padding: 6 }}>ID</th>
                      <th style={{ padding: 6 }}>Status</th>
                      <th style={{ padding: 6 }}>Prioridade</th>
                      <th style={{ padding: 6 }}>Instrução</th>
                      <th style={{ padding: 6 }}>Resultado</th>
                      <th style={{ padding: 6 }}>Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runnerTasks.map((t) => (
                      <tr key={t.taskId} style={{ borderBottom: "1px solid #1f2937" }}>
                        <td style={{ padding: 6 }}><code>{t.taskId.slice(0, 12)}</code></td>
                        <td style={{ padding: 6 }}>
                          <span style={{ color: t.status === "completed" ? "#34d399" : t.status === "failed" || t.status === "cancelled" ? "#f87171" : "#fbbf24" }}>{t.status}</span>
                        </td>
                        <td style={{ padding: 6 }}>{t.priority}</td>
                        <td style={{ padding: 6 }}>
                          {t.instruction}
                          {t.pendingQuestion && (
                            <div style={{ marginTop: 8, padding: 8, border: "1px solid #92400e", borderRadius: 6, background: "#1c1917" }}>
                              <div style={{ color: "#fbbf24", marginBottom: 6 }}>Pergunta do Runner: {t.pendingQuestion.question}</div>
                              <div style={{ display: "flex", gap: 6 }}>
                                <input
                                  style={{ ...inputStyle, flex: 1, minWidth: 180 }}
                                  value={runnerAnswers[t.taskId] ?? ""}
                                  onChange={(event) => setRunnerAnswers((current) => ({ ...current, [t.taskId]: event.target.value }))}
                                  placeholder="Responder para retomar a tarefa"
                                />
                                <button style={btnStyle} onClick={() => answerRunnerQuestion(t)}>Responder e retomar</button>
                              </div>
                            </div>
                          )}
                        </td>
                        <td style={{ padding: 6, color: "#9ca3af" }}>{t.resultSummary ?? "—"}</td>
                        <td style={{ padding: 6 }}>
                          {["queued", "waiting_human", "escalated"].includes(t.status) && (
                            <button style={{ ...btnStyle, background: "#dc2626", padding: "4px 8px", fontSize: 11 }} onClick={() => void cancelRunnerTask(t.taskId)}>
                              Cancelar
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {runnerSchedules.length > 0 && (
              <section style={cardStyle}>
                <h2 style={{ fontSize: 16, marginTop: 0 }}>Agendamentos Cron do Runner</h2>
                <div style={{ display: "grid", gap: 8 }}>
                  {runnerSchedules.map((s) => (
                    <div key={s.scheduleId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, borderBottom: "1px solid #1f2937", paddingBottom: 8, fontSize: 12 }}>
                      <div>
                        <strong>{s.instruction}</strong>
                        <div style={{ color: "#9ca3af", fontSize: 11 }}>Cron: <code>{s.cron}</code> · prioridade: {s.priority} · ID: <code>{s.scheduleId}</code></div>
                      </div>
                      <button style={{ ...btnStyle, background: "#dc2626", padding: "4px 8px", fontSize: 11 }} onClick={() => void cancelRunnerSchedule(s.scheduleId)}>Cancelar Cron</button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Agent Handoffs ({handoffsList.length})</h2>
              {handoffsList.length === 0 ? (
                <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 0 }}>Nenhum handoff registrado para este projeto.</p>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {handoffsList.map((h) => (
                    <article key={h.handoffId} style={{ border: "1px solid #1f2937", borderRadius: 8, padding: 12, background: "#0b1220", fontSize: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                        <strong>{h.fromAgent} → Tarefa <code>{h.taskId}</code></strong>
                        <span style={{ color: "#93c5fd" }}>branch: <code>{h.branch}</code> · commit: <code>{h.baseCommitSha.slice(0, 10)}</code></span>
                      </div>
                      {h.modifiedFiles?.length > 0 && (
                        <div style={{ color: "#cbd5e1", marginTop: 6 }}>Arquivos: {h.modifiedFiles.join(", ")}</div>
                      )}
                      {h.nextSteps?.length > 0 && (
                        <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "#9ca3af" }}>
                          {h.nextSteps.map((step, i) => <li key={`${h.handoffId}-step-${i}`}>{step}</li>)}
                        </ul>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </section>

            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Planejador Autônomo de Tarefas</h2>
              <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 0 }}>Gera épico, histórias e tarefas priorizadas com base nas regras e cobertura QA do projeto.</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                <input
                  style={{ ...inputStyle, flex: 1, minWidth: 260 }}
                  value={epicInput}
                  onChange={(e) => setEpicInput(e.target.value)}
                  placeholder="Descreva o épico (ex.: Implementar cancelamento com retenção e auditoria)"
                />
                <button
                  style={btnStyle}
                  onClick={async () => {
                    if (!epicInput.trim()) return;
                    try {
                      const data = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/tasks/plan`, {
                        method: "POST",
                        body: JSON.stringify({ epicDescription: epicInput.trim() })
                      }) as { tasks?: PlannedTaskView[]; evaluatedRulesCount?: number };
                      setPlannedTasks(data.tasks ?? []);
                      setStatusMsg(`Plano gerado com ${(data.tasks ?? []).length} item(ns) a partir de ${data.evaluatedRulesCount ?? 0} regra(s).`);
                    } catch (err) {
                      setStatusMsg(`Erro ao planejar tarefas: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }}
                >
                  Gerar Plano
                </button>
              </div>
              {plannedTasks.length > 0 && (
                <div style={{ display: "grid", gap: 8 }}>
                  {plannedTasks.map((t) => (
                    <article key={t.id} style={{ border: "1px solid #1f2937", borderRadius: 8, padding: 10, background: "#0b1220", fontSize: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                        <strong>[{t.kind.toUpperCase()}] {t.id} · {t.title}</strong>
                        <span style={{ color: t.priority === "critical" ? "#f87171" : t.priority === "high" ? "#fbbf24" : "#93c5fd" }}>{t.priority}</span>
                      </div>
                      <p style={{ margin: "4px 0", color: "#cbd5e1" }}>{t.description}</p>
                      {t.acceptanceCriteria.length > 0 && (
                        <div style={{ color: "#9ca3af", fontSize: 11 }}>Critérios: {t.acceptanceCriteria.join(" | ")}</div>
                      )}
                      {t.kind === "task" && (
                        <button
                          style={{ ...btnStyle, marginTop: 6, background: "#334155", padding: "4px 10px", fontSize: 11 }}
                          onClick={async () => {
                            try {
                              await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/runner/tasks`, {
                                method: "POST",
                                body: JSON.stringify({ instruction: `${t.title}: ${t.description}`, priority: t.priority === "critical" ? "high" : t.priority })
                              });
                              setStatusMsg(`Tarefa ${t.id} enfileirada no Brain Runner.`);
                              await loadRunnerTasks();
                            } catch (err) {
                              setStatusMsg(`Erro ao enfileirar: ${err instanceof Error ? err.message : String(err)}`);
                            }
                          }}
                        >
                          Enviar ao Runner
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {workspace === "knowledge" && (
          <div>
            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Catálogo de Conhecimento ({knowledgeCatalog.length})</h2>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                <input style={{ ...inputStyle, flex: 1, minWidth: 220 }} value={knowledgeQuery} onChange={(e) => setKnowledgeQuery(e.target.value)} placeholder="Filtrar itens do projeto..." />
                <select style={inputStyle} value={knowledgeTypeFilter} onChange={(e) => setKnowledgeTypeFilter(e.target.value)}>
                  <option value="all">Todos os tipos</option>
                  <option value="business_rule">Regras de Negócio</option>
                  <option value="architecture_decision">ADRs</option>
                  <option value="document">Documentos</option>
                  <option value="code_symbol">Código / Símbolos</option>
                  <option value="test_case">Testes</option>
                </select>
                <button style={btnStyle} onClick={() => void loadKnowledgeCatalog()}>Buscar no Catálogo</button>
              </div>
              <div style={{ display: "grid", gap: 6, maxHeight: 260, overflowY: "auto" }}>
                {knowledgeCatalog
                  .filter((h) => knowledgeTypeFilter === "all" || h.type === knowledgeTypeFilter)
                  .slice(0, 30)
                  .map((h) => (
                    <button
                      key={h.id}
                      onClick={() => {
                        setGraphRootId(h.id);
                        setRevisionItem({
                          id: h.id, title: h.title, type: h.type, domainId: h.domainId,
                          status: h.status, trustLevel: h.trustLevel, sourceOrigin: h.sourceOrigin,
                          sourceUri: h.sourceUri, version: h.version, content: h.content
                        });
                        setRevisionContent(h.content);
                        setStatusMsg(`Item '${h.id}' selecionado.`);
                      }}
                      style={{
                        textAlign: "left", background: graphRootId === h.id ? "#1e3a8a" : "#0b1220",
                        border: "1px solid #1f2937", borderRadius: 6, padding: "8px 10px", color: "#f9fafb", cursor: "pointer", fontSize: 12
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <strong>{h.title}</strong>
                        <span style={{ color: h.status === "approved" ? "#34d399" : "#fbbf24" }}>{h.type} · {h.status} · v{h.version}</span>
                      </div>
                      <div style={{ color: "#9ca3af", fontSize: 11, marginTop: 2 }}>{h.id} · {h.sourceUri} · {h.trustLevel}</div>
                    </button>
                  ))}
                {knowledgeCatalog.length === 0 && <p style={{ color: "#9ca3af", fontSize: 12, margin: 0 }}>Nenhum item carregado.</p>}
              </div>
            </section>

            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Inspecionar &amp; Revisar Item / Proposta</h2>
              <p style={{ color: "#9ca3af", fontSize: 13 }}>Selecione um item acima ou informe o ID. Somente o autor pode reenviar propostas com alterações solicitadas.</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                <input style={{ ...inputStyle, flex: 1, minWidth: 240 }} value={graphRootId} onChange={(event) => setGraphRootId(event.target.value)} placeholder="ID do item ou proposta" />
                <button style={{ ...btnStyle, background: "#334155" }} onClick={async () => {
                  try {
                    const data = await apiFetch(`/v1/projects/${projectId}/knowledge/${encodeURIComponent(graphRootId)}`) as { item?: KnowledgeProposal };
                    if (!data.item) throw new Error("Item não encontrado.");
                    setRevisionItem(data.item);
                    setRevisionContent(data.item.content ?? "");
                    setStatusMsg(`Item ${data.item.id} carregado na versão ${data.item.version}.`);
                  } catch (err) { setStatusMsg(`Erro ao carregar item: ${err instanceof Error ? err.message : String(err)}`); }
                }}>Carregar item</button>
              </div>
              {revisionItem && (
                <div>
                  <div style={{ color: "#9ca3af", fontSize: 12, marginBottom: 8 }}>{revisionItem.id} · versão {revisionItem.version} · status {revisionItem.status} · {revisionItem.sourceUri}</div>
                  <textarea style={{ ...inputStyle, display: "block", width: "100%", minHeight: 140, boxSizing: "border-box", marginBottom: 10 }} value={revisionContent} onChange={(event) => setRevisionContent(event.target.value)} aria-label="Conteúdo revisado da proposta" />
                  <button style={{ ...btnStyle, background: "#d97706" }} onClick={async () => {
                    try {
                      const result = await apiFetch(`/v1/projects/${projectId}/proposals/${encodeURIComponent(revisionItem.id)}/revise`, {
                        method: "POST", body: JSON.stringify({ baseVersion: revisionItem.version, content: revisionContent })
                      }) as { version: number };
                      const refreshed = await apiFetch(`/v1/projects/${projectId}/knowledge/${encodeURIComponent(revisionItem.id)}`) as { item?: KnowledgeProposal };
                      if (refreshed.item) setRevisionItem(refreshed.item);
                      setStatusMsg(`Proposta reaberta para revisão na versão ${result.version}.`);
                    } catch (err) { setStatusMsg(`Erro ao reenviar proposta: ${err instanceof Error ? err.message : String(err)}`); }
                  }}>Reenviar para aprovação</button>
                </div>
              )}
            </section>

            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Knowledge Graph &amp; Time Machine</h2>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                <input style={{ ...inputStyle, minWidth: 300 }} value={graphRootId} onChange={(e) => setGraphRootId(e.target.value)} placeholder="Root ID" />
                <button
                  style={btnStyle}
                  onClick={async () => {
                    try {
                      const gData = (await apiFetch(`/v1/projects/${projectId}/graph/${encodeURIComponent(graphRootId)}/related?depth=2`)) as { edges?: GraphEdgeView[] };
                      setGraphEdges(gData.edges ?? []);
                      setStatusMsg(`Grafo carregado para '${graphRootId}': ${(gData.edges ?? []).length} aresta(s).`);
                    } catch (err) {
                      setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }}
                >
                  Explorar Grafo
                </button>
                <button
                  style={{ ...btnStyle, background: "#334155" }}
                  onClick={async () => {
                    try {
                      const data = await apiFetch(`/v1/projects/${projectId}/knowledge/${encodeURIComponent(graphRootId)}/versions`) as { versions?: ProposalVersionView[] };
                      setKnowledgeVersions(data.versions ?? []);
                      setStatusMsg(`Histórico de versões carregado: ${(data.versions ?? []).length} versão(ões).`);
                    } catch (err) {
                      setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }}
                >
                  Histórico de Versões
                </button>
              </div>
              <svg width="640" height={Math.max(80, graphEdges.length * 46 + 32)} style={{ display: "block", background: "#030712", borderRadius: 8, marginBottom: 14 }}>
                {graphEdges.length === 0 ? (
                  <text x="16" y="44" fill="#9ca3af" fontSize="12">Nenhuma aresta carregada.</text>
                ) : (
                  graphEdges.map((edge, idx) => {
                    const y = 30 + idx * 44;
                    const fromLabel = edge.fromItemId ?? graphRootId;
                    const toLabel = edge.toItemId ?? edge.itemId ?? "";
                    const relLabel = edge.relationType ?? edge.via ?? "RELATED";
                    return (
                      <g key={`${fromLabel}-${toLabel}-${idx}`} style={{ cursor: "pointer" }} onClick={() => toLabel && setGraphRootId(toLabel)}>
                        <rect x="16" y={y - 14} width="200" height="28" rx="6" fill="#2563eb" />
                        <text x="24" y={y + 4} fill="#fff" fontSize="11">{fromLabel.slice(0, 28)}</text>
                        <line x1="216" y1={y} x2="360" y2={y} stroke="#60a5fa" strokeWidth="2" />
                        <text x="240" y={y - 6} fill="#93c5fd" fontSize="10">{relLabel}</text>
                        <rect x="360" y={y - 14} width="220" height="28" rx="6" fill="#059669" />
                        <text x="368" y={y + 4} fill="#fff" fontSize="11">{toLabel.slice(0, 30)}</text>
                      </g>
                    );
                  })
                )}
              </svg>
              {knowledgeVersions.length > 0 && (
                <div style={{ marginBottom: 14, display: "grid", gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>Versões de {graphRootId}</strong>
                  {knowledgeVersions.map((v) => (
                    <div key={`ver-${v.version}`} style={{ border: "1px solid #1f2937", borderRadius: 6, padding: 10, background: "#0b1220", fontSize: 12 }}>
                      <div><strong>v{v.version}</strong> · <span style={{ color: v.status === "approved" ? "#34d399" : "#fbbf24" }}>{v.status}</span></div>
                      {v.content && <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", color: "#cbd5e1", fontSize: 11 }}>{v.content.slice(0, 500)}</pre>}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input style={{ ...inputStyle, width: 260 }} value={atTimestamp} onChange={(e) => setAtTimestamp(e.target.value)} />
                <button
                  style={{ ...btnStyle, background: "#334155" }}
                  onClick={async () => {
                    try {
                      const data = await apiFetch(`/v1/projects/${projectId}/temporal/query`, {
                        method: "POST",
                        body: JSON.stringify({ atTimestamp })
                      }) as { items?: Array<{ id: string; title: string; type?: string; status?: string; version?: number; sourceUri?: string }> };
                      setTemporalItems(data.items ?? []);
                      setStatusMsg(`Snapshot temporal consultado: ${(data.items ?? []).length} item(ns) válidos em ${atTimestamp}.`);
                    } catch (err) {
                      setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }}
                >
                  Consultar Time Machine
                </button>
              </div>
              {temporalItems.length > 0 && (
                <div style={{ marginTop: 12, display: "grid", gap: 6 }}>
                  {temporalItems.slice(0, 20).map((item) => (
                    <div key={`tmp-${item.id}`} style={{ borderBottom: "1px solid #1f2937", padding: "6px 0", fontSize: 12 }}>
                      <strong>{item.title}</strong> · <span style={{ color: "#93c5fd" }}>{item.type}</span> · {item.status} · v{item.version ?? 1}
                      <div style={{ color: "#9ca3af", fontSize: 11 }}>{item.id} · {item.sourceUri}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Living Documentation (Sugestões por Arquivos Alterados)</h2>
              <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 0 }}>Correlaciona arquivos modificados com ADRs, serviços e contratos do projeto para sugerir atualizações em draft.</p>
              <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                <input
                  style={inputStyle}
                  value={livingDocFiles}
                  onChange={(e) => setLivingDocFiles(e.target.value)}
                  placeholder="Arquivos alterados separados por vírgula (ex.: src/api/auth.ts, docs/00-normative-decisions.md)"
                />
                <input
                  style={inputStyle}
                  value={livingDocSummary}
                  onChange={(e) => setLivingDocSummary(e.target.value)}
                  placeholder="Resumo opcional das alterações"
                />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    style={btnStyle}
                    onClick={async () => {
                      const files = livingDocFiles.split(",").map((s) => s.trim()).filter(Boolean);
                      if (files.length === 0) return;
                      try {
                        const data = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/living-docs/suggest`, {
                          method: "POST",
                          body: JSON.stringify({ changedFiles: files, diffSummary: livingDocSummary || undefined, submitDrafts: false })
                        }) as { drafts?: LivingDocDraftView[] };
                        setLivingDocDrafts(data.drafts ?? []);
                        setStatusMsg(`Living Documentation gerou ${(data.drafts ?? []).length} sugestão(ões).`);
                      } catch (err) {
                        setStatusMsg(`Erro ao gerar sugestões: ${err instanceof Error ? err.message : String(err)}`);
                      }
                    }}
                  >
                    Sugerir Atualizações
                  </button>
                  <button
                    style={{ ...btnStyle, background: "#059669" }}
                    onClick={async () => {
                      const files = livingDocFiles.split(",").map((s) => s.trim()).filter(Boolean);
                      if (files.length === 0) return;
                      try {
                        const data = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/living-docs/suggest`, {
                          method: "POST",
                          body: JSON.stringify({ changedFiles: files, diffSummary: livingDocSummary || undefined, submitDrafts: true })
                        }) as { drafts?: LivingDocDraftView[]; submittedCount?: number };
                        setLivingDocDrafts(data.drafts ?? []);
                        setStatusMsg(`${data.submittedCount ?? 0} proposta(s) de Living Doc enviadas à fila de aprovação.`);
                      } catch (err) {
                        setStatusMsg(`Erro ao enviar propostas: ${err instanceof Error ? err.message : String(err)}`);
                      }
                    }}
                  >
                    Enviar para Fila de Aprovação
                  </button>
                </div>
              </div>
              {livingDocDrafts.length > 0 && (
                <div style={{ display: "grid", gap: 8 }}>
                  {livingDocDrafts.map((d) => (
                    <article key={d.id} style={{ border: "1px solid #1f2937", borderRadius: 8, padding: 10, background: "#0b1220", fontSize: 12 }}>
                      <strong>{d.title}</strong> · <span style={{ color: "#fbbf24" }}>{d.status}</span>
                      <div style={{ color: "#9ca3af", fontSize: 11, marginTop: 4 }}>{d.reason}</div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {workspace === "search" && (
          <div>
            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Busca Híbrida &amp; Context Pack</h2>
              <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <input style={{ ...inputStyle, flex: 1, minWidth: 260 }} value={contextTask} onChange={(e) => setContextTask(e.target.value)} placeholder="Descreva a tarefa ou consulta..." />
                <input style={{ ...inputStyle, width: 120 }} value={searchDomainFilter} onChange={(e) => setSearchDomainFilter(e.target.value)} placeholder="Domínio (1-12)" />
                <button
                  style={{ ...btnStyle, background: "#334155" }}
                  onClick={async () => {
                    try {
                      const domains = searchDomainFilter.split(",").map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0);
                      const data = await apiFetch(`/v1/projects/${projectId}/search`, {
                        method: "POST",
                        body: JSON.stringify({ query: contextTask, ...(domains.length > 0 ? { domains } : {}), limit: 20 })
                      }) as { items?: SearchHitView[] };
                      setSearchResults(data.items ?? []);
                      setStatusMsg(`Busca híbrida retornou ${(data.items ?? []).length} resultado(s).`);
                    } catch (err) {
                      setStatusMsg(`Erro na busca: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }}
                >
                  Buscar (Híbrido)
                </button>
                <button
                  style={btnStyle}
                  onClick={async () => {
                    try {
                      const sessionId = contextSessionId || crypto.randomUUID();
                      setContextSessionId(sessionId);
                      const domains = searchDomainFilter.split(",").map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0);
                      const data = await apiFetch(`/v1/projects/${projectId}/context`, {
                        method: "POST",
                        body: JSON.stringify({ task: contextTask, sessionId, explain: true, tokenBudget: 4000, ...(domains.length > 0 ? { includeDomains: domains } : {}) })
                      }) as ContextPackView;
                      setContextSourceIds(Array.isArray(data?.sources) ? data.sources.map((source) => source.id) : []);
                      setContextPack(data);
                      setStatusMsg("Context Pack montado com explicabilidade.");
                    } catch (err) {
                      setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }}
                >
                  Montar Context Pack (Explain)
                </button>
                {(["useful", "incomplete", "incorrect"] as const).map((rating) => (
                  <button
                    key={rating}
                    style={{ ...btnStyle, background: rating === "useful" ? "#059669" : rating === "incomplete" ? "#d97706" : "#dc2626" }}
                    onClick={async () => {
                      try {
                        const data = await apiFetch(`/v1/projects/${projectId}/search/feedback`, {
                          method: "POST",
                          body: JSON.stringify({ query: contextTask, rating, ...(contextSessionId ? { sessionId: contextSessionId, itemIds: contextSourceIds } : {}) })
                        });
                        setStatusMsg(`Feedback '${rating}' registrado.${data?.hitRate ? ` Context Hit Rate: ${data.hitRate.hits}/${data.hitRate.itemsSent}.` : ""}`);
                      } catch (err) {
                        setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
                      }
                    }}
                  >
                    {rating === "useful" ? "Útil" : rating === "incomplete" ? "Incompleto" : "Incorreto"}
                  </button>
                ))}
              </div>
            </section>

            {contextPack && (
              <section style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>Context Pack · {contextPack.project}</h3>
                  <div style={{ fontSize: 12, color: "#93c5fd" }}>
                    {contextPack.hitRate ? `Hit Rate: ${contextPack.hitRate.hits}/${contextPack.hitRate.itemsSent} (${Math.round(contextPack.hitRate.rate * 100)}%)` : ""}
                    {contextPack.tokenUsage ? ` · Tokens: ${contextPack.tokenUsage.used ?? 0}/${contextPack.tokenUsage.budget ?? 4000}` : ""}
                  </div>
                </div>
                {(contextPack.warnings?.length ?? 0) > 0 && (
                  <div style={{ background: "#451a03", border: "1px solid #92400e", borderRadius: 6, padding: 10, marginBottom: 12, fontSize: 12, color: "#fde68a" }}>
                    <strong>Avisos:</strong> {contextPack.warnings!.join(" | ")}
                  </div>
                )}
                {(contextPack.sources?.length ?? 0) > 0 && (
                  <div style={{ display: "grid", gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>Fontes selecionadas ({contextPack.sources!.length})</strong>
                    {contextPack.sources!.map((s, idx) => (
                      <div key={`src-${s.id}-${idx}`} style={{ border: "1px solid #1f2937", borderRadius: 6, padding: 10, background: "#0b1220", fontSize: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <strong>{s.title ?? s.id}</strong>
                          <span style={{ color: s.trustLevel === "verified" ? "#34d399" : "#fbbf24" }}>{s.status ?? "active"} · {s.trustLevel ?? "n/d"} · {s.sourceOrigin ?? "internal"}</span>
                        </div>
                        <div style={{ color: "#9ca3af", fontSize: 11, marginTop: 3 }}>{s.id} · {s.sourceUri ?? "—"}</div>
                        {s.explain && s.explain.length > 0 && (
                          <div style={{ color: "#93c5fd", fontSize: 11, marginTop: 4 }}>Por que entrou: {s.explain.join(", ")}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {searchResults.length > 0 && (
              <section style={cardStyle}>
                <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Resultados da Busca Híbrida ({searchResults.length})</h3>
                <div style={{ display: "grid", gap: 8 }}>
                  {searchResults.map((hit) => (
                    <div key={hit.id} style={{ border: "1px solid #1f2937", borderRadius: 6, padding: 10, background: "#0b1220", fontSize: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <strong>{hit.title}</strong>
                        <span style={{ color: "#34d399" }}>score: {hit.score.toFixed(3)} · {hit.type} · {hit.status}</span>
                      </div>
                      <div style={{ color: "#9ca3af", fontSize: 11, marginTop: 2 }}>{hit.sourceUri} · domínio {hit.domainId} · {hit.trustLevel}</div>
                      <p style={{ color: "#cbd5e1", margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{(hit.summary ?? hit.content).slice(0, 260)}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {workspace === "integrations" && (
          <div>
            <section style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <div>
                  <h2 style={{ margin: "0 0 5px", fontSize: 16 }}>Estado das integrações</h2>
                  <p style={{ color: "#9ca3af", fontSize: 12, margin: 0 }}>Configuração é lida do servidor; segredos nunca são enviados ao navegador.</p>
                </div>
                <button style={btnStyle} onClick={() => void loadIntegrationStatus()}>Atualizar</button>
              </div>
              {!integrationStatus ? <p style={{ color: "#9ca3af", fontSize: 13 }}>Carregando configuração e sincronizações deste projeto…</p> : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10, marginTop: 14 }}>
                  <section style={{ ...cardStyle, margin: 0 }}>
                    <strong>GitHub</strong>
                    <div style={{ color: integrationStatus.github.state === "available" ? "#34d399" : "#fbbf24", fontSize: 12, marginTop: 6 }}>{integrationStatus.github.state === "available" ? "Fila disponível" : "Configure PostgreSQL/pg-boss"}</div>
                    <div style={{ color: "#9ca3af", fontSize: 11, marginTop: 5 }}>Acesso a repos privados: {integrationStatus.github.privateRepoAuthConfigured ? "configurado" : "não configurado (repos públicos disponíveis)"}</div>
                    <div style={{ color: "#9ca3af", fontSize: 11, marginTop: 3 }}>Webhook push: {integrationStatus.github.webhookConfigured ? "configurado" : "não configurado"}</div>
                    <div style={{ color: "#cbd5e1", fontSize: 11, marginTop: 8 }}>Repos mapeados para este projeto: {integrationStatus.github.repositories.length || "nenhum"}</div>
                    {integrationStatus.github.repositories.map((source) => <div key={source.repository} style={{ color: "#9ca3af", fontSize: 11 }}>{source.repository} · {source.accessPolicyId}</div>)}
                    <div style={{ color: "#cbd5e1", fontSize: 11, marginTop: 8 }}>HEAD de main:</div>
                    {(integrationStatus.github.mainHeads ?? []).map((head) => <div key={`${head.repository}:${head.branch}`} style={{ color: "#9ca3af", fontSize: 11 }}>{head.repository} · {head.commitSha.slice(0, 12)}</div>)}
                    {integrationStatus.github.repositories.length > 0 && (integrationStatus.github.mainHeads ?? []).length === 0 && <div style={{ color: "#fbbf24", fontSize: 11 }}>Aguardando o primeiro push assinado em main.</div>}
                  </section>
                  <section style={{ ...cardStyle, margin: 0 }}>
                    <strong>Nango · conectores SaaS</strong>
                    <div style={{ color: integrationStatus.saas.state === "available" ? "#34d399" : "#fbbf24", fontSize: 12, marginTop: 6 }}>{integrationStatus.saas.state === "available" ? "Configuração presente; conectividade é verificada no sync" : "NANGO_URL/SECRET ou pg-boss ausente"}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                      <select style={inputStyle} value={saasProvider} onChange={(event) => setSaasProvider(event.target.value)} aria-label="Provedor SaaS">
                        {(["jira", "linear", "notion", "confluence", "figma", "slack", "sentry", "datadog", "google-drive"] as const).map((provider) => <option key={provider} value={provider}>{provider}</option>)}
                      </select>
                      <input style={{ ...inputStyle, minWidth: 140, flex: 1 }} value={saasConnectionId} onChange={(event) => setSaasConnectionId(event.target.value)} placeholder="Nango connection ID" aria-label="Nango connection ID" />
                      <button style={btnStyle} disabled={integrationStatus.saas.state !== "available"} onClick={() => void startSaasSync()}>Sincronizar</button>
                    </div>
                  </section>
                  <section style={{ ...cardStyle, margin: 0 }}>
                    <strong>Aprovação interativa Slack</strong>
                    <div style={{ color: integrationStatus.slackInteractiveApprovalConfigured ? "#34d399" : "#fbbf24", fontSize: 12, marginTop: 6 }}>{integrationStatus.slackInteractiveApprovalConfigured ? "Assinatura e mapeamento presentes" : "Falta Signing Secret ou mapeamento de ator"}</div>
                    <div style={{ color: "#9ca3af", fontSize: 11, marginTop: 5 }}>Configure a Request URL do app para <code>/v1/integrations/slack/actions</code>.</div>
                  </section>
                </div>
              )}
            </section>
            {integrationStatus && <>
              <section style={cardStyle}>
                <h2 style={{ margin: "0 0 10px", fontSize: 16 }}>Canais de notificação</h2>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {integrationStatus.notificationChannels.map((channel) => <span key={channel.provider} style={{ border: "1px solid #334155", borderRadius: 16, padding: "5px 10px", fontSize: 12, color: channel.configured ? "#34d399" : "#9ca3af" }}>{channel.provider}: {channel.configured ? "configurado" : "não configurado"}</span>)}
                </div>
              </section>
              <section style={cardStyle}>
                <h2 style={{ margin: "0 0 10px", fontSize: 16 }}>Últimas sincronizações</h2>
                {[...integrationStatus.github.recentJobs.map((job) => ({ ...job, source: `${job.owner}/${job.repo}`, detail: job.ref, count: job.result?.ingested, kind: "GitHub" })), ...integrationStatus.saas.recentJobs.map((job) => ({ ...job, source: `${job.provider} · ${job.connectionId}`, detail: job.jobId, count: job.result?.synced, kind: "SaaS" }))]
                  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 12).map((job) => <div key={job.jobId} style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderTop: "1px solid #1f2937", padding: "9px 0", fontSize: 12 }}>
                    <span><strong>{job.kind}</strong> · {job.source} · {job.detail}</span>
                    <span style={{ color: job.state === "completed" && !(job.result?.errors) ? "#34d399" : job.state === "failed" ? "#f87171" : "#fbbf24" }}>{job.state}{job.count !== undefined ? ` · ${job.count} itens` : ""} · {new Date(job.createdAt).toLocaleString()}</span>
                  </div>)}
                {integrationStatus.github.recentJobs.length + integrationStatus.saas.recentJobs.length === 0 && <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 0 }}>Nenhuma sincronização remota registrada neste projeto.</p>}
              </section>
            </>}
            <section style={{ ...cardStyle, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13 }}>Gateway MCP · {gatewayInfo?.tools?.length ?? 14} ferramentas no catálogo · REST / MCP streamable / stdio</span>
              <button style={{ ...btnStyle, background: "#334155" }} onClick={async () => {
                try {
                  const info = await apiFetch("/gateway") as GatewayInfoView;
                  setGatewayInfo(info);
                  setStatusMsg("Gateway MCP consultado.");
                } catch (err) { setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`); }
              }}>Detalhes do Gateway</button>
              {gatewayInfo && (
                <div style={{ width: "100%", marginTop: 10, background: "#0b1220", border: "1px solid #1f2937", borderRadius: 8, padding: 12, fontSize: 12 }}>
                  <div><strong>{gatewayInfo.gateway}</strong> · endpoint: <code>{gatewayInfo.mcpEndpoint ?? "/mcp"}</code> · transportes: {(gatewayInfo.transports ?? []).join(", ")}</div>
                  {(gatewayInfo.tools?.length ?? 0) > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 6, marginTop: 10 }}>
                      {gatewayInfo.tools!.map((tool) => (
                        <div key={tool.name} style={{ border: "1px solid #1f2937", borderRadius: 6, padding: 6 }}>
                          <code>{tool.name}</code> {tool.mode ? <span style={{ color: "#93c5fd" }}>({tool.mode})</span> : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        )}

        {workspace === "impact" && (
          <div>
            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Análise de Impacto &amp; Contratos Cross-Service</h2>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                <input style={{ ...inputStyle, width: 240 }} value={contractId} onChange={(e) => setContractId(e.target.value)} placeholder="Contrato (ex: POST /v1/invoices)" />
                <button
                  style={btnStyle}
                  onClick={async () => {
                    try {
                      const data = await apiFetch("/v1/cross-service/blast-radius", {
                        method: "POST",
                        body: JSON.stringify({ contractId })
                      }) as BlastRadiusView;
                      setBlastResult(data);
                      setStatusMsg(`Blast radius calculado para ${contractId}.`);
                    } catch (err) {
                      setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }}
                >
                  Cross-Service Blast Radius
                </button>
                <button
                  style={{ ...btnStyle, background: "#059669" }}
                  onClick={async () => {
                    try {
                      await apiFetch("/v1/cross-service/contracts", {
                        method: "POST",
                        body: JSON.stringify({
                          fromProjectId: projectId,
                          fromService: `${projectId}-service`,
                          relation: "CONSUMES_API",
                          toProjectId: projectId,
                          contractId
                        })
                      });
                      await loadCrossServiceContracts();
                      setStatusMsg(`Contrato '${contractId}' registrado.`);
                    } catch (err) {
                      setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }}
                >
                  Registrar Contrato
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input style={{ ...inputStyle, flex: 1, minWidth: 260 }} value={impactTargets} onChange={(e) => setImpactTargets(e.target.value)} placeholder="IDs separados por vírgula" />
                <button
                  style={{ ...btnStyle, background: "#334155" }}
                  onClick={async () => {
                    try {
                      const targetIds = impactTargets.split(",").map((s) => s.trim()).filter(Boolean);
                      const data = await apiFetch(`/v1/projects/${projectId}/change/impact`, {
                        method: "POST",
                        body: JSON.stringify({ targetIds })
                      }) as ChangeImpactView;
                      setImpactResult(data);
                      setStatusMsg(`Impacto calculado: risco ${data.riskLevel}.`);
                    } catch (err) {
                      setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
                    }
                  }}
                >
                  Impacto no Grafo
                </button>
              </div>
            </section>

            {crossServiceContracts.length > 0 && (
              <section style={cardStyle}>
                <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Contratos Registrados ({crossServiceContracts.length})</h3>
                <div style={{ display: "grid", gap: 6 }}>
                  {crossServiceContracts.map((c, idx) => (
                    <div key={`${c.contractId}-${idx}`} style={{ borderBottom: "1px solid #1f2937", padding: "6px 0", fontSize: 12, display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span><strong>{c.fromService}</strong> ({c.fromProjectId}) <span style={{ color: "#93c5fd" }}>{c.relation}</span> <code>{c.contractId}</code></span>
                      <span style={{ color: "#9ca3af" }}>destino: {c.toProjectId} · v{c.schemaVersion}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {blastResult && (
              <section style={cardStyle}>
                <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Blast Radius · <code>{blastResult.contractId}</code></h3>
                <div style={{ fontSize: 12, color: "#cbd5e1", marginBottom: 8 }}>
                  Projetos impactados: {(blastResult.impactedProjects?.length ?? 0) > 0 ? blastResult.impactedProjects!.join(", ") : "nenhum"}
                </div>
                {(blastResult.impactedServices?.length ?? 0) > 0 && (
                  <div style={{ display: "grid", gap: 6 }}>
                    {blastResult.impactedServices!.map((svc, idx) => (
                      <div key={`svc-${idx}`} style={{ border: "1px solid #1f2937", borderRadius: 6, padding: 8, fontSize: 12 }}>
                        <strong>{svc.service}</strong> ({svc.projectId}) · {svc.relation}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {impactResult && (
              <section style={cardStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>Impacto no Grafo</h3>
                  <span style={{ fontSize: 12, fontWeight: 700, color: impactResult.riskLevel === "critical" || impactResult.riskLevel === "high" ? "#f87171" : "#34d399" }}>
                    Risco: {impactResult.riskLevel.toUpperCase()}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, fontSize: 12, marginBottom: 10 }}>
                  <div>Confirmados: <strong>{impactResult.confirmedImpacts?.length ?? 0}</strong></div>
                  <div>Hipóteses: <strong>{impactResult.hypotheses?.length ?? 0}</strong></div>
                  <div>Diretos: <strong>{impactResult.directImpacts?.length ?? 0}</strong></div>
                  <div>Transitivos: <strong>{impactResult.transitiveImpacts?.length ?? 0}</strong></div>
                  <div>Regras críticas: <strong>{impactResult.criticalRulesImpacted?.length ?? 0}</strong></div>
                </div>
                {(impactResult.criticalRulesImpacted?.length ?? 0) > 0 && (
                  <div style={{ color: "#fbbf24", fontSize: 12 }}>
                    Regras críticas afetadas: {impactResult.criticalRulesImpacted!.map((r) => r.title ?? r.id).join(", ")}
                  </div>
                )}
              </section>
            )}
          </div>
        )}

        {workspace === "operations" && (
          <div>
            <section style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div>
                <h2 style={{ margin: "0 0 5px", fontSize: 16 }}>Operação do projeto</h2>
                <p style={{ margin: 0, color: "#9ca3af", fontSize: 12 }}>Filas nas últimas 24 horas · atualização automática a cada 15 s</p>
              </div>
              <button style={btnStyle} onClick={() => void loadOperationsOverview()}>Atualizar agora</button>
            </section>
            {!operationsOverview ? <section style={cardStyle}><p style={{ margin: 0, color: "#9ca3af", fontSize: 13 }}>Carregando saúde, filas e cobertura…</p></section> : <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 16 }}>
                {[
                  { label: "Saúde do conhecimento", value: `${operationsOverview.health.score}%`, detail: `${operationsOverview.health.activeItems} itens ativos`, color: operationsOverview.health.score >= 80 ? "#34d399" : "#fbbf24" },
                  { label: "API", value: operationsOverview.service.api === "ok" ? "Operacional" : "Indisponível", detail: "serviço atual", color: operationsOverview.service.api === "ok" ? "#34d399" : "#f87171" },
                  { label: "PostgreSQL operacional", value: operationsOverview.service.postgresOperational ? "Conectado" : "Não configurado", detail: "persistência de operações", color: operationsOverview.service.postgresOperational ? "#34d399" : "#fbbf24" },
                  { label: "Cobertura QA", value: `${operationsOverview.quality.qaCoveragePercent}%`, detail: `${operationsOverview.quality.rules.length} regras avaliadas`, color: operationsOverview.quality.qaCoveragePercent >= 80 ? "#34d399" : "#fbbf24" },
                  { label: "Latência API (p95)", value: operationsOverview.telemetry?.apiLatencyMs.p95Ms !== null && operationsOverview.telemetry?.apiLatencyMs.p95Ms !== undefined ? `${operationsOverview.telemetry.apiLatencyMs.p95Ms} ms` : "n/d", detail: operationsOverview.telemetry?.apiLatencyMs.sampleCount ? `p50 ${operationsOverview.telemetry.apiLatencyMs.p50Ms} ms · ${operationsOverview.telemetry.apiLatencyMs.sampleCount} reqs` : "sem amostras", color: "#93c5fd" }
                ].map((metric) => <section key={metric.label} style={{ ...cardStyle, margin: 0 }}>
                  <div style={{ color: "#9ca3af", fontSize: 11 }}>{metric.label}</div>
                  <div style={{ color: metric.color, fontSize: 21, fontWeight: 700, margin: "6px 0" }}>{metric.value}</div>
                  <div style={{ color: "#9ca3af", fontSize: 11 }}>{metric.detail}</div>
                </section>)}
              </div>
              <section style={cardStyle}>
                <h2 style={{ margin: "0 0 10px", fontSize: 16 }}>Filas de processamento</h2>
                {operationsOverview.queues.counts.length === 0 ? <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>{operationsOverview.service.pgBoss === "available" ? "Nenhum job deste projeto nas últimas 24 horas." : "pg-boss não está configurado neste ambiente."}</p> : <div style={{ display: "grid", gap: 6 }}>
                  {operationsOverview.queues.counts.map((queue) => <div key={`${queue.queue}-${queue.state}`} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #1f2937", padding: "7px 0", fontSize: 12 }}>
                    <span>{queue.queue}</span><span style={{ color: queue.state === "failed" || queue.state === "expired" ? "#f87171" : queue.state === "active" ? "#60a5fa" : "#cbd5e1" }}>{queue.state} · {queue.count}</span>
                  </div>)}
                </div>}
              </section>
              <section style={cardStyle}>
                <h2 style={{ margin: "0 0 10px", fontSize: 16 }}>Falhas recentes</h2>
                {operationsOverview.queues.recentFailures.length === 0 ? <p style={{ color: "#34d399", fontSize: 13, margin: 0 }}>Nenhuma falha ou expiração de job nas últimas 24 horas.</p> : operationsOverview.queues.recentFailures.map((failure, index) => <div key={`${failure.jobId}-${index}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", color: "#fca5a5", fontSize: 12, borderBottom: "1px solid #1f2937", padding: "7px 0" }}>
                  <div>
                    <strong>{failure.queue}</strong> · <code>{failure.jobId.slice(0, 8)}</code> · {new Date(failure.failedAt).toLocaleString()} · {failure.retries} tentativas
                    {failure.errorSummary && <div style={{ color: "#9ca3af", fontSize: 11 }}>{failure.errorSummary}</div>}
                  </div>
                  <button
                    style={{ ...btnStyle, background: "#b45309", padding: "4px 10px", fontSize: 11 }}
                    onClick={async () => {
                      try {
                        await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/operations/jobs/${encodeURIComponent(failure.jobId)}/retry`, { method: "POST" });
                        setStatusMsg(`Job ${failure.jobId.slice(0, 8)} (${failure.queue}) reenfileirado.`);
                        await loadOperationsOverview();
                      } catch (err) {
                        setStatusMsg(`Erro ao reenfileirar job: ${err instanceof Error ? err.message : String(err)}`);
                      }
                    }}
                  >
                    Reenfileirar job
                  </button>
                </div>)}
              </section>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
                <section style={cardStyle}>
                  <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Regras e documentos</h2>
                  <div style={{ color: "#cbd5e1", fontSize: 12 }}>Sem testes: {operationsOverview.health.untestedRules.length} · Desatualizados: {operationsOverview.health.staleItems.length} · Conflitos Git/connector: {operationsOverview.health.gitConnectorConflicts.length}</div>
                  {operationsOverview.health.untestedRules.length > 0 && <p style={{ color: "#fbbf24", fontSize: 11 }}>Regras sem testes: {operationsOverview.health.untestedRules.slice(0, 8).join(", ")}</p>}
                </section>
                <section style={cardStyle}>
                  <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>FinOps</h2>
                  <div style={{ color: "#cbd5e1", fontSize: 12 }}>Tokens estimados no conteúdo indexado: {operationsOverview.finops.estimatedIndexedTokens.toLocaleString()}</div>
                  <div style={{ color: "#cbd5e1", fontSize: 12, marginTop: 6 }}>Execuções de modelo medidas (30 dias): {operationsOverview.finops.modelUsage.calls}</div>
                  {operationsOverview.finops.modelUsage.byModel.map((usage) => <div key={`${usage.provider}-${usage.model}`} style={{ color: "#cbd5e1", fontSize: 11, marginTop: 5 }}>{usage.provider}/{usage.model} · entrada {usage.inputTokens?.toLocaleString() ?? "n/d"} · saída {usage.outputTokens?.toLocaleString() ?? "n/d"} · cobrança API {usage.providerCostUsd === null ? "n/d" : `$${usage.providerCostUsd.toFixed(4)}`}</div>)}
                  <div style={{ color: "#cbd5e1", fontSize: 12, marginTop: 6 }}>Custo de provedor reportado: {operationsOverview.finops.actualCostUsd === null ? "indisponível" : `$${operationsOverview.finops.actualCostUsd.toFixed(4)}`}</div>
                  <p style={{ color: "#fbbf24", fontSize: 11, marginBottom: 0 }}>{operationsOverview.finops.note}</p>
                </section>
              </div>
              <p style={{ color: "#64748b", fontSize: 10, textAlign: "right" }}>Atualizado {new Date(operationsOverview.generatedAt).toLocaleString()}</p>
            </>}
          </div>
        )}

        {workspace === "access" && (
          <>
          <section style={cardStyle}>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <h2 style={{ margin: "0 0 5px", fontSize: 16 }}>Auditoria de acesso · {projectId}</h2>
                <p style={{ margin: 0, color: "#9ca3af", fontSize: 12 }}>Eventos recentes filtrados pelo projeto atual. Exige papel admin, AppSec ou Tech Lead.</p>
              </div>
              <button style={{ ...btnStyle, background: "#475569" }} onClick={async () => {
                try {
                  const profile = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/access/profile`) as AccessProfileView;
                  setAccessProfile(profile);
                  setStatusMsg(`Escopos efetivos carregados para ${profile.actorId}.`);
                } catch (err) { setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`); }
              }}>Meu acesso</button>
              <button
                style={btnStyle}
                onClick={async () => {
                  try {
                    const data = await apiFetch(`/v1/audit-logs?projectId=${encodeURIComponent(projectId)}&limit=100`) as { logs: AuditLogView[] };
                    setAuditLogs(data.logs);
                    setStatusMsg(`${data.logs.length} eventos de auditoria carregados para ${projectId}.`);
                  } catch (err) {
                    setStatusMsg(`Erro: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }}
              >
                Carregar trilha
              </button>
            </div>
            {accessProfile && <section style={{ background: "#0b1220", border: "1px solid #334155", borderRadius: 8, padding: 12, marginBottom: 14 }}>
              <strong style={{ fontSize: 13 }}>Acesso efetivo · {accessProfile.actorId}</strong>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginTop: 10, fontSize: 12 }}>
                <div><span style={{ color: "#94a3b8" }}>Tenant</span><br />{accessProfile.tenantId}</div>
                <div><span style={{ color: "#94a3b8" }}>Origem</span><br />{accessProfile.identitySource} {accessProfile.opaConfigured ? "(OPA ativo)" : "(OPA local)"}</div>
                <div><span style={{ color: "#94a3b8" }}>Papéis</span><br />{accessProfile.roles.join(", ")}</div>
                <div><span style={{ color: "#94a3b8" }}>Políticas</span><br />{accessProfile.allowedPolicies.join(", ")}</div>
                <div><span style={{ color: "#94a3b8" }}>Projetos autorizados</span><br />{accessProfile.allowedProjects.join(", ") || "nenhum"}</div>
              </div>
              {accessProfile.policyCatalog && accessProfile.policyCatalog.length > 0 && (
                <div style={{ marginTop: 12, borderTop: "1px solid #1f2937", paddingTop: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Catálogo de Políticas no Projeto</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, textAlign: "left" }}>
                    <thead><tr style={{ color: "#94a3b8", borderBottom: "1px solid #334155" }}><th style={{ padding: 5 }}>Política</th><th style={{ padding: 5 }}>Descrição</th><th style={{ padding: 5 }}>Acesso</th><th style={{ padding: 5 }}>Itens</th></tr></thead>
                    <tbody>
                      {accessProfile.policyCatalog.map((pol) => (
                        <tr key={pol.policyId} style={{ borderBottom: "1px solid #1f2937" }}>
                          <td style={{ padding: 5 }}><code>{pol.policyId}</code></td>
                          <td style={{ padding: 5, color: "#cbd5e1" }}>{pol.description}</td>
                          <td style={{ padding: 5, color: pol.authorized ? "#34d399" : "#f87171" }}>{pol.authorized ? "Autorizado" : "Bloqueado"}</td>
                          <td style={{ padding: 5 }}>{pol.itemCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!accessProfile.managementAvailable && <p style={{ color: "#fbbf24", fontSize: 11, margin: "10px 0 0" }}>{accessProfile.managementNote}</p>}
            </section>}
            {auditLogs === null ? <p style={{ margin: 0, color: "#9ca3af", fontSize: 13 }}>Carregue a trilha para consultar eventos deste projeto.</p> : auditLogs.length === 0 ? <p style={{ margin: 0, color: "#9ca3af", fontSize: 13 }}>Nenhum evento disponível neste escopo.</p> : <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, textAlign: "left" }}>
                <thead><tr style={{ color: "#94a3b8", borderBottom: "1px solid #334155" }}>{["Horário", "Ator", "Ação", "Alvo", "Política"].map((label) => <th key={label} style={{ padding: "8px 6px" }}>{label}</th>)}</tr></thead>
                <tbody>{auditLogs.map((entry) => <tr key={entry.id} style={{ borderBottom: "1px solid #1f2937" }}>
                  <td style={{ padding: "8px 6px", whiteSpace: "nowrap" }}>{new Date(entry.createdAt).toLocaleString()}</td>
                  <td style={{ padding: "8px 6px" }}>{entry.actorId}<br /><small style={{ color: "#64748b" }}>{entry.actorType}</small></td>
                  <td style={{ padding: "8px 6px" }}>{entry.action}</td>
                  <td style={{ padding: "8px 6px" }}>{entry.targetType}{entry.targetId ? ` · ${entry.targetId}` : ""}</td>
                  <td style={{ padding: "8px 6px" }}>{entry.accessPolicyId}</td>
                </tr>)}</tbody>
              </table>
            </div>}
          </section>

          <section style={cardStyle}>
            <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>Perfil Pessoal Cross-Project do Desenvolvedor</h2>
            <p style={{ margin: "0 0 12px", color: "#9ca3af", fontSize: 12 }}>
              Preferências pessoais que acompanham o ator autenticado entre repositórios (aplicadas abaixo das regras oficiais do projeto).
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10, marginBottom: 12 }}>
              <label style={{ display: "grid", gap: 4, fontSize: 12 }}>Gerenciador de pacotes<input style={inputStyle} value={devPkgManager} onChange={(e) => setDevPkgManager(e.target.value)} placeholder="npm, pnpm, uv, cargo" /></label>
              <label style={{ display: "grid", gap: 4, fontSize: 12 }}>Layout de testes<input style={inputStyle} value={devTestLayout} onChange={(e) => setDevTestLayout(e.target.value)} placeholder="co-located, tests-dir" /></label>
              <label style={{ display: "grid", gap: 4, fontSize: 12 }}>Estilo de arquitetura<input style={inputStyle} value={devArchStyle} onChange={(e) => setDevArchStyle(e.target.value)} placeholder="layered, hexagonal" /></label>
              <label style={{ display: "grid", gap: 4, fontSize: 12 }}>IDE / Harness preferido<input style={inputStyle} value={devHarness} onChange={(e) => setDevHarness(e.target.value)} placeholder="antigravity, codex, cursor" /></label>
            </div>
            <label style={{ display: "grid", gap: 4, fontSize: 12, marginBottom: 10 }}>
              Convenções pessoais (separadas por vírgula)
              <input style={inputStyle} value={devConventions} onChange={(e) => setDevConventions(e.target.value)} placeholder="ex.: early-return, strict-typescript, no-default-export" />
            </label>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12 }}>
                <input type="checkbox" checked={devOptInCrossProject} onChange={(e) => setDevOptInCrossProject(e.target.checked)} /> Incluir automaticamente no Context Pack entre projetos
              </label>
              <button
                style={btnStyle}
                onClick={async () => {
                  try {
                    await apiFetch("/v1/profile/developer", {
                      method: "PUT",
                      body: JSON.stringify({
                        preferredPackageManager: devPkgManager,
                        preferredTestLayout: devTestLayout,
                        preferredArchitectureStyle: devArchStyle,
                        preferredHarness: devHarness,
                        codingConventions: devConventions.split(",").map((s) => s.trim()).filter(Boolean),
                        optInCrossProject: devOptInCrossProject
                      })
                    });
                    setStatusMsg("Perfil pessoal cross-project salvo com sucesso.");
                  } catch (err) {
                    setStatusMsg(`Erro ao salvar perfil: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }}
              >
                Salvar Perfil Pessoal
              </button>
            </div>
          </section>
          </>
        )}

        {workspace === "templates" && (
          <div>
            <section style={cardStyle}>
              <h2 style={{ fontSize: 16, marginTop: 0 }}>Blueprint de projeto</h2>
              <p style={{ fontSize: 13, color: "#d1d5db" }}>Responda ao questionário para preparar um comando de scaffolding com estrutura .brain/, ADR e notas de segurança. O projeto começa como rascunho e exige revisão humana.</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
                <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Nome do serviço<input style={inputStyle} value={scaffoldName} onChange={(e) => setScaffoldName(e.target.value)} /></label>
                <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Domínio<input style={inputStyle} value={scaffoldDomain} onChange={(e) => setScaffoldDomain(e.target.value)} placeholder="billing, identity…" /></label>
                <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Objetivo<input style={inputStyle} value={scaffoldObjective} onChange={(e) => setScaffoldObjective(e.target.value)} placeholder="O que este serviço faz?" /></label>
                <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Criticidade<select style={inputStyle} value={scaffoldCriticality} onChange={(e) => setScaffoldCriticality(e.target.value)}><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="critical">Crítica</option></select></label>
                <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Stack<select style={inputStyle} value={scaffoldStack} onChange={(e) => setScaffoldStack(e.target.value)}><option value="node-ts">Node.js + TypeScript</option><option value="python">Python</option></select></label>
                <label style={{ display: "grid", gap: 5, fontSize: 12 }}>Comunicação<select style={inputStyle} value={scaffoldCommunication} onChange={(e) => setScaffoldCommunication(e.target.value)}><option value="sync">Síncrona</option><option value="events">Orientada a eventos</option></select></label>
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "14px 0", fontSize: 12 }}>
                <label><input type="checkbox" checked={scaffoldHandlesPii} onChange={(e) => setScaffoldHandlesPii(e.target.checked)} /> Trata dados pessoais (PII)</label>
                <label><input type="checkbox" checked={scaffoldHandlesPayments} onChange={(e) => setScaffoldHandlesPayments(e.target.checked)} /> Trata pagamentos</label>
                <label><input type="checkbox" checked={scaffoldCrossProject} onChange={(e) => setScaffoldCrossProject(e.target.checked)} /> Incluir ADRs cross-project autorizadas</label>
              </div>
              <p style={{ color: "#fbbf24", fontSize: 12 }}>Política inicial sugerida: {scaffoldHandlesPii || scaffoldHandlesPayments || scaffoldCriticality === "critical" ? "restricted-security" : "internal-project"}. Guardian inicia em modo advisory até revisão da equipe.</p>
              <button style={{ ...btnStyle, background: "#475569", marginRight: 8 }} onClick={async () => {
                try {
                  const query = new URLSearchParams({ domain: scaffoldDomain, stack: scaffoldStack, crossProject: scaffoldCrossProject ? "true" : "false" });
                  const data = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/scaffold/recommendations?${query.toString()}`) as { recommendations: ScaffoldRecommendation[]; note: string };
                  setScaffoldRecommendations(data.recommendations);
                  setScaffoldRecommendationNote(data.note);
                  setStatusMsg(`Encontradas ${data.recommendations.length} recomendações aprovadas.`);
                } catch (err) { setStatusMsg(`Erro ao consultar ADRs: ${err instanceof Error ? err.message : String(err)}`); }
              }}>Consultar ADRs aprovadas</button>
              <button style={{ ...btnStyle, marginRight: 8 }} onClick={() => {
                const slug = scaffoldName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
                if (!slug) { setStatusMsg("Informe um nome de serviço com letras ou números."); return; }
                const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
                const options = ["--domain", scaffoldDomain, "--criticality", scaffoldCriticality, "--stack", scaffoldStack, "--communication", scaffoldCommunication];
                if (scaffoldObjective.trim()) options.push("--objective", scaffoldObjective.trim());
                if (selectedAdrIds.length > 0) options.push("--adr", selectedAdrIds.join(","));
                if (scaffoldHandlesPii) options.push("--pii");
                if (scaffoldHandlesPayments) options.push("--payments");
                setScaffoldCommand(["noema scaffold", slug, ...options.map(quote)].join(" "));
                setStatusMsg("Blueprint pronto. Execute o comando no diretório pai do novo projeto.");
              }}>
                Preparar scaffolding
              </button>
              <button style={{ ...btnStyle, background: "#059669" }} onClick={async () => {
                const slug = scaffoldName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
                if (!slug) { setStatusMsg("Informe um nome de serviço com letras ou números."); return; }
                try {
                  const reg = await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/scaffold/register`, {
                    method: "POST",
                    body: JSON.stringify({
                      serviceName: slug,
                      domain: scaffoldDomain,
                      objective: scaffoldObjective.trim() || undefined,
                      criticality: scaffoldCriticality,
                      stack: scaffoldStack,
                      communication: scaffoldCommunication,
                      handlesPii: scaffoldHandlesPii,
                      handlesPayments: scaffoldHandlesPayments,
                      appliedAdrIds: selectedAdrIds
                    })
                  }) as { itemId: string; accessPolicyId: string };
                  setStatusMsg(`Serviço '${slug}' registrado no Command Center (${reg.itemId}, política ${reg.accessPolicyId}).`);
                } catch (err) {
                  setStatusMsg(`Erro ao registrar serviço: ${err instanceof Error ? err.message : String(err)}`);
                }
              }}>
                Registrar no Command Center
              </button>
              {scaffoldRecommendations !== null && <section style={{ ...cardStyle, marginTop: 14 }}>
                <h3 style={{ fontSize: 14, marginTop: 0 }}>Padrões encontrados</h3>
                <p style={{ color: "#9ca3af", fontSize: 12 }}>{scaffoldRecommendationNote}</p>
                {scaffoldRecommendations.map((recommendation) => {
                  const checked = selectedAdrIds.includes(recommendation.id);
                  return <article key={`${recommendation.sourceProjectId ?? projectId}-${recommendation.id}`} style={{ borderTop: "1px solid #334155", padding: "10px 0", fontSize: 12 }}>
                    <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setSelectedAdrIds((prev) => e.target.checked ? [...prev, recommendation.id] : prev.filter((id) => id !== recommendation.id));
                        }}
                      />
                      <strong>{recommendation.title}</strong>
                      <span style={{ color: "#34d399" }}>approved</span>
                      {recommendation.sourceProjectId && <span style={{ color: "#93c5fd" }}>({recommendation.sourceProjectId})</span>}
                    </label>
                    <p style={{ color: "#cbd5e1", whiteSpace: "pre-wrap", margin: "6px 0 4px" }}>{recommendation.summary}</p>
                    <small style={{ color: "#94a3b8" }}>{recommendation.sourceUri} · {recommendation.sourceVersion} · {recommendation.matchReasons.join(", ")}</small>
                  </article>;
                })}
              </section>}
              {scaffoldCommand && <div style={{ marginTop: 14 }}><pre style={{ ...cardStyle, background: "#030712", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12 }}>{scaffoldCommand}</pre><button style={{ ...btnStyle, background: "#334155" }} onClick={async () => { try { await navigator.clipboard.writeText(scaffoldCommand); setStatusMsg("Comando copiado."); } catch { setStatusMsg("Não foi possível copiar automaticamente; selecione o comando acima."); } }}>Copiar comando</button></div>}
            </section>
            <section style={cardStyle}>
              <h3 style={{ fontSize: 14, marginTop: 0 }}>Validar após gerar</h3>
              <pre style={{ background: "#030712", padding: 14, borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap" }}>{`noema doctor --path <repo>\nnoema validate --path <repo>`}</pre>
            </section>
          </div>
        )}

        {workspace === "enterprise" && (
          <div>
            <section style={{ ...cardStyle, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div>
                <h2 style={{ margin: "0 0 5px", fontSize: 16 }}>Visões Corporativas (CTO · QA · DevOps · AppSec)</h2>
                <p style={{ margin: 0, color: "#9ca3af", fontSize: 12 }}>Tech Radar, Matriz de Cobertura QA (Business-Rule-to-Test) e Resultados de Execução no HEAD.</p>
              </div>
              <button style={btnStyle} onClick={() => void loadEnterpriseViews()}>Atualizar Visões</button>
            </section>
            {!enterpriseViews ? (
              <section style={cardStyle}><p style={{ margin: 0, color: "#9ca3af", fontSize: 13 }}>Carregando visões corporativas…</p></section>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
                  <section style={{ ...cardStyle, margin: 0 }}>
                    <div style={{ color: "#9ca3af", fontSize: 11 }}>Cobertura QA (Regras → Testes)</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: (enterpriseViews.qaCoverage?.coveragePercent ?? 0) >= 80 ? "#34d399" : "#fbbf24", margin: "6px 0" }}>
                      {enterpriseViews.qaCoverage?.coveragePercent ?? 0}%
                    </div>
                    <div style={{ color: "#9ca3af", fontSize: 11 }}>{enterpriseViews.qaCoverage?.rows?.length ?? 0} regra(s) avaliada(s)</div>
                  </section>
                  <section style={{ ...cardStyle, margin: 0 }}>
                    <div style={{ color: "#9ca3af", fontSize: 11 }}>Tech Radar (Adotadas / Desvios)</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: "#93c5fd", margin: "6px 0" }}>
                      {enterpriseViews.techRadar?.adopted?.length ?? 0} / {enterpriseViews.techRadar?.unapprovedDeviations?.length ?? 0}
                    </div>
                    <div style={{ color: "#9ca3af", fontSize: 11 }}>tecnologias catalogadas / desvios sem ADR</div>
                  </section>
                  <section style={{ ...cardStyle, margin: 0 }}>
                    <div style={{ color: "#9ca3af", fontSize: 11 }}>Execuções de Teste (CI)</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: "#34d399", margin: "6px 0" }}>
                      {enterpriseViews.testExecutionResults?.length ?? 0}
                    </div>
                    <div style={{ color: "#9ca3af", fontSize: 11 }}>resultados persistidos no projeto</div>
                  </section>
                </div>

                <section style={cardStyle}>
                  <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>Matriz QA: Regras de Negócio × Testes (VERIFIED_BY)</h3>
                  {(enterpriseViews.qaCoverage?.rows?.length ?? 0) === 0 ? (
                    <p style={{ color: "#9ca3af", fontSize: 13, margin: 0 }}>Nenhuma regra de negócio avaliada neste projeto.</p>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: "left", borderBottom: "1px solid #1f2937", color: "#9ca3af" }}>
                          <th style={{ padding: 6 }}>Regra</th>
                          <th style={{ padding: 6 }}>Coberta</th>
                          <th style={{ padding: 6 }}>Testes Vinculados</th>
                        </tr>
                      </thead>
                      <tbody>
                        {enterpriseViews.qaCoverage!.rows.map((row) => (
                          <tr key={row.ruleId} style={{ borderBottom: "1px solid #1f2937" }}>
                            <td style={{ padding: 6 }}><strong>{row.title}</strong><br /><small style={{ color: "#9ca3af" }}>{row.ruleId}</small></td>
                            <td style={{ padding: 6, color: row.covered ? "#34d399" : "#f87171", fontWeight: 600 }}>{row.covered ? "Sim" : "Não"}</td>
                            <td style={{ padding: 6, color: "#cbd5e1" }}>{row.tests.length > 0 ? row.tests.join(", ") : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>

                {(enterpriseViews.techRadar?.adopted?.length ?? 0) > 0 && (
                  <section style={cardStyle}>
                    <h3 style={{ margin: "0 0 10px", fontSize: 15 }}>CTO Tech Radar</h3>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {enterpriseViews.techRadar!.adopted!.map((tech) => (
                        <span key={tech} style={{ border: "1px solid #334155", borderRadius: 14, padding: "4px 10px", fontSize: 12, color: "#34d399" }}>{tech}</span>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        )}
        </>}
      </main>
    </div>
  );
}
