import { trace, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

let sdkInstance: NodeSDK | undefined;

export function initTelemetry(serviceName = "noema"): NodeSDK | undefined {
  if (sdkInstance || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return sdkInstance;
  sdkInstance = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`
    })
  });
  sdkInstance.start();
  return sdkInstance;
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdkInstance) {
    await sdkInstance.shutdown();
    sdkInstance = undefined;
  }
}

export interface SpanHandle {
  name: string;
  startTimeMs: number;
  end(attributes?: Record<string, string | number | boolean>): { name: string; durationMs: number };
}

export function startSpan(name: string): SpanHandle {
  const startTimeMs = performance.now();
  const tracer: Tracer = trace.getTracer("noema");
  const otelSpan = tracer.startSpan(name);

  return {
    name,
    startTimeMs,
    end(attributes) {
      const durationMs = Math.round((performance.now() - startTimeMs) * 100) / 100;
      if (attributes) {
        otelSpan.setAttributes(attributes);
      }
      otelSpan.setStatus({ code: SpanStatusCode.OK });
      otelSpan.end();
      if (process.env.NOEMA_TRACE_LOG === "1") {
        console.log(JSON.stringify({ trace: name, durationMs, ...attributes }));
      }
      return { name, durationMs };
    }
  };
}

export async function recordLangfuseGeneration(
  input: { name: string; model: string; prompt: string; output: string; tokens?: number },
  fetchFn: typeof fetch = fetch
): Promise<boolean> {
  const host = process.env.LANGFUSE_HOST;
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  if (!host || !pub || !sec) return false;
  const auth = Buffer.from(`${pub}:${sec}`).toString("base64");
  const res = await fetchFn(`${host.replace(/\/$/, "")}/api/public/ingestion`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    body: JSON.stringify({
      batch: [
        {
          type: "generation-create",
          body: {
            name: input.name,
            model: input.model,
            input: input.prompt,
            output: input.output,
            usage: input.tokens ? { total: input.tokens } : undefined
          }
        }
      ]
    })
  });
  return res.ok;
}
