import { randomUUID } from "node:crypto";

export type WorkflowStatus = "running" | "waiting_approval" | "completed" | "timed_out" | "rejected";

export interface DurableWorkflowState {
  workflowId: string;
  tenantId: string;
  projectId: string;
  kind: "saas_sync" | "human_approval";
  step: number;
  status: WorkflowStatus;
  checkpoint: Record<string, unknown>;
  expiresAtMs: number;
}

export interface RetryPolicy {
  initialIntervalMs: number;
  backoffCoefficient: number;
  maximumIntervalMs: number;
  maximumAttempts: number;
  nonRetryableErrorTypes?: readonly string[];
}

export interface ActivityContract<TInput = unknown, TOutput = unknown> {
  name: string;
  startToCloseTimeoutMs: number;
  scheduleToCloseTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  retryPolicy: RetryPolicy;
  readonly __input?: TInput;
  readonly __output?: TOutput;
}

export interface WorkflowTransition<TState extends string = string, TEvent extends string = string> {
  from: TState;
  event: TEvent;
  to: TState;
}

export interface TemporalWorkflowContract<
  TInput = unknown,
  TOutput = unknown,
  TState extends string = string,
  TEvent extends string = string,
  TActivities extends Record<string, ActivityContract<any, any>> = Record<
    string,
    ActivityContract<any, any>
  >
> {
  workflowType: string;
  taskQueue: string;
  executionTimeoutMs: number;
  runTimeoutMs: number;
  retryPolicy: RetryPolicy;
  initialState: TState;
  terminalStates: readonly TState[];
  transitions: readonly WorkflowTransition<TState, TEvent>[];
  activities: TActivities;
  readonly __input?: TInput;
  readonly __output?: TOutput;
}

export type SaasSyncState =
  | "pending"
  | "fetching_delta"
  | "normalizing"
  | "indexing"
  | "completed"
  | "failed"
  | "timed_out";

export type SaasSyncEvent =
  | "START"
  | "DELTA_FETCHED"
  | "NORMALIZED"
  | "INDEXED"
  | "FAIL"
  | "TIMEOUT";

export interface SaasSyncInput {
  tenantId: string;
  projectId: string;
  connectorId: string;
  cursor?: string;
}

export interface SaasSyncOutput {
  syncedCount: number;
  nextCursor?: string;
}

export const saasSyncWorkflow: TemporalWorkflowContract<
  SaasSyncInput,
  SaasSyncOutput,
  SaasSyncState,
  SaasSyncEvent,
  {
    fetchSaasDelta: ActivityContract<
      SaasSyncInput,
      { rawRecords: unknown[]; nextCursor?: string }
    >;
    normalizeKnowledgeBatch: ActivityContract<
      { tenantId: string; projectId: string; rawRecords: unknown[] },
      { normalizedIds: string[] }
    >;
    indexKnowledgeBatch: ActivityContract<
      { tenantId: string; projectId: string; normalizedIds: string[] },
      { indexedCount: number }
    >;
  }
> = {
  workflowType: "saasSyncWorkflow",
  taskQueue: "noema-ingestion",
  executionTimeoutMs: 30 * 60_000,
  runTimeoutMs: 10 * 60_000,
  retryPolicy: {
    initialIntervalMs: 1_000,
    backoffCoefficient: 2,
    maximumIntervalMs: 60_000,
    maximumAttempts: 5,
    nonRetryableErrorTypes: ["BRAIN_ERR_UNAUTHORIZED", "BRAIN_ERR_POLICY_DENIED"]
  },
  initialState: "pending",
  terminalStates: ["completed", "failed", "timed_out"],
  transitions: [
    { from: "pending", event: "START", to: "fetching_delta" },
    { from: "fetching_delta", event: "DELTA_FETCHED", to: "normalizing" },
    { from: "normalizing", event: "NORMALIZED", to: "indexing" },
    { from: "indexing", event: "INDEXED", to: "completed" },
    { from: "fetching_delta", event: "FAIL", to: "failed" },
    { from: "normalizing", event: "FAIL", to: "failed" },
    { from: "indexing", event: "FAIL", to: "failed" },
    { from: "pending", event: "TIMEOUT", to: "timed_out" },
    { from: "fetching_delta", event: "TIMEOUT", to: "timed_out" },
    { from: "normalizing", event: "TIMEOUT", to: "timed_out" },
    { from: "indexing", event: "TIMEOUT", to: "timed_out" }
  ],
  activities: {
    fetchSaasDelta: {
      name: "fetchSaasDelta",
      startToCloseTimeoutMs: 120_000,
      heartbeatTimeoutMs: 30_000,
      retryPolicy: {
        initialIntervalMs: 1_000,
        backoffCoefficient: 2,
        maximumIntervalMs: 30_000,
        maximumAttempts: 4,
        nonRetryableErrorTypes: ["BRAIN_ERR_UNAUTHORIZED"]
      }
    },
    normalizeKnowledgeBatch: {
      name: "normalizeKnowledgeBatch",
      startToCloseTimeoutMs: 60_000,
      retryPolicy: {
        initialIntervalMs: 500,
        backoffCoefficient: 2,
        maximumIntervalMs: 15_000,
        maximumAttempts: 3
      }
    },
    indexKnowledgeBatch: {
      name: "indexKnowledgeBatch",
      startToCloseTimeoutMs: 120_000,
      heartbeatTimeoutMs: 30_000,
      retryPolicy: {
        initialIntervalMs: 1_000,
        backoffCoefficient: 2,
        maximumIntervalMs: 30_000,
        maximumAttempts: 4
      }
    }
  }
};

export type HumanApprovalState =
  | "pending"
  | "waiting_approval"
  | "completed"
  | "rejected"
  | "timed_out";

export type HumanApprovalEvent =
  | "REQUEST_APPROVAL"
  | "APPROVE"
  | "REJECT"
  | "TIMEOUT";

export interface HumanApprovalInput {
  tenantId: string;
  projectId: string;
  itemId: string;
  requestedBy: string;
  timeoutMs: number;
}

export interface HumanApprovalOutput {
  approved: boolean;
  reviewedBy?: string;
  reason?: string;
}

export const humanApprovalWorkflow: TemporalWorkflowContract<
  HumanApprovalInput,
  HumanApprovalOutput,
  HumanApprovalState,
  HumanApprovalEvent,
  {
    notifyReviewers: ActivityContract<HumanApprovalInput, { notifiedCount: number }>;
    applyApprovedChange: ActivityContract<
      { tenantId: string; projectId: string; itemId: string; reviewedBy: string },
      { applied: boolean }
    >;
    recordRejectionAudit: ActivityContract<
      { tenantId: string; projectId: string; itemId: string; reason?: string },
      { recorded: boolean }
    >;
  }
> = {
  workflowType: "humanApprovalWorkflow",
  taskQueue: "noema-approvals",
  executionTimeoutMs: 7 * 24 * 60 * 60_000,
  runTimeoutMs: 24 * 60 * 60_000,
  retryPolicy: {
    initialIntervalMs: 2_000,
    backoffCoefficient: 2,
    maximumIntervalMs: 60_000,
    maximumAttempts: 3,
    nonRetryableErrorTypes: ["BRAIN_ERR_POLICY_DENIED", "BRAIN_ERR_NOT_FOUND"]
  },
  initialState: "pending",
  terminalStates: ["completed", "rejected", "timed_out"],
  transitions: [
    { from: "pending", event: "REQUEST_APPROVAL", to: "waiting_approval" },
    { from: "waiting_approval", event: "APPROVE", to: "completed" },
    { from: "waiting_approval", event: "REJECT", to: "rejected" },
    { from: "pending", event: "TIMEOUT", to: "timed_out" },
    { from: "waiting_approval", event: "TIMEOUT", to: "timed_out" }
  ],
  activities: {
    notifyReviewers: {
      name: "notifyReviewers",
      startToCloseTimeoutMs: 30_000,
      retryPolicy: {
        initialIntervalMs: 1_000,
        backoffCoefficient: 2,
        maximumIntervalMs: 10_000,
        maximumAttempts: 3
      }
    },
    applyApprovedChange: {
      name: "applyApprovedChange",
      startToCloseTimeoutMs: 60_000,
      retryPolicy: {
        initialIntervalMs: 1_000,
        backoffCoefficient: 2,
        maximumIntervalMs: 15_000,
        maximumAttempts: 3,
        nonRetryableErrorTypes: ["BRAIN_ERR_CONFLICT"]
      }
    },
    recordRejectionAudit: {
      name: "recordRejectionAudit",
      startToCloseTimeoutMs: 30_000,
      retryPolicy: {
        initialIntervalMs: 500,
        backoffCoefficient: 2,
        maximumIntervalMs: 10_000,
        maximumAttempts: 3
      }
    }
  }
};

export function transitionWorkflowState<TState extends string, TEvent extends string>(
  contract: TemporalWorkflowContract<any, any, TState, TEvent, any>,
  currentState: TState,
  event: TEvent
): { previousState: TState; nextState: TState; event: TEvent; terminal: boolean } {
  if (contract.terminalStates.includes(currentState)) {
    throw new Error(
      `Workflow '${contract.workflowType}' is already in terminal state '${currentState}'.`
    );
  }
  const match = contract.transitions.find(
    (t) => t.from === currentState && t.event === event
  );
  if (!match) {
    throw new Error(
      `Invalid transition for '${contract.workflowType}': '${currentState}' --(${event})--> ?`
    );
  }
  return {
    previousState: currentState,
    nextState: match.to,
    event,
    terminal: contract.terminalStates.includes(match.to)
  };
}

export function computeRetryDelayMs(policy: RetryPolicy, attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  if (safeAttempt > policy.maximumAttempts) {
    return 0;
  }
  const raw = policy.initialIntervalMs * Math.pow(policy.backoffCoefficient, safeAttempt - 1);
  return Math.min(policy.maximumIntervalMs, Math.round(raw));
}

/**
 * Orquestração durável multi-etapas com retomada, timers e aprovação humana (Fase 5 / Temporal).
 */
export class DurableWorkflowEngine {
  private readonly workflows = new Map<string, DurableWorkflowState>();

  start(input: {
    tenantId: string;
    projectId: string;
    kind: DurableWorkflowState["kind"];
    timeoutMs?: number;
    checkpoint?: Record<string, unknown>;
  }): DurableWorkflowState {
    const state: DurableWorkflowState = {
      workflowId: `WF-${randomUUID().slice(0, 8)}`,
      tenantId: input.tenantId,
      projectId: input.projectId,
      kind: input.kind,
      step: 1,
      status: input.kind === "human_approval" ? "waiting_approval" : "running",
      checkpoint: input.checkpoint ?? {},
      expiresAtMs: Date.now() + (input.timeoutMs ?? 24 * 60 * 60_000)
    };
    this.workflows.set(state.workflowId, state);
    return state;
  }

  signalApproval(workflowId: string, approved: boolean, nowMs = Date.now()): DurableWorkflowState {
    const wf = this.workflows.get(workflowId);
    if (!wf) throw new Error(`Workflow '${workflowId}' não encontrado.`);
    if (nowMs > wf.expiresAtMs) {
      wf.status = "timed_out";
      return wf;
    }
    wf.step += 1;
    wf.status = approved ? "completed" : "rejected";
    return wf;
  }

  get(workflowId: string): DurableWorkflowState | undefined {
    return this.workflows.get(workflowId);
  }
}

export async function startRemoteTemporalWorkflow(
  input: { workflowId: string; taskQueue: string; workflowType: string; args: unknown[] },
  temporalHttpBridgeUrl = process.env.TEMPORAL_HTTP_BRIDGE_URL,
  fetchFn: typeof fetch = fetch
): Promise<{ started: boolean; workflowId: string }> {
  if (!temporalHttpBridgeUrl) {
    return { started: false, workflowId: input.workflowId };
  }
  const res = await fetchFn(`${temporalHttpBridgeUrl.replace(/\/$/, "")}/workflows/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  return { started: res.ok, workflowId: input.workflowId };
}
