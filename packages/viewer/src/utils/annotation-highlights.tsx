import type { ReactNode } from "react";
import type { Annotation } from "../types";

export interface TextHighlight {
  id: string;
  text: string;
  title: string;
  start?: number;
  end?: number;
}

interface HighlightRange {
  start: number;
  end: number;
  highlight: TextHighlight;
}

const HIGHLIGHT_CLASS =
  "rounded bg-terminal-blue/20 text-terminal-text ring-1 ring-terminal-blue/40 cursor-pointer hover:bg-terminal-blue/30 transition-colors";

export function textHighlightsByScene(annotations: Annotation[]): Map<number, TextHighlight[]> {
  const byScene = new Map<number, TextHighlight[]>();
  annotations
    .filter((annotation) => annotation.selectedText?.trim())
    .forEach((annotation) => {
      const highlights = byScene.get(annotation.sceneIndex) ?? [];
      highlights.push({
        id: annotation.id,
        text: annotation.selectedText!.trim(),
        title: annotation.body,
        start: annotation.selectedTextStart,
        end: annotation.selectedTextEnd,
      });
      byScene.set(annotation.sceneIndex, highlights);
    });
  return byScene;
}

export function textHighlightsForScene(
  annotations: Annotation[],
  sceneIndex: number,
): TextHighlight[] {
  return textHighlightsByScene(annotations).get(sceneIndex) ?? [];
}

function findHighlightRanges(
  content: string,
  highlights: TextHighlight[],
  useStoredRanges = true,
): HighlightRange[] {
  const ranges: HighlightRange[] = [];

  for (const highlight of highlights) {
    if (!highlight.text) continue;
    const start =
      useStoredRanges &&
      Number.isInteger(highlight.start) &&
      Number.isInteger(highlight.end) &&
      highlight.start! >= 0 &&
      highlight.end! > highlight.start! &&
      highlight.end! <= content.length &&
      content.slice(highlight.start, highlight.end) === highlight.text
        ? highlight.start!
        : content.indexOf(highlight.text);
    if (start < 0) continue;
    const end = start + highlight.text.length;

    // Keep the renderer predictable: skip overlapping matches instead of
    // trying to nest marks in replay text.
    const overlaps = ranges.some((range) => start < range.end && end > range.start);
    if (overlaps) continue;

    ranges.push({ start, end, highlight });
  }

  return ranges.sort((a, b) => a.start - b.start);
}

export function hasVisibleTextHighlights(content: string, highlights: TextHighlight[]): boolean {
  return findHighlightRanges(content, highlights).length > 0;
}

export function hasHtmlTextHighlights(html: string, highlights: TextHighlight[]): boolean {
  if (typeof DOMParser === "undefined") return false;
  const doc = new DOMParser().parseFromString(html, "text/html");
  return findHighlightRanges(doc.body.textContent ?? "", highlights, false).length > 0;
}

export function renderHighlightedPlainText(
  content: string,
  highlights: TextHighlight[],
  onHighlightClick?: (annotationId: string) => void,
): ReactNode {
  const ranges = findHighlightRanges(content, highlights);
  if (ranges.length === 0) return content;

  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range) => {
    if (range.start > cursor) nodes.push(content.slice(cursor, range.start));
    nodes.push(
      <mark
        key={range.highlight.id}
        data-vibe-annotation-id={range.highlight.id}
        title={range.highlight.title}
        className={HIGHLIGHT_CLASS}
        onClick={(event) => {
          event.stopPropagation();
          onHighlightClick?.(range.highlight.id);
        }}
      >
        {content.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

function markMarkdownHighlight(text: string, highlight: TextHighlight): string {
  // This HTML is rendered by marked and then sanitized; attributes are escaped
  // here so annotation body text cannot break out before the sanitizer runs.
  return `<mark data-vibe-annotation-id="${escapeHtmlAttribute(
    highlight.id,
  )}" title="${escapeHtmlAttribute(highlight.title)}" class="${HIGHLIGHT_CLASS}">${text}</mark>`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function createHighlightMark(doc: Document, highlight: TextHighlight, text: string): HTMLElement {
  const mark = doc.createElement("mark");
  mark.dataset.vibeAnnotationId = highlight.id;
  mark.title = highlight.title;
  mark.className = HIGHLIGHT_CLASS;
  mark.textContent = text;
  return mark;
}

export function injectHtmlTextHighlights(html: string, highlights: TextHighlight[]): string {
  if (typeof DOMParser === "undefined") return html;

  const doc = new DOMParser().parseFromString(html, "text/html");
  const textNodes: { node: Text; start: number; end: number }[] = [];
  let text = "";

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text;
      const value = textNode.nodeValue ?? "";
      const start = text.length;
      text += value;
      textNodes.push({ node: textNode, start, end: text.length });
      return;
    }

    node.childNodes.forEach(visit);
  };

  visit(doc.body);

  const ranges = findHighlightRanges(text, highlights, false);
  if (ranges.length === 0) return html;

  textNodes.toReversed().forEach((entry) => {
    if (!entry.node.parentNode) return;
    const nodeText = entry.node.nodeValue ?? "";
    const nodeRanges = ranges
      .map((range) => ({
        start: Math.max(range.start, entry.start),
        end: Math.min(range.end, entry.end),
        highlight: range.highlight,
      }))
      .filter((range) => range.start < range.end)
      .sort((a, b) => a.start - b.start);
    if (nodeRanges.length === 0) return;

    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    nodeRanges.forEach((range) => {
      const localStart = range.start - entry.start;
      const localEnd = range.end - entry.start;

      if (localStart > cursor)
        fragment.appendChild(doc.createTextNode(nodeText.slice(cursor, localStart)));
      fragment.appendChild(
        createHighlightMark(doc, range.highlight, nodeText.slice(localStart, localEnd)),
      );
      cursor = localEnd;
    });
    if (cursor < nodeText.length) fragment.appendChild(doc.createTextNode(nodeText.slice(cursor)));
    entry.node.parentNode.replaceChild(fragment, entry.node);
  });

  return doc.body.innerHTML;
}

export function injectMarkdownHighlights(content: string, highlights: TextHighlight[]): string {
  const ranges = findHighlightRanges(content, highlights);
  if (ranges.length === 0) return content;

  let output = "";
  let cursor = 0;
  ranges.forEach((range) => {
    output += content.slice(cursor, range.start);
    output += markMarkdownHighlight(content.slice(range.start, range.end), range.highlight);
    cursor = range.end;
  });
  output += content.slice(cursor);
  return output;
}

export function handleMarkdownHighlightClick(
  event: React.MouseEvent,
  onHighlightClick?: (annotationId: string) => void,
): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const mark = target.closest("[data-vibe-annotation-id]");
  if (!(mark instanceof HTMLElement)) return;
  const annotationId = mark.dataset.vibeAnnotationId;
  if (!annotationId) return;
  event.stopPropagation();
  onHighlightClick?.(annotationId);
}
