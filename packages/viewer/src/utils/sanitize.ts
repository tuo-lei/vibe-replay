/**
 * Lightweight HTML sanitizer using the browser's DOMParser.
 * Strips <script>, <iframe>, <object>, <embed>, <style> tags
 * and all on* event handler attributes.
 * Zero dependencies — relies only on browser APIs.
 */

const DANGEROUS_TAGS = new Set(["script", "iframe", "object", "embed", "style", "link", "meta"]);

export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  sanitizeNode(doc.body);
  return doc.body.innerHTML;
}

export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  // If parsing failed, DOMParser returns an error document
  if (root.tagName === "parsererror" || root.querySelector("parsererror")) {
    return "";
  }
  sanitizeNode(root);
  return new XMLSerializer().serializeToString(root);
}

function sanitizeNode(node: Node): void {
  const toRemove: Node[] = [];

  for (const child of node.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const tag = el.tagName.toLowerCase();

      if (DANGEROUS_TAGS.has(tag)) {
        toRemove.push(child);
        continue;
      }

      // Strip event handler attributes (on*)
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.toLowerCase().startsWith("on")) {
          el.removeAttribute(attr.name);
        }
        // Strip javascript: URLs
        const val = attr.value.trim().toLowerCase();
        if (val.startsWith("javascript:") || val.startsWith("data:text/html")) {
          el.removeAttribute(attr.name);
        }
      }

      sanitizeNode(child);
    }
  }

  for (const child of toRemove) {
    node.removeChild(child);
  }
}
