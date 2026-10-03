import { formatAttachedImageMention } from "./media.js";

/**
 * Mac client replicas and some JSONL sends carry a typed UI payload
 * (`widget`, `cursor-agent`, `attachment`, `connector`, `auto-review-approval`)
 * instead of `{ text: { content } }`. Turn those into one readable reply.
 * `type: "text"` returns undefined so the existing content walker still runs.
 */
export function formatGrokBotRichSendMessage(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type.trim().toLowerCase() : "";
  if (!type || type === "text") return undefined;

  if (type === "widget") return formatWidget(obj.widget ?? obj);
  if (type === "cursor-agent") {
    const title = firstString(obj.title, obj.name) || "untitled";
    return `[cloud agent: ${title}]`;
  }
  if (type === "attachment") return formatAttachment(obj);
  if (type === "connector") {
    const name = firstString(obj.connector, obj.serverId, obj.server) || "connector";
    const variant = firstString(obj.variant);
    return variant ? `[connector: ${name} (${variant})]` : `[connector: ${name}]`;
  }
  if (type === "auto-review-approval") return formatApproval(obj.approval ?? obj);
  return undefined;
}

function formatWidget(widget: unknown): string | undefined {
  if (!widget || typeof widget !== "object" || Array.isArray(widget)) return undefined;
  const obj = widget as Record<string, unknown>;
  const prompt = firstString(obj.prompt, obj.helpText, obj.title);
  const labels = Array.isArray(obj.options)
    ? obj.options
        .map((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) return "";
          return firstString(
            (option as Record<string, unknown>).label,
            (option as Record<string, unknown>).value,
          );
        })
        .filter((label): label is string => !!label)
    : [];
  const options = labels.length > 0 ? labels.join(" / ") : "";
  if (prompt && options) return `${prompt}\n${options}`;
  return prompt || options || undefined;
}

function formatAttachment(obj: Record<string, unknown>): string {
  const name = firstString(obj.file_name, obj.fileName, obj.name, obj.title) || "file";
  const url = firstString(obj.url, obj.path, obj.file_path, obj.filePath);
  if (!url) return `[attachment: ${name}]`;
  const clean = url.split("?")[0]?.split("#")[0] || url;
  return formatAttachedImageMention(name, clean);
}

function formatApproval(approval: unknown): string {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    return "[auto-review]";
  }
  const obj = approval as Record<string, unknown>;
  const summary = firstString(obj.summary, obj.reason, obj.proposedRule, obj.status) || "approval";
  const status = firstString(obj.status);
  if (status && status !== summary) return `[auto-review: ${summary} (${status})]`;
  return `[auto-review: ${summary}]`;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
