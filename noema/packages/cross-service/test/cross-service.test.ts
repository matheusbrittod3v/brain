import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CrossServiceContractRegistry,
  PostgresCrossServiceRegistry,
  parseServiceContractSpec
} from "../src/index.js";
import type { AuthContext } from "@noema/auth";
import type { AppPostgresClient } from "@noema/database";

const baseCtx: AuthContext = {
  tenantId: "t1",
  actorId: "u1",
  actorType: "human",
  roles: ["developer"],
  allowedProjects: ["checkout", "billing"],
  allowedPolicies: ["internal-project"]
};

describe("cross-service", () => {
  it("computes distributed blast radius respecting project isolation", () => {
    const reg = new CrossServiceContractRegistry();
    reg.registerContract({
      tenantId: "t1",
      fromProjectId: "checkout",
      fromService: "checkout-api",
      relation: "CONSUMES_API",
      toProjectId: "billing",
      contractId: "POST /v1/invoices",
      schemaVersion: "1.0.0",
      accessPolicyId: "internal-project"
    });
    reg.registerContract({
      tenantId: "t1",
      fromProjectId: "secret-proj",
      fromService: "secret-svc",
      relation: "CONSUMES_API",
      toProjectId: "billing",
      contractId: "POST /v1/invoices",
      schemaVersion: "1.0.0",
      accessPolicyId: "internal-project"
    });

    const blast = reg.computeDistributedBlastRadius(baseCtx, "POST /v1/invoices");
    assert.deepEqual(blast.impactedProjects, ["checkout", "billing"]);
    assert.equal(blast.impactedServices.length, 1);
    assert.equal(blast.impactedServices[0]?.service, "checkout-api");
  });

  it("parses OpenAPI JSON and YAML deterministically", () => {
    const jsonSpec = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Billing API", version: "2.1.0" },
      paths: {
        "/v1/refunds": { post: { operationId: "createRefund" } },
        "/v1/invoices": { get: { operationId: "listInvoices" }, post: { operationId: "createInvoice" } }
      }
    });
    const parsedJson = parseServiceContractSpec(jsonSpec, "openapi");
    assert.equal(parsedJson.format, "openapi");
    assert.equal(parsedJson.title, "Billing API");
    assert.equal(parsedJson.version, "2.1.0");
    assert.deepEqual(
      parsedJson.items.map((i) => i.id),
      ["GET /v1/invoices", "POST /v1/invoices", "POST /v1/refunds"]
    );

    const yamlSpec = `
openapi: 3.0.0
info:
  title: Checkout API
  version: 1.2.0
paths:
  /v1/orders:
    post:
    get:
`;
    const parsedYaml = parseServiceContractSpec(yamlSpec, "openapi");
    assert.equal(parsedYaml.title, "Checkout API");
    assert.equal(parsedYaml.version, "1.2.0");
    assert.deepEqual(
      parsedYaml.items.map((i) => i.id),
      ["GET /v1/orders", "POST /v1/orders"]
    );
  });

  it("parses AsyncAPI and Protobuf specs deterministically", () => {
    const asyncSpec = `
asyncapi: 2.6.0
info:
  title: Order Events
  version: 1.0.0
channels:
  order.created:
    publish:
  payment.settled:
    subscribe:
`;
    const parsedAsync = parseServiceContractSpec(asyncSpec, "asyncapi");
    assert.equal(parsedAsync.title, "Order Events");
    assert.equal(parsedAsync.items.length, 2);
    assert.equal(parsedAsync.items[0]?.relationHint, "PUBLISHES_EVENT");
    assert.equal(parsedAsync.items[1]?.relationHint, "SUBSCRIBES_TO");

    const protoSpec = `
syntax = "proto3";
package noema.billing.v1;

message InvoiceCreated {
  string invoice_id = 1;
}

service BillingService {
  rpc CreateInvoice (InvoiceRequest) returns (InvoiceResponse);
}
`;
    const parsedProto = parseServiceContractSpec(protoSpec, "protobuf");
    assert.equal(parsedProto.title, "noema.billing.v1");
    assert.equal(parsedProto.version, "v1");
    assert.deepEqual(
      parsedProto.items.map((i) => `${i.kind}:${i.id}`),
      ["message:InvoiceCreated", "rpc:BillingService.CreateInvoice"]
    );
  });

  it("persists and queries contracts via PostgresCrossServiceRegistry using withRlsTransaction", async () => {
    const storedRows: Array<Record<string, unknown>> = [];
    const rlsCalls: Array<{ tenantId: string; projects: string[]; policies: string[] }> = [];

    const mockClient: AppPostgresClient<any> = {
      role: "brain_app",
      sql: {
        begin: async (cb: any) => cb(async () => [])
      },
      async withRlsTransaction(ctx, cb) {
        rlsCalls.push({
          tenantId: ctx.tenantId,
          projects: [...ctx.allowedProjects],
          policies: [...ctx.allowedPolicies]
        });
        const tx = async (strings: TemplateStringsArray, ...params: unknown[]) => {
          const sql = strings.join(" ").replace(/\s+/g, " ").trim();
          if (sql.startsWith("INSERT INTO cross_service_contracts")) {
            storedRows.push({
              tenant_id: params[0],
              from_project_id: params[1],
              from_service: params[2],
              relation: params[3],
              to_project_id: params[4],
              contract_id: params[5],
              schema_version: params[6],
              access_policy_id: params[7]
            });
            return [];
          }
          if (sql.includes("FROM cross_service_contracts")) {
            return storedRows.filter(
              (r) =>
                r.tenant_id === params[0] &&
                (params.length === 1 || r.contract_id === params[1])
            );
          }
          return [];
        };
        return cb(tx);
      },
      async close() {}
    };

    const pgRegistry = new PostgresCrossServiceRegistry(mockClient);
    await pgRegistry.registerContract(
      {
        tenantId: "t1",
        fromProjectId: "checkout",
        fromService: "checkout-api",
        relation: "CONSUMES_API",
        toProjectId: "billing",
        contractId: "POST /v1/invoices",
        schemaVersion: "1.0.0",
        accessPolicyId: "internal-project"
      },
      baseCtx
    );
    await pgRegistry.registerContract(
      {
        tenantId: "t1",
        fromProjectId: "restricted-proj",
        fromService: "restricted-svc",
        relation: "CONSUMES_API",
        toProjectId: "billing",
        contractId: "POST /v1/invoices",
        schemaVersion: "1.0.0",
        accessPolicyId: "internal-project"
      },
      {
        ...baseCtx,
        allowedProjects: ["restricted-proj", "billing"]
      }
    );

    const blast = await pgRegistry.computeDistributedBlastRadius(baseCtx, "POST /v1/invoices");
    assert.deepEqual(blast.impactedProjects, ["checkout", "billing"]);
    assert.equal(blast.impactedServices.length, 1);
    assert.equal(rlsCalls.length, 3);

    const pack = await pgRegistry.buildFederatedContextPack(baseCtx, ["checkout", "restricted-proj"]);
    assert.deepEqual(pack.projects, ["checkout"]);
    assert.equal(pack.contracts.length, 1);
  });
});
