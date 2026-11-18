export interface LoopMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  toolCallId?: string;
}

export interface CompactionOptions {
  /** Approximate token budget before compaction triggers (default 24_000). */
  maxTokens?: number;
  /** Number of most recent non-system messages to preserve verbatim (default 8). */
  keepRecentMessages?: number;
  /** Optional async summarizer; falls back to deterministic extractive summary. */
  summarizer?: (droppedMessages: LoopMessage[]) => Promise<string>;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: readonly LoopMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4;
  }
  return total;
}

/**
 * Truncates oversized tool outputs (adapted from pi-coding-agent compaction utils)
 * keeping both head and tail so stack traces / summaries remain visible.
 */
export function truncateToolOutput(output: string, maxChars = 12_000): string {
  if (output.length <= maxChars) return output;
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = Math.floor(maxChars * 0.3);
  const omitted = output.length - headChars - tailChars;
  return `${output.slice(0, headChars)}\n\n...[truncated ${omitted} chars]...\n\n${output.slice(-tailChars)}`;
}

/**
 * Compacts older conversation turns when the transcript exceeds `maxTokens`.
 * Always preserves leading system messages and the most recent `keepRecentMessages`.
 */
export async function compactConversationHistory(
  messages: readonly LoopMessage[],
  options: CompactionOptions = {}
): Promise<{ messages: LoopMessage[]; compacted: boolean; droppedCount: number }> {
  const maxTokens = options.maxTokens ?? 24_000;
  const keepRecent = options.keepRecentMessages ?? 8;

  if (estimateMessagesTokens(messages) <= maxTokens) {
    return { messages: [...messages], compacted: false, droppedCount: 0 };
  }

  const systemMessages: LoopMessage[] = [];
  const conversation: LoopMessage[] = [];
  for (const m of messages) {
    if (m.role === "system" && conversation.length === 0) {
      systemMessages.push(m);
    } else {
      conversation.push(m);
    }
  }

  if (conversation.length <= keepRecent) {
    return { messages: [...messages], compacted: false, droppedCount: 0 };
  }

  const dropped = conversation.slice(0, conversation.length - keepRecent);
  const recent = conversation.slice(conversation.length - keepRecent);

  const summaryText = options.summarizer
    ? await options.summarizer(dropped)
    : dropped
      .map((m) => `[${m.role}${m.toolName ? `:${m.toolName}` : ""}]: ${m.content.slice(0, 220).replace(/\s+/g, " ")}`)
      .join("\n");

  const summaryMessage: LoopMessage = {
    role: "system",
    content: `[Compacted History (${dropped.length} earlier messages)]\n${summaryText}`
  };

  return {
    messages: [...systemMessages, summaryMessage, ...recent],
    compacted: true,
    droppedCount: dropped.length
  };
}

