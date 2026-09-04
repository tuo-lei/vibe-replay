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

export function sanitizeCursorUserText(value: string): string {
  // Cursor prepends a `<timestamp>...</timestamp>` metadata wrapper before the
  // user prompt body. Scope the strip to the leading position so that prompts
  // legitimately containing `<timestamp>` markup elsewhere (e.g. discussing
  // XML/HTML samples) are preserved verbatim.
  return value
    .replace(/^\s*<timestamp>[\s\S]*?<\/timestamp>\s*/i, "")
    .replace(/<\/?user_query>/g, "")
    .trim();
}

/** Cursor uses these names for sessions without a meaningful title. */
export function isCursorPlaceholderTitle(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^(?:new agent|new chat|untitled)$/i.test(value.replace(/\s+/g, " ").trim())
  );
}

/** Read Cursor's leading human-readable prompt timestamp and normalize it to ISO. */
export function extractCursorTimestamp(value: string): string | undefined {
  const match = /^\s*<timestamp>([^<]*?)<\/timestamp>/i.exec(value);
  if (!match?.[1]) return undefined;
  const rawTimestamp = match[1].trim();
  const timestampMs =
    parseCursorTimestamp(rawTimestamp) ??
    (/^(?:[A-Za-z]+,\s+)?[A-Za-z]+\s+\d{1,2},\s+\d{4},/i.test(rawTimestamp)
      ? undefined
      : Date.parse(rawTimestamp));
  return timestampMs !== undefined && Number.isFinite(timestampMs)
    ? new Date(timestampMs).toISOString()
    : undefined;
}

function parseCursorTimestamp(value: string): number | undefined {
  const match =
    /^(?:[A-Za-z]+,\s+)?([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)\s+\(UTC([+-]\d{1,2})(?::?(\d{2}))?\)$/i.exec(
      value.trim(),
    );
  if (!match) return undefined;

  const [
    ,
    monthName,
    dayText,
    yearText,
    hourText,
    minuteText,
    secondText,
    meridiem,
    offsetText,
    offsetMinuteText,
  ] = match;
  const month = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ].indexOf(monthName.toLowerCase().slice(0, 3));
  const day = Number(dayText);
  const year = Number(yearText);
  const minute = Number(minuteText);
  const second = secondText ? Number(secondText) : 0;
  let hour = Number(hourText);
  if (month < 0 || day < 1 || year < 1 || hour < 1 || hour > 12 || minute > 59 || second > 59) {
    return undefined;
  }
  if (meridiem.toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (meridiem.toLowerCase() === "am" && hour === 12) hour = 0;

  const localMs = Date.UTC(year, month, day, hour, minute, second);
  const localDate = new Date(localMs);
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second
  ) {
    return undefined;
  }

  const offsetHours = Number(offsetText);
  const offsetMinutes = offsetMinuteText ? Number(offsetMinuteText) : 0;
  if (
    !Number.isFinite(offsetHours) ||
    Math.abs(offsetHours) > 23 ||
    offsetMinutes < 0 ||
    offsetMinutes > 59
  ) {
    return undefined;
  }
  const signedOffsetMinutes =
    (offsetText.startsWith("-") ? -1 : 1) * (Math.abs(offsetHours) * 60 + offsetMinutes);
  return localMs - signedOffsetMinutes * 60_000;
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
