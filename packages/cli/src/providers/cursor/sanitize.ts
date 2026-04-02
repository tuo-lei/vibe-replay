function internalPlanningHeadingBreakRe(): RegExp {
  return /\n{2,}\*\*([^*\n]{3,120})\*\*\n{2,}/g;
}

function leadingInternalPlanningHeadingRe(): RegExp {
  return /^\*\*([^*\n]{3,120})\*\*\n{2,}([\s\S]*)$/;
}

export function hasInternalPlanningHeading(text: string): boolean {
  for (const heading of extractInternalPlanningHeadings(text)) {
    if (looksLikeInternalPlanningHeading(heading)) return true;
  }
  return false;
}

export function sanitizeCursorAssistantText(value: string, hasToolContext: boolean): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!hasToolContext && !hasInternalPlanningHeading(trimmed)) return trimmed;
  return trimInternalPlanningTail(trimmed);
}

export function sanitizeCursorReasoningText(value: string): string {
  return trimInternalPlanningTail(value);
}

export function trimInternalPlanningTail(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const headingBreak = internalPlanningHeadingBreakRe();
  let match: RegExpExecArray | null;
  while ((match = headingBreak.exec(trimmed)) !== null) {
    const heading = match[1] || "";
    if (!looksLikeInternalPlanningHeading(heading)) continue;
    const tail = trimmed.slice(match.index + match[0].length).trim();
    if (!looksLikeInternalPlanningBody(tail)) continue;
    return trimmed.slice(0, match.index).trim();
  }

  const leadingHeading = trimmed.match(leadingInternalPlanningHeadingRe());
  if (leadingHeading) {
    const [, heading = "", body = ""] = leadingHeading;
    if (looksLikeInternalPlanningHeading(heading) && looksLikeInternalPlanningBody(body)) {
      return "";
    }
  }

  return trimmed;
}

function extractInternalPlanningHeadings(text: string): string[] {
  const headings: string[] = [];
  const headingBreak = internalPlanningHeadingBreakRe();
  let match: RegExpExecArray | null;
  while ((match = headingBreak.exec(text)) !== null) {
    if (match[1]) headings.push(match[1]);
  }
  return headings;
}

function looksLikeInternalPlanningHeading(heading: string): boolean {
  const normalized = heading.trim().toLowerCase();
  return /^(?:planning(?: next steps)?|internal(?: only)?|waiting(?: for .+)?|exploring(?: .+)?|investigating(?: .+)?|checking(?: .+)?|thinking(?: .+)?|next steps|working notes|scratchpad)$/.test(
    normalized,
  );
}

function looksLikeInternalPlanningBody(text: string): boolean {
  const probe = text.slice(0, 500).replace(/\s+/g, " ").trim();
  if (!probe) return false;
  return /\b(?:I need|I think|I should|I might|I could|I'm|I am|I'll|I will|let's|we need to|we should)\b/i.test(
    probe,
  );
}
