import type { ParsedServiceContractItem, ParsedServiceContractSpec, ServiceContractFormat } from "./types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

function tryParseJson(rawContent: string): Record<string, unknown> | null {
  const trimmed = rawContent.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function sortContractItems(items: ParsedServiceContractItem[]): ParsedServiceContractItem[] {
  return [...items].sort((a, b) => {
    const kindCmp = a.kind.localeCompare(b.kind);
    if (kindCmp !== 0) return kindCmp;
    return a.id.localeCompare(b.id);
  });
}

function parseOpenApiSpec(rawContent: string): ParsedServiceContractSpec {
  const json = tryParseJson(rawContent);
  const items: ParsedServiceContractItem[] = [];
  let title: string | undefined;
  let version = "1.0.0";

  if (json) {
    const info = json.info as Record<string, unknown> | undefined;
    if (typeof info?.title === "string") title = info.title;
    if (typeof info?.version === "string") version = info.version;

    const paths = json.paths as Record<string, Record<string, unknown>> | undefined;
    if (paths && typeof paths === "object") {
      for (const pathKey of Object.keys(paths).sort()) {
        const pathObj = paths[pathKey];
        if (!pathObj || typeof pathObj !== "object") continue;
        for (const methodKey of Object.keys(pathObj).sort()) {
          const lower = methodKey.toLowerCase();
          if (!HTTP_METHODS.has(lower)) continue;
          const op = pathObj[methodKey] as Record<string, unknown> | undefined;
          const method = lower.toUpperCase();
          const id = `${method} ${pathKey}`;
          items.push({
            kind: "endpoint",
            id,
            name: typeof op?.operationId === "string" ? op.operationId : id,
            method,
            path: pathKey,
            relationHint: "CONSUMES_API"
          });
        }
      }
    }

    return {
      format: "openapi",
      ...(title ? { title } : {}),
      version,
      items: sortContractItems(items)
    };
  }

  let section: "root" | "info" | "paths" = "root";
  let currentPath: string | null = null;
  let pathIndent = -1;

  for (const rawLine of rawContent.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.search(/\S/);
    const trimmed = withoutComment.trim();

    if (indent === 0) {
      currentPath = null;
      if (trimmed === "info:") section = "info";
      else if (trimmed === "paths:") section = "paths";
      else section = "root";
      continue;
    }

    if (section === "info") {
      const match = /^([a-zA-Z0-9_-]+):\s*(.+)$/.exec(trimmed);
      if (match) {
        if (match[1] === "title") title = unquoteYamlScalar(match[2]!);
        if (match[1] === "version") version = unquoteYamlScalar(match[2]!);
      }
    } else if (section === "paths") {
      if (trimmed.startsWith("/") && trimmed.endsWith(":")) {
        currentPath = trimmed.slice(0, -1).trim();
        pathIndent = indent;
      } else if (currentPath && indent > pathIndent) {
        const methodMatch = /^([a-zA-Z]+):\s*$/.exec(trimmed);
        if (methodMatch) {
          const lower = methodMatch[1]!.toLowerCase();
          if (HTTP_METHODS.has(lower)) {
            const method = lower.toUpperCase();
            const id = `${method} ${currentPath}`;
            items.push({
              kind: "endpoint",
              id,
              name: id,
              method,
              path: currentPath,
              relationHint: "CONSUMES_API"
            });
          }
        }
      }
    }
  }

  return {
    format: "openapi",
    ...(title ? { title } : {}),
    version,
    items: sortContractItems(items)
  };
}

function parseAsyncApiSpec(rawContent: string): ParsedServiceContractSpec {
  const json = tryParseJson(rawContent);
  const items: ParsedServiceContractItem[] = [];
  let title: string | undefined;
  let version = "1.0.0";

  if (json) {
    const info = json.info as Record<string, unknown> | undefined;
    if (typeof info?.title === "string") title = info.title;
    if (typeof info?.version === "string") version = info.version;

    const channels = json.channels as Record<string, Record<string, unknown>> | undefined;
    if (channels && typeof channels === "object") {
      for (const channelName of Object.keys(channels).sort()) {
        const ch = channels[channelName];
        if (!ch || typeof ch !== "object") continue;
        let matchedOp = false;
        if ("publish" in ch) {
          matchedOp = true;
          const pub = ch.publish as Record<string, unknown> | undefined;
          const msg = pub?.message as Record<string, unknown> | undefined;
          const name = typeof msg?.name === "string"
            ? msg.name
            : typeof pub?.operationId === "string"
              ? pub.operationId
              : channelName;
          items.push({
            kind: "event",
            id: channelName,
            name,
            path: channelName,
            relationHint: "PUBLISHES_EVENT"
          });
        }
        if ("subscribe" in ch) {
          matchedOp = true;
          const sub = ch.subscribe as Record<string, unknown> | undefined;
          const msg = sub?.message as Record<string, unknown> | undefined;
          const name = typeof msg?.name === "string"
            ? msg.name
            : typeof sub?.operationId === "string"
              ? sub.operationId
              : channelName;
          items.push({
            kind: "event",
            id: `${channelName}#subscribe`,
            name,
            path: channelName,
            relationHint: "SUBSCRIBES_TO"
          });
        }
        if (!matchedOp) {
          items.push({
            kind: "event",
            id: channelName,
            name: channelName,
            path: channelName,
            relationHint: "PUBLISHES_EVENT"
          });
        }
      }
    }

    return {
      format: "asyncapi",
      ...(title ? { title } : {}),
      version,
      items: sortContractItems(items)
    };
  }

  let section: "root" | "info" | "channels" = "root";
  let currentChannel: string | null = null;
  let channelIndent = -1;
  let currentChannelHasOp = false;

  const flushChannelFallback = () => {
    if (currentChannel && !currentChannelHasOp) {
      items.push({
        kind: "event",
        id: currentChannel,
        name: currentChannel,
        path: currentChannel,
        relationHint: "PUBLISHES_EVENT"
      });
    }
  };

  for (const rawLine of rawContent.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.search(/\S/);
    const trimmed = withoutComment.trim();

    if (indent === 0) {
      flushChannelFallback();
      currentChannel = null;
      currentChannelHasOp = false;
      if (trimmed === "info:") section = "info";
      else if (trimmed === "channels:") section = "channels";
      else section = "root";
      continue;
    }

    if (section === "info") {
      const match = /^([a-zA-Z0-9_-]+):\s*(.+)$/.exec(trimmed);
      if (match) {
        if (match[1] === "title") title = unquoteYamlScalar(match[2]!);
        if (match[1] === "version") version = unquoteYamlScalar(match[2]!);
      }
    } else if (section === "channels") {
      if (currentChannel === null || indent <= channelIndent) {
        if (trimmed.endsWith(":")) {
          flushChannelFallback();
          currentChannel = unquoteYamlScalar(trimmed.slice(0, -1));
          channelIndent = indent;
          currentChannelHasOp = false;
        }
      } else if (currentChannel && indent > channelIndent) {
        if (trimmed === "publish:") {
          currentChannelHasOp = true;
          items.push({
            kind: "event",
            id: currentChannel,
            name: currentChannel,
            path: currentChannel,
            relationHint: "PUBLISHES_EVENT"
          });
        } else if (trimmed === "subscribe:") {
          currentChannelHasOp = true;
          items.push({
            kind: "event",
            id: `${currentChannel}#subscribe`,
            name: currentChannel,
            path: currentChannel,
            relationHint: "SUBSCRIBES_TO"
          });
        }
      }
    }
  }
  flushChannelFallback();

  return {
    format: "asyncapi",
    ...(title ? { title } : {}),
    version,
    items: sortContractItems(items)
  };
}

function parseProtobufSpec(rawContent: string): ParsedServiceContractSpec {
  const items: ParsedServiceContractItem[] = [];
  let title: string | undefined;
  let version = "1.0.0";

  const pkgMatch = /^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m.exec(rawContent);
  if (pkgMatch) {
    title = pkgMatch[1];
    const verMatch = /\b(v\d+(?:alpha\d*|beta\d*)?)\b/.exec(pkgMatch[1]!);
    if (verMatch) {
      version = verMatch[1]!;
    }
  }

  let currentService: string | null = null;
  let serviceBraceDepth = 0;

  for (const rawLine of rawContent.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;

    const svcMatch = /^service\s+([A-Za-z0-9_]+)\s*\{/.exec(line);
    if (svcMatch) {
      currentService = svcMatch[1]!;
      serviceBraceDepth = 1;
      continue;
    }

    if (currentService) {
      const rpcMatch = /^rpc\s+([A-Za-z0-9_]+)\s*\(/.exec(line);
      if (rpcMatch) {
        const rpcName = rpcMatch[1]!;
        items.push({
          kind: "rpc",
          id: `${currentService}.${rpcName}`,
          name: rpcName,
          method: rpcName,
          service: currentService,
          relationHint: "CONSUMES_API"
        });
      }
      for (const ch of line) {
        if (ch === "{") serviceBraceDepth += 1;
        else if (ch === "}") serviceBraceDepth -= 1;
      }
      if (serviceBraceDepth <= 0) {
        currentService = null;
        serviceBraceDepth = 0;
      }
      continue;
    }

    const msgMatch = /^message\s+([A-Za-z0-9_]+)\s*\{/.exec(line);
    if (msgMatch) {
      const msgName = msgMatch[1]!;
      items.push({
        kind: "message",
        id: msgName,
        name: msgName,
        relationHint: "PUBLISHES_EVENT"
      });
    }
  }

  return {
    format: "protobuf",
    ...(title ? { title } : {}),
    version,
    items: sortContractItems(items)
  };
}

/**
 * Deterministically parses OpenAPI, AsyncAPI, or Protobuf specifications into
 * normalized endpoints, events, messages, and RPC contracts.
 */
export function parseServiceContractSpec(
  rawContent: string,
  format: ServiceContractFormat
): ParsedServiceContractSpec {
  if (format === "openapi") return parseOpenApiSpec(rawContent);
  if (format === "asyncapi") return parseAsyncApiSpec(rawContent);
  if (format === "protobuf") return parseProtobufSpec(rawContent);
  throw new Error(`Unsupported service contract format '${String(format)}'.`);
}

