import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@noema/audit-engine";
import type { AuthContext } from "@noema/auth";
import type { PgOperationalRepository } from "@noema/database";

export interface ApiRouteDeps {
  app: FastifyInstance;
  authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
  recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
  opRepo?: PgOperationalRepository;
}

