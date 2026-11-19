import type { FastifyInstance } from "fastify";
import { registerGraphAndChangeRoutes } from "./projects-knowledge/graph-changes.js";
import { registerKnowledgeItemRoutes } from "./projects-knowledge/knowledge.js";
import { registerProjectCoreRoutes } from "./projects-knowledge/projects.js";
import type { ProjectsKnowledgeDeps } from "./projects-knowledge/types.js";

export function registerProjectsKnowledgeRoutes(app: FastifyInstance, deps: ProjectsKnowledgeDeps) {
  registerProjectCoreRoutes(app, deps);
  registerKnowledgeItemRoutes(app, deps);
  registerGraphAndChangeRoutes(app, deps);
}
