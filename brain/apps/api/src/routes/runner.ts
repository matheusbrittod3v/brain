import type { FastifyInstance } from "fastify";
import { registerRunnerExtensionRoutes } from "./runner/extensions.js";
import { registerRunnerProviderRoutes } from "./runner/providers.js";
import { createRunnerSharedState, type RunnerRouteDeps } from "./runner/security.js";
import { registerRunnerTaskRoutes } from "./runner/tasks.js";

export function registerRunnerRoutes(app: FastifyInstance, deps: RunnerRouteDeps) {
  const state = createRunnerSharedState();
  registerRunnerTaskRoutes(app, deps, state);
  registerRunnerProviderRoutes(app, deps, state);
  registerRunnerExtensionRoutes(app, deps);
}
