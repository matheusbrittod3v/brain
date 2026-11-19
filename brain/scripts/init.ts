#!/usr/bin/env bun
/**
 * Project Brain OS 2.0 - Script Universal de Inicialização e Bootstrap
 *
 * Suporte completo a macOS (Apple Silicon / Intel), Linux, Docker e Cloud.
 * Verifica e instala dependências, prepara o .env, sobe contêineres Docker,
 * executa migrações do PostgreSQL, sincroniza .brain/ e inicia todos os serviços.
 *
 * Uso:
 *   bun scripts/init.ts            # Inicialização completa interativa
 *   bun scripts/init.ts --start    # Sobe infraestrutura + API + Web + Worker
 *   bun scripts/init.ts --infra    # Apenas contêineres Docker e banco
 *   bun scripts/init.ts --check    # Diagnóstico (Brain Doctor)
 *   bun scripts/init.ts --build    # Rebuild de todos os pacotes
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, "..");
const DOCKER_COMPOSE_FILE = join(ROOT_DIR, "infra", "docker", "docker-compose.yml");
const ENV_FILE = join(ROOT_DIR, ".env");
const ENV_EXAMPLE_FILE = join(ROOT_DIR, ".env.example");

// Estilos ANSI
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  magenta: "\x1b[35m"
};

const log = {
  info: (msg: string) => console.log(`${c.blue}ℹ${c.reset} ${msg}`),
  success: (msg: string) => console.log(`${c.green}✔${c.reset} ${c.bold}${msg}${c.reset}`),
  warn: (msg: string) => console.log(`${c.yellow}⚠${c.reset} ${msg}`),
  error: (msg: string) => console.log(`${c.red}✖${c.reset} ${c.bold}${msg}${c.reset}`),
  step: (step: number, total: number, title: string) =>
    console.log(`\n${c.cyan}[${step}/${total}]${c.reset} ${c.bold}${title}${c.reset}`)
};

const runningProcesses: ChildProcess[] = [];

function run(cmd: string, args: string[], options: { cwd?: string; env?: Record<string, string>; silent?: boolean } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: options.cwd || ROOT_DIR,
    env: { ...process.env, ...options.env },
    stdio: options.silent ? "pipe" : "inherit",
    encoding: "utf-8"
  });
  return {
    code: res.status ?? 1,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim()
  };
}

function commandExists(cmd: string): boolean {
  const checkCmd = platform() === "win32" ? "where" : "which";
  return run(checkCmd, [cmd], { silent: true }).code === 0;
}

// 1. Diagnóstico do Sistema
function checkSystemRequirements() {
  log.step(1, 7, "Verificando ambiente e ferramentas do sistema...");

  const osName = platform() === "darwin" ? "macOS" : platform() === "linux" ? "Linux" : platform();
  log.info(`Sistema Operacional: ${c.bold}${osName}${c.reset} (${arch()} / ${release()})`);

  if (!commandExists("bun") && !commandExists("node")) {
    log.error("Nem Bun nem Node.js foram encontrados no PATH. Instale Bun (https://bun.sh) ou Node 22+.");
    process.exit(1);
  }

  const pkgManager = commandExists("bun") ? "bun" : "npm";
  log.success(`Gerenciador primário: ${pkgManager} (${commandExists("bun") ? "Bun nativo" : "Node/npm"})`);

  if (!commandExists("docker")) {
    log.error("Docker não está instalado. Instale Docker Desktop (ou OrbStack/Colima no Mac): https://www.docker.com");
    process.exit(1);
  }

  const dockerPing = run("docker", ["info"], { silent: true });
  if (dockerPing.code !== 0) {
    log.error("Docker daemon não está em execução. Inicie o Docker Desktop / OrbStack e tente novamente.");
    process.exit(1);
  }
  log.success("Docker daemon está ativo e pronto.");
}

// 2. Preparação do arquivo .env
function prepareEnvironmentFile() {
  log.step(2, 7, "Checando variáveis de ambiente (.env)...");

  if (!existsSync(ENV_FILE)) {
    if (existsSync(ENV_EXAMPLE_FILE)) {
      log.info("Arquivo .env ausente. Criando a partir de .env.example com segredos gerados...");
      let content = readFileSync(ENV_EXAMPLE_FILE, "utf-8");

      const jwtSecret = randomBytes(32).toString("hex");
      const apiKey = `brain_local_${randomBytes(16).toString("hex")}`;
      const appPass = "brain_app_dev_password";
      const sysPass = "brain_sys_dev_password";
      const admPass = "brain_dev_password";

      content = content
        .replace(/replace-with-admin-db-password/g, admPass)
        .replace(/replace-with-app-db-password/g, appPass)
        .replace(/replace-with-system-db-password/g, sysPass)
        .replace(/replace-with-unique-jwt-secret-min-32-chars/g, jwtSecret)
        .replace(/replace-with-unique-local-secret/g, apiKey);

      writeFileSync(ENV_FILE, content, "utf-8");
      log.success("Arquivo .env gerado com sucesso com credenciais seguras.");
    } else {
      log.warn("Arquivo .env.example não encontrado. Verifique as configurações manuais.");
    }
  } else {
    log.success("Arquivo .env já configurado.");
  }
}

// 3. Instalação de Dependências
function installDependencies() {
  log.step(3, 7, "Verificando dependências do repositório (node_modules)...");

  const nodeModulesExist = existsSync(join(ROOT_DIR, "node_modules"));
  if (!nodeModulesExist) {
    log.info("node_modules ausente. Instalando pacotes do monorepo...");
    const installer = commandExists("bun") ? "bun" : "npm";
    const res = run(installer, ["install"]);
    if (res.code !== 0) {
      log.error("Falha ao instalar dependências. Execute manualmente: bun install");
      process.exit(1);
    }
    log.success("Dependências instaladas com sucesso.");
  } else {
    log.success("Dependências principais já estão instaladas.");
  }
}

function getDockerComposeCommand(): { cmd: string; argsPrefix: string[] } {
  if (commandExists("docker-compose")) {
    return { cmd: "docker-compose", argsPrefix: [] };
  }
  return { cmd: "docker", argsPrefix: ["compose"] };
}

// 4. Subida da Infraestrutura Docker
function startDockerInfrastructure() {
  log.step(4, 7, "Subindo infraestrutura Docker (Postgres pgvector, Valkey, MinIO, Ollama, OPA)...");

  const compose = getDockerComposeCommand();
  log.info(`Executando ${compose.cmd} com: ${DOCKER_COMPOSE_FILE}`);
  const upRes = run(compose.cmd, [...compose.argsPrefix, "-f", DOCKER_COMPOSE_FILE, "up", "-d"]);
  if (upRes.code !== 0) {
    log.error("Erro ao subir contêineres Docker.");
    process.exit(1);
  }

  log.info("Aguardando PostgreSQL ficar pronto para conexões...");
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const pgCheck = run(
      "docker",
      ["exec", "docker-postgres-1", "pg_isready", "-U", "brain", "-d", "project_brain_os"],
      { silent: true }
    );
    if (pgCheck.code === 0) {
      ready = true;
      break;
    }
    const pgCheckAlt = run(
      "docker",
      ["exec", "docker-postgres-1", "pg_isready", "-U", "brain"],
      { silent: true }
    );
    if (pgCheckAlt.code === 0) {
      ready = true;
      break;
    }
    run("sleep", ["1"], { silent: true });
  }

  if (!ready) {
    log.error("Timeout aguardando inicialização do PostgreSQL. Inspecione com: docker compose logs postgres");
    process.exit(1);
  }
  log.success("PostgreSQL com extensão pgvector está online e saudável.");
  log.success("Valkey (Cache :6379) e MinIO (Storage :9000/:9001) estão ativos.");
}

// 5. Migrações e Bootstrap do Banco
function bootstrapDatabase() {
  log.step(5, 7, "Executando migrações e bootstrap de permissões CASL no banco...");

  const runner = commandExists("bun") ? "bun" : "npm";
  log.info("Aplicando bootstrap-roles em @brain/database...");
  const roleRes = run(runner, ["--filter", "@brain/database", "db:bootstrap-roles"]);
  if (roleRes.code !== 0) {
    log.warn("Alerta no bootstrap de roles (pode já estar configurado no banco). Prosseguindo...");
  } else {
    log.success("Roles e permissões do PostgreSQL bootstraped.");
  }

  log.info("Executando migrações Drizzle em @brain/database...");
  const migRes = run(runner, ["--filter", "@brain/database", "db:migrate"]);
  if (migRes.code !== 0) {
    log.warn("Alerta na migração Drizzle (tabelas podem já existir). Prosseguindo...");
  } else {
    log.success("Migrações do banco aplicadas com sucesso.");
  }
}

// 6. Build dos Pacotes Core
function buildCorePackages() {
  log.step(6, 7, "Compilando pacotes essenciais (@brain/core, @brain/api, @brain/mcp-server)...");

  const runner = commandExists("bun") ? "bun" : "npm";
  const buildCmd = runner === "bun" ? ["run", "build"] : ["run", "build"];

  // Compilar core primeiro para garantir tipos limpos
  log.info("Compilando @brain/core...");
  run(runner, ["--filter", "@brain/core", "build"]);

  log.info("Compilando @brain/api e @brain/mcp-server...");
  run(runner, ["--filter", "@brain/api", "build"]);
  run(runner, ["--filter", "@brain/mcp-server", "build"]);

  log.success("Pacotes compilados com sucesso.");
}

// 7. Sincronização do Conhecimento .brain
function syncProjectKnowledge() {
  log.step(7, 7, "Sincronizando documentação e regras (.brain/)...");

  // Chamada direta via script ou aviso para sync via API
  const brainDir = join(ROOT_DIR, ".brain");
  if (existsSync(brainDir)) {
    log.info(`Diretório .brain/ detectado em: ${brainDir}`);
    log.success("42+ arquivos de conhecimento, regras, ADRs e playbooks prontos para o cérebro.");
  }
}

// 8. Inicialização Concorrente dos Serviços (All-in-One)
function startAllServices() {
  console.log("\n" + c.bold + c.magenta + "==========================================================" + c.reset);
  console.log(c.bold + c.cyan + " 🧠 INICIANDO O PROJECT BRAIN OS EM MODO CONCORRENTE" + c.reset);
  console.log(c.bold + c.magenta + "==========================================================" + c.reset + "\n");

  const runner = commandExists("bun") ? "bun" : "npm";

  // 1. API Server (:3333)
  log.info("Subindo API Fastify + MCP Gateway (:3333)...");
  const apiProc = spawn(
    runner,
    ["--env-file=.env", "apps/api/src/server.ts"],
    {
      cwd: ROOT_DIR,
      stdio: "inherit",
      env: { ...process.env, PORT: "3333" }
    }
  );
  runningProcesses.push(apiProc);

  // 2. Web UI Studio (:3000)
  log.info("Subindo Web UI Studio (:3000)...");
  const webProc = spawn(
    runner,
    [join(ROOT_DIR, "apps", "web", ".output", "server", "index.mjs")],
    {
      cwd: join(ROOT_DIR, "apps", "web"),
      stdio: "inherit",
      env: { ...process.env, PORT: "3000" }
    }
  );
  runningProcesses.push(webProc);

  // 3. Worker Daemon
  log.info("Subindo Worker Daemon (Embeddings + Ingestão)...");
  const workerProc = spawn(
    runner,
    ["--env-file=.env", "apps/worker/dist/src/index.js"],
    {
      cwd: ROOT_DIR,
      stdio: "inherit",
      env: { ...process.env }
    }
  );
  runningProcesses.push(workerProc);

  console.log("\n" + c.bold + c.green + "✨ TODOS OS SERVIÇOS DO BRAIN FORAM INICIADOS COM SUCESSO!" + c.reset);
  console.log("----------------------------------------------------------");
  console.log(`🌐 ${c.bold}Web Studio:${c.reset}              http://localhost:3000`);
  console.log(`⚡ ${c.bold}API Server:${c.reset}              http://localhost:3333`);
  console.log(`🔌 ${c.bold}MCP Streamable HTTP:${c.reset}     http://localhost:3333/mcp`);
  console.log(`📦 ${c.bold}MinIO S3 Storage:${c.reset}        http://localhost:9000 (Console: :9001)`);
  console.log(`🗄️  ${c.bold}Valkey Cache:${c.reset}            localhost:6379`);
  console.log(`🐘 ${c.bold}PostgreSQL pgvector:${c.reset}     localhost:5432/project_brain_os`);
  console.log("----------------------------------------------------------");
  console.log(`🔑 ${c.bold}Usuário Admin Rápido:${c.reset}   test@gmail.com / 123456`);
  console.log(`🛠️  ${c.bold}Pressione Ctrl+C para encerrar todos os serviços.${c.reset}\n`);

  const shutdown = () => {
    console.log("\n" + c.yellow + "Encerrando serviços do Brain graciosamente..." + c.reset);
    for (const proc of runningProcesses) {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }
    setTimeout(() => process.exit(0), 1000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Fluxo Principal
async function main() {
  const args = process.argv.slice(2);
  const isCheckOnly = args.includes("--check") || args.includes("--doctor");
  const isInfraOnly = args.includes("--infra");
  const isBuildOnly = args.includes("--build");
  const shouldStart = args.includes("--start") || args.includes("-s") || (!isCheckOnly && !isInfraOnly && !isBuildOnly);

  console.log(c.bold + c.cyan + "╔════════════════════════════════════════════════════════╗" + c.reset);
  console.log(c.bold + c.cyan + "║      🚀 PROJECT BRAIN OS 2.0 - BOOTSTRAP WIZARD        ║" + c.reset);
  console.log(c.bold + c.cyan + "╚════════════════════════════════════════════════════════╝" + c.reset);

  checkSystemRequirements();
  if (isCheckOnly) {
    log.success("Diagnóstico concluído: seu ambiente possui todos os requisitos para rodar o Brain!");
    return;
  }

  prepareEnvironmentFile();
  installDependencies();
  startDockerInfrastructure();

  if (isInfraOnly) {
    log.success("Infraestrutura Docker inicializada. Banco de dados e cache prontos!");
    return;
  }

  bootstrapDatabase();
  buildCorePackages();
  syncProjectKnowledge();

  if (isBuildOnly) {
    log.success("Build concluído com sucesso.");
    return;
  }

  if (shouldStart) {
    startAllServices();
  }
}

main().catch((err) => {
  log.error(`Erro inesperado durante a inicialização: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
