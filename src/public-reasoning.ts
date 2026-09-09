/** Responses compatibility for Microsoft-authored, publicly displayed summaries.
 * Never manufacture a summary from assistant text, tool progress or code. */
export interface PublicReasoningItem {
  id: string;
  type: "reasoning";
  status: "completed";
  summary: Array<{ type: "summary_text"; text: string }>;
}

export function requestsPublicReasoning(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const options = value as Record<string, unknown>;
  const mode = options.summary === undefined ? options.generate_summary : options.summary;
  return mode === "auto" || mode === "concise" || mode === "detailed";
}

/** Responses-route default: verified public summaries ride along unless the
 * client explicitly opted out with summary "none". Summaries only exist for
 * models with verified public delivery, so this stays a no-op elsewhere. */
export function publicReasoningWithDefault(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const options = value as Record<string, unknown>;
  const mode = options.summary === undefined ? options.generate_summary : options.summary;
  return mode !== "none";
}

export function appendPublicReasoning(
  output: unknown[],
  summaries: readonly string[] | undefined,
  requested: boolean,
): unknown[] {
  if (!requested || !summaries?.length) return output;
  let remaining = 16_384;
  const seen = new Set<string>();
  const summary: PublicReasoningItem["summary"] = [];
  for (const text of summaries) {
    if (summary.length >= 64) break;
    if (typeof text !== "string" || !text.trim() || seen.has(text) || text.length > remaining) continue;
    seen.add(text);
    remaining -= text.length;
    summary.push({ type: "summary_text", text });
  }
  if (!summary.length) return output;
  // Keep the business item at index 0: existing continuation aliases and tool
  // event indices must not shift when optional public metadata is present.
  return [...output, {
    id: `rs_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "reasoning", status: "completed", summary,
  } satisfies PublicReasoningItem];
}

export function publicReasoningEvents(output: unknown[]): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  output.forEach((raw, outputIndex) => {
    if (!raw || typeof raw !== "object" || (raw as { type?: string }).type !== "reasoning") return;
    const item = raw as PublicReasoningItem;
    events.push({ type: "response.output_item.added", output_index: outputIndex, item: { ...item, status: "in_progress", summary: [] } });
    item.summary.forEach((part, summaryIndex) => {
      const indices = { item_id: item.id, output_index: outputIndex, summary_index: summaryIndex };
      events.push({ type: "response.reasoning_summary_part.added", ...indices, part: { type: "summary_text", text: "" } });
      events.push({ type: "response.reasoning_summary_text.delta", ...indices, delta: part.text });
      events.push({ type: "response.reasoning_summary_text.done", ...indices, text: part.text });
      events.push({ type: "response.reasoning_summary_part.done", ...indices, part });
    });
    events.push({ type: "response.output_item.done", output_index: outputIndex, item });
  });
  return events;
}
