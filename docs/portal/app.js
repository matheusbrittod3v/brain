const ARCH_DETAILS = {
  ides: {
    title: "1. IDEs, Agentes & Harnesses",
    text: "O Project Brain OS 2.0 não substitui nenhuma IDE. Ele atua como o cérebro compartilhado que Antigravity, Codex, Kiro, Cursor, Claude Code, VS Code e JetBrains consultam. O Agent Continuity Protocol permite planejar no Antigravity, implementar no Codex e validar no Kiro com sincronização real de branch/patch."
  },
  gateway: {
    title: "2. Universal Agent Gateway & Motores",
    text: "Expõe 13 ferramentas MCP canônicas (snake_case), CLI (brain) e API REST (Fastify). Inclui Context Router, Hybrid Retrieval (RRF + FlashRank), Context Optimizer (Context Hit Rate), Architecture/Business Rule Guardians (Semgrep + dependency-cruiser) e o Brain Runner (subagente leve com fila e cron). O roadmap prevê Caixa de Entrada HumanOps e decisões por canais conectados; MCP pode propor e consultar, mas não aprovar conhecimento oficial."
  },
  storage: {
    title: "3. Persistência Open-Source (Zero-Cost First)",
    text: "PostgreSQL 16 centraliza FTS, pgvector, pg-boss, grafo, RLS e histórico append-only. ParadeDB BM25 é upgrade após evals; Valkey, Temporal, MinIO e Ollama são opcionais conforme o fluxo."
  },
  sources: {
    title: "4. Fontes, Conectores & Segurança",
    text: "Git é a fonte da verdade para conhecimento oficial conforme ownerRepo e precedência do manifesto. Referências usam sourceOrigin/sourceKind; Nango é opcional a partir de 2 conectores SaaS OAuth. Gitleaks é padrão; Presidio entra sob demanda. O Hub usa RLS; o perfil corporativo ativa Keycloak + OPA. Edge offline usa SQLite + SQLCipher e offline lease de até 7 dias."
  }
};

const DOMAINS = [
  ["01 · Identidade e Estratégia", "Visão, objetivos, KPIs, personas e proposta de valor.", "Revisão humana"],
  ["02 · Regras de Negócio", "Políticas comerciais, cálculos, limites e exceções.", "Aprovação Product/Business"],
  ["03 · Arquitetura de Software", "Serviços, contratos OpenAPI/AsyncAPI, integrações e ADRs.", "PR / Tech Lead"],
  ["04 · Padrões de Engenharia", "Convenções, SOLID, DDD, testes e Definition of Done.", "Versionado no Git"],
  ["05 · Código e Estrutura", "Repositórios, símbolos AST/SCIP, âncoras @brain-rule.", "Sync automático por commit"],
  ["06 · Tarefas e Planejamento", "Backlog, épicos, histórias, bugs e critérios de aceite.", "Webhooks Jira/Linear/GitHub"],
  ["07 · Decisões e Histórico", "Justificativas, alternativas rejeitadas e superseded.", "Imutável (apenas supersede)"],
  ["08 · Operações e Infra", "Ambientes, deploys, runbooks, incidentes e SLOs.", "Automática + revisão SRE"],
  ["09 · Clientes e Comercial", "Segmentos, jornadas, contratos, suporte e CRM.", "Sync com máscara de PII"],
  ["10 · Dados e Métricas", "Dicionário de dados, eventos, dbt e qualidade.", "Pipeline + curadoria"],
  ["11 · Segurança e Compliance", "Permissões, classificação, LGPD e ameaças.", "Aprovação AppSec/Legal"],
  ["12 · Memória dos Agentes", "Sessões, planos, handoffs e aprendizados validados.", "Episódica + promoção via PR"]
];

const MCP_TOOLS = [
  ["brain_bootstrap_project", "Leitura", "Identifica projeto/branch e retorna visão geral, stack e alertas."],
  ["brain_context_build", "Leitura", "Monta Context Pack otimizado em tokens (inclui contratos federados)."],
  ["brain_search", "Leitura", "Busca híbrida (PostgreSQL FTS + pgvector; ParadeDB BM25 opcional)."],
  ["brain_knowledge_get", "Leitura", "Obtém item específico + relações seguras no Knowledge Graph."],
  ["brain_get_active_rules", "Leitura", "Lista regras de negócio, padrões e ADRs vigentes do escopo."],
  ["brain_find_related_code", "Leitura", "Localiza símbolos AST/SCIP, âncoras @brain-rule e testes."],
  ["brain_analyze_change_impact", "Leitura", "Calcula impactos intra e cross-microsserviço antes da edição."],
  ["brain_validate_implementation", "Leitura", "Valida diff/PR contra regras, arquitetura e critérios de aceite."],
  ["brain_create_handoff", "Escrita", "Salva checkpoint (plano, branch, patch, testes, próximos passos)."],
  ["brain_resume_handoff", "Leitura", "Retoma tarefa em outra IDE/máquina checando divergência Git."],
  ["brain_record_learning", "Escrita", "Grava memória episódica e feedback de utilidade (Context Hit Rate)."],
  ["brain_change_propose", "Escrita", "Abre proposta/PR para criar ou atualizar regra, ADR ou doc."],
  ["brain_delegate_task", "Escrita", "Enfileira tarefa rotineira/agendada para o Brain Runner."]
];

const REPO_TREE = [
  ["apps/api", "API REST + /mcp (Streamable HTTP) + /gateway (Fastify)"],
  ["apps/mcp-server", "MCP stdio local; MCP remoto é servido por apps/api (/mcp)"],
  ["apps/cli", "CLI multiplataforma: brain init, sync, context, handoff, ui, runner, scaffold"],
  ["apps/web", "Project Command Center (Next.js) — também servido localmente via brain ui"],
  ["apps/worker", "Workers TypeScript + pg-boss sobre PostgreSQL"],
  ["apps/ai-worker", "Serviço Python opcional para Docling/Presidio quando necessários"],
  ["apps/agent-runner", "Módulo Brain Runner; no Edge é hospedado pela CLI"],
  ["packages/database & core", "Schema Drizzle + RLS em packages/database; contratos puros em core/protocols"],
  ["packages/auth & audit-engine", "Keycloak (OIDC), OPA (RBAC/ABAC), RLS e audit_logs append-only"],
  ["packages/retrieval & graph", "PostgreSQL FTS + busca vetorial autorizada + grafo com RLS"],
  ["packages/agent-handoff", "Protocolo de continuidade cross-IDE + branch efêmera / patch AES-256"],
  ["packages/architecture-guardian", "Validação via Semgrep OSS + dependency-cruiser (audit -> advisory -> enforced)"],
  ["packages/project-discovery", "Autodiscovery (brain init) + Project Blueprinting (brain scaffold)"],
  ["integrations/*", "GitHub/GitLab App próprio; mappers SaaS sobre Nango (Jira, Notion, Figma, Slack, CRM)"],
  ["tests/*", "Unitários, integração Docker (RLS), retrieval-evals (100+ queries) e segurança"]
];

const ROLES = [
  {
    id: "devs", label: "Desenvolvedores",
    items: [
      "Onboarding instantâneo em qualquer repositório com mapa de endpoints, tabelas e pegadinhas.",
      "Contract-Aware Coding: aviso em tempo real na IDE ao alterar payload consumido por outro microsserviço.",
      "Brain Runner em background resumindo commits e gerando rascunhos sem travar a IDE."
    ]
  },
  {
    id: "cto", label: "CTO / Diretoria",
    items: [
      "Visão executiva de risco, dívida técnica, regras críticas sem teste e custo/ganho de IA por time.",
      "Tech Radar Corporativo: detecta adoção de bibliotecas fora do padrão sem ADR justificando.",
      "Project Blueprinting (brain scaffold): novos serviços já nascem no padrão da organização."
    ]
  },
  {
    id: "devops", label: "DevOps / SRE",
    items: [
      "Topology & Blast Radius Map conectando repos a Terraform, Kubernetes, bancos e filas.",
      "Incident-to-Code Memory: incidentes (Sentry/Datadog) vinculados ao código e runbook usado.",
      "Pre-Deploy Readiness Check validando rollback e documentação antes do deploy."
    ]
  },
  {
    id: "qa", label: "QA",
    items: [
      "Business-Rule-to-Test Coverage Matrix cruzando cada regra aprovada com testes (VERIFIED_BY).",
      "Test Impact Selection indicando exatamente quais fluxos E2E entre microsserviços testar no PR.",
      "Geração assistida de cenários de teste a partir de critérios de aceite e exceções."
    ]
  },
  {
    id: "appsec", label: "AppSec / Segurança",
    items: [
      "Threat Model Vivo & Data Classification exigindo revisão de segurança em rotas com PII/pagamentos.",
      "Policy-as-Code (OPA + Semgrep) e scanner Gitleaks + Presidio antes de qualquer indexação.",
      "Supply Chain & CVE Guard cruzando SBOM entre todos os microsserviços da empresa."
    ]
  },
  {
    id: "micro", label: "Microsserviços & Scaffold",
    items: [
      "Cross-Service Contract Registry: grafo CONSUMES_API, PUBLISHES_EVENT e SUBSCRIBES_TO.",
      "Federated Context Pack: contexto do serviço atual + contratos públicos dos vizinhos autorizados.",
      "brain scaffold: questionário guiado -> recomendação histórica -> repo pronto com .brain/ e CI."
    ]
  }
];

const STAGES = [
  ["0", "Contratos, Banco & Infra", "JSON Schema, Drizzle, PostgreSQL FTS + pgvector + pg-boss; serviços de IA/storage opcionais."],
  ["1", "Segurança & Camada Git", "API Key local, RLS, trilha de auditoria, OpenTelemetry e parser Git; OIDC/OPA no perfil corporativo."],
  ["2", "Ingestão & Code Intelligence", "Gitleaks, partial clone, web-tree-sitter e âncoras @brain-rule; Presidio/Docling sob demanda, SCIP depois."],
  ["3", "Busca Híbrida, Grafo & Memória", "PostgreSQL FTS + busca vetorial exata autorizada, grafo seguro, RRF e memória em 5 camadas."],
  ["4", "Gateway, Edge Offline & Brain Runner", "13 tools MCP, CLI, Local Edge Brain (SQLite + sqlite-vec), brain runner up e Agent Handoff cross-IDE."],
  ["5", "Guardians, Command Center & Escala", "Semgrep/PR Checks, Dashboard (Dev/CTO/DevOps/QA/AppSec), Cross-Service Registry e brain scaffold."]
];

// Render domains
const domainsGrid = document.getElementById("domainsGrid");
function renderDomains(filter = "") {
  const q = filter.toLowerCase();
  domainsGrid.innerHTML = DOMAINS
    .filter(([t, d]) => t.toLowerCase().includes(q) || d.toLowerCase().includes(q))
    .map(([title, desc, rule]) => `
      <div class="card">
        <span class="badge">${rule}</span>
        <h3>${title}</h3>
        <p>${desc}</p>
      </div>
    `).join("");
}
renderDomains();
document.getElementById("domainSearch").addEventListener("input", (e) => renderDomains(e.target.value));

// Render MCP tools
document.getElementById("mcpGrid").innerHTML = MCP_TOOLS.map(([name, kind, desc]) => `
  <div class="mcp-item">
    <div class="mcp-head">
      <code>${name}</code>
      <span class="badge ${kind === "Escrita" ? "badge-write" : "badge-read"}" style="margin:0">${kind}</span>
    </div>
    <p>${desc}</p>
  </div>
`).join("");

// Render repo tree
const treeContainer = document.getElementById("treeContainer");
function renderTree(filter = "") {
  const q = filter.toLowerCase();
  treeContainer.innerHTML = REPO_TREE
    .filter(([p, d]) => p.toLowerCase().includes(q) || d.toLowerCase().includes(q))
    .map(([path, desc]) => `
      <div class="tree-item">
        <code>${path}</code>
        <span>${desc}</span>
      </div>
    `).join("");
}
renderTree();
document.getElementById("treeSearch").addEventListener("input", (e) => renderTree(e.target.value));

// Interactive architecture layers
const archDetail = document.getElementById("archDetail");
function showLayer(layerKey) {
  const info = ARCH_DETAILS[layerKey];
  archDetail.innerHTML = `<strong>${info.title}</strong><p style="margin-top:6px;color:var(--muted)">${info.text}</p>`;
}
showLayer("ides");
document.querySelectorAll(".arch-layer").forEach((el) => {
  el.addEventListener("click", () => {
    document.querySelectorAll(".arch-layer").forEach((x) => x.classList.remove("selected"));
    el.classList.add("selected");
    showLayer(el.dataset.layer);
  });
});

// Role tabs
const roleTabs = document.getElementById("roleTabs");
const rolePanel = document.getElementById("rolePanel");
function selectRole(id) {
  const role = ROLES.find((r) => r.id === id) || ROLES[0];
  roleTabs.innerHTML = ROLES.map((r) => `
    <button class="tab-btn ${r.id === role.id ? "active" : ""}" data-id="${r.id}">${r.label}</button>
  `).join("");
  rolePanel.innerHTML = `<strong>${role.label}</strong><ul style="margin-top:8px;padding-left:18px;color:var(--muted)">${
    role.items.map((i) => `<li style="margin-bottom:4px">${i}</li>`).join("")
  }</ul>`;
  roleTabs.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => selectRole(btn.dataset.id));
  });
}
selectRole("devs");

// Render construction stages
document.getElementById("stagesList").innerHTML = STAGES.map(([num, title, desc]) => `
  <div class="stage">
    <div class="stage-num">${num}</div>
    <div><h3>Estágio ${num} — ${title}</h3><p>${desc}</p></div>
  </div>
`).join("");

// Copy buttons
document.querySelectorAll(".copy-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const prev = btn.textContent;
      btn.textContent = "Copiado!";
      setTimeout(() => (btn.textContent = prev), 1500);
    } catch (_) {}
  });
});

// Theme toggle
document.getElementById("themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("light");
});

// Scroll progress, back-to-top & Scroll-Spy
const progressBar = document.getElementById("progressBar");
const backTop = document.getElementById("backTop");
const navLinks = Array.from(document.querySelectorAll(".nav-link"));

window.addEventListener("scroll", () => {
  const docHeight = document.documentElement.scrollHeight - window.innerHeight;
  const pct = docHeight > 0 ? (window.scrollY / docHeight) * 100 : 0;
  progressBar.style.width = `${pct}%`;
  backTop.classList.toggle("visible", window.scrollY > 360);
});
backTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      navLinks.forEach((l) => l.classList.toggle("active", l.getAttribute("href") === `#${entry.target.id}`));
    }
  });
}, { rootMargin: "-25% 0px -65% 0px" });

document.querySelectorAll("section[id]").forEach((sec) => observer.observe(sec));

// Command Palette (Cmd+K / Ctrl+K)
const cmdModal = document.getElementById("cmdModal");
const cmdInput = document.getElementById("cmdInput");
const cmdResults = document.getElementById("cmdResults");

const SEARCH_INDEX = [
  ...navLinks.map((l) => ({ title: l.textContent, sub: "Seção", href: l.getAttribute("href") })),
  ...MCP_TOOLS.map(([n, k, d]) => ({ title: n, sub: `MCP (${k}) · ${d}`, href: "#mcp-runner" })),
  ...DOMAINS.map(([t, d]) => ({ title: t, sub: d, href: "#dominios" })),
  ...REPO_TREE.map(([p, d]) => ({ title: p, sub: d, href: "#estrutura" }))
];

function renderCmd(q = "") {
  const term = q.toLowerCase();
  const hits = SEARCH_INDEX.filter((i) => i.title.toLowerCase().includes(term) || i.sub.toLowerCase().includes(term)).slice(0, 12);
  cmdResults.innerHTML = hits.map((h) => `
    <a class="modal-item" href="${h.href}">
      <span><strong>${h.title}</strong><br><small>${h.sub}</small></span>
      <span class="kbd">↵</span>
    </a>
  `).join("") || `<div style="padding:14px;color:var(--muted);font-size:0.86rem">Nenhum resultado encontrado.</div>`;
  cmdResults.querySelectorAll(".modal-item").forEach((item) => {
    item.addEventListener("click", () => cmdModal.classList.remove("open"));
  });
}

function openCmd() {
  cmdModal.classList.add("open");
  cmdInput.value = "";
  renderCmd();
  setTimeout(() => cmdInput.focus(), 20);
}

document.getElementById("cmdTrigger").addEventListener("click", openCmd);
cmdModal.addEventListener("click", (e) => { if (e.target === cmdModal) cmdModal.classList.remove("open"); });
cmdInput.addEventListener("input", (e) => renderCmd(e.target.value));
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openCmd();
  } else if (e.key === "Escape") {
    cmdModal.classList.remove("open");
  }
});
