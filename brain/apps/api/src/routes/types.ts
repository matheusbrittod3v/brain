import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@brain/audit-engine";
import type { AuthContext } from "@brain/auth";
import type { PgAuthRepository, PgMcpAuthRepository, PgOperationalRepository } from "@brain/database";

export interface ApiRouteDeps {
  app: FastifyInstance;
  authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
  recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
  opRepo?: PgOperationalRepository;
  authRepo?: PgAuthRepository;
  mcpAuthRepo?: PgMcpAuthRepository;
}

