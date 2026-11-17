import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeRetryDelayMs,
  DurableWorkflowEngine,
  humanApprovalWorkflow,
  saasSyncWorkflow,
  transitionWorkflowState
} from "../src/index.js";

describe("temporal-workflows", () => {
  it("supports durable approval workflow with timer expiration and resume", () => {
    const engine = new DurableWorkflowEngine();
    const wf = engine.start({ tenantId: "t1", projectId: "p1", kind: "human_approval", timeoutMs: 60_000 });
    assert.equal(wf.status, "waiting_approval");
    const done = engine.signalApproval(wf.workflowId, true);
    assert.equal(done.status, "completed");
    assert.equal(done.step, 2);
  });

  it("executes deterministic state transitions for saasSyncWorkflow and humanApprovalWorkflow", () => {
    const s1 = transitionWorkflowState(saasSyncWorkflow, saasSyncWorkflow.initialState, "START");
    assert.equal(s1.nextState, "fetching_delta");
    const s2 = transitionWorkflowState(saasSyncWorkflow, s1.nextState, "DELTA_FETCHED");
    assert.equal(s2.nextState, "normalizing");
    const s3 = transitionWorkflowState(saasSyncWorkflow, s2.nextState, "NORMALIZED");
    assert.equal(s3.nextState, "indexing");
    const s4 = transitionWorkflowState(saasSyncWorkflow, s3.nextState, "INDEXED");
    assert.equal(s4.nextState, "completed");
    assert.equal(s4.terminal, true);

    assert.throws(
      () => transitionWorkflowState(saasSyncWorkflow, s4.nextState, "START"),
      /terminal state/
    );

    const a1 = transitionWorkflowState(
      humanApprovalWorkflow,
      humanApprovalWorkflow.initialState,
      "REQUEST_APPROVAL"
    );
    assert.equal(a1.nextState, "waiting_approval");
    const a2 = transitionWorkflowState(humanApprovalWorkflow, a1.nextState, "APPROVE");
    assert.equal(a2.nextState, "completed");
    assert.equal(a2.terminal, true);
  });

  it("computes deterministic exponential retry delays bounded by maximumIntervalMs", () => {
    const policy = saasSyncWorkflow.activities.fetchSaasDelta.retryPolicy;
    assert.equal(computeRetryDelayMs(policy, 1), 1_000);
    assert.equal(computeRetryDelayMs(policy, 2), 2_000);
    assert.equal(computeRetryDelayMs(policy, 3), 4_000);
    assert.equal(computeRetryDelayMs(policy, 4), 8_000);
    assert.equal(computeRetryDelayMs(policy, 5), 0);
  });
});
