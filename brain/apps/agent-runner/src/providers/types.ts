export type LlmProviderFormat = "openai-compatible" | "anthropic";
export type LlmTransportMode = "http" | "cli";

export interface ModelCatalogItem {
  id: string;
  name?: string;
  free?: boolean;
  custom?: boolean;
  disabled?: boolean;
}

export interface ProviderSpec {
  id: string;
  mode: LlmTransportMode;
  format?: LlmProviderFormat;
  baseUrl?: string;
  envKey?: string;
  defaultApiKey?: string;
  hasFree?: boolean;
  publicModelsList?: boolean;
  headers?: Record<string, string>;
  cliCommand?: string[];
  models?: ModelCatalogItem[];
}

export interface LiveModelsResult {
  provider: string;
  online: boolean;
  models: ModelCatalogItem[];
  error?: string;
}

export interface LlmFallbackTarget {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  cliCommand?: string[];
}

export interface UnifiedLlmRequest {
  provider: string;
  model: string;
  system?: string;
  prompt: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  cliCommand?: string[];
  timeoutMs?: number;
  fallbacks?: LlmFallbackTarget[];
}

export interface UnifiedLlmResponse {
  text: string;
  provider?: string;
  model?: string;
  attempts?: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

