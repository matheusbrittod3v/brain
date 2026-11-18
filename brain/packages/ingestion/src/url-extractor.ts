import TurndownService from "turndown";

export interface ExtractedUrlDocument {
  url: string;
  title: string;
  markdown: string;
  contentType: string;
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

/**
 * Fetches an external HTTP/HTTPS documentation page or Markdown file
 * and normalizes it into clean Markdown for the Brain Knowledge Hub.
 */
export async function extractMarkdownFromUrl(
  rawUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<ExtractedUrlDocument> {
  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Apenas URLs http:// ou https:// são suportadas.");
  }

  const res = await fetchFn(parsed.toString(), {
    headers: { "user-agent": "brain-brain-ingestion/1.0" }
  });
  if (!res.ok) {
    throw new Error(`Falha ao buscar URL (${res.status} ${res.statusText}).`);
  }

  const contentType = res.headers.get("content-type") ?? "text/plain";
  const body = await res.text();

  if (contentType.includes("text/html")) {
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1]!.replace(/\s+/g, " ").trim() : parsed.hostname;
    const cleanedHtml = body
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
    const markdown = turndown.turndown(cleanedHtml).trim();
    return { url: parsed.toString(), title, markdown, contentType };
  }

  const firstHeading = body.match(/^#\s+(.+)$/m);
  const title = firstHeading ? firstHeading[1]!.trim() : parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
  return { url: parsed.toString(), title, markdown: body.trim(), contentType };
}

