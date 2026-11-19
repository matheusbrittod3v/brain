export type ServiceContractRelation = "CONSUMES_API" | "PUBLISHES_EVENT" | "SUBSCRIBES_TO";
export type ServiceContractFormat = "openapi" | "asyncapi" | "protobuf";

export interface CrossServiceContractEdge {
  tenantId: string;
  fromProjectId: string;
  fromService: string;
  relation: ServiceContractRelation;
  toProjectId: string;
  contractId: string;
  schemaVersion: string;
  accessPolicyId: string;
}

export interface DistributedBlastRadius {
  contractId: string;
  impactedProjects: string[];
  impactedServices: Array<{ projectId: string; service: string; relation: ServiceContractRelation }>;
}

export interface ParsedServiceContractItem {
  kind: "endpoint" | "event" | "message" | "rpc";
  id: string;
  name: string;
  method?: string;
  path?: string;
  service?: string;
  relationHint: ServiceContractRelation;
}

export interface ParsedServiceContractSpec {
  format: ServiceContractFormat;
  title?: string;
  version: string;
  items: ParsedServiceContractItem[];
}

