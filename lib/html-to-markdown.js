/**
 * Turndown minimal clean HTML to Markdown converter
 * Lightweight, zero-dependency, works directly in Content Scripts and Browser extensions
 */

export function htmlToMarkdown(htmlOrElement) {
  let doc;
  if (typeof htmlOrElement === "string") {
    const parser = new DOMParser();
    doc = parser.parseFromString(htmlOrElement, "text/html");
  } else if (htmlOrElement instanceof Element) {
    doc = htmlOrElement;
  } else {
    return String(htmlOrElement || "");
  }

  function walk(node) {
    if (!node) return "";
    
    // Text node
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const tag = node.tagName.toLowerCase();

    // Ignore script, style, svg, buttons, etc.
    if (["script", "style", "noscript", "svg", "button"].includes(tag)) {
      return "";
    }

    let inner = "";
    for (const child of node.childNodes) {
      inner += walk(child);
    }

    switch (tag) {
      case "h1":
        return `\n\n# ${inner.trim()}\n\n`;
      case "h2":
        return `\n\n## ${inner.trim()}\n\n`;
      case "h3":
        return `\n\n### ${inner.trim()}\n\n`;
      case "h4":
        return `\n\n#### ${inner.trim()}\n\n`;
      case "h5":
        return `\n\n##### ${inner.trim()}\n\n`;
      case "h6":
        return `\n\n###### ${inner.trim()}\n\n`;
      case "p":
        return `\n\n${inner.trim()}\n\n`;
      case "br":
        return "\n";
      case "strong":
      case "b":
        return `**${inner.trim()}**`;
      case "em":
      case "i":
        return `*${inner.trim()}*`;
      case "code":
        // Check if inside pre
        if (node.parentElement && node.parentElement.tagName.toLowerCase() === "pre") {
          return inner;
        }
        return `\`${inner}\``;
      case "pre": {
        const lang = node.getAttribute("data-language") || 
                     node.className.match(/language-([a-zA-Z0-9_-]+)/)?.[1] || "";
        return `\n\n\`\`\`${lang}\n${inner.trim()}\n\`\`\`\n\n`;
      }
      case "blockquote":
        return `\n\n> ${inner.trim().split("\n").join("\n> ")}\n\n`;
      case "ul":
        return `\n\n${inner.trim()}\n\n`;
      case "ol":
        return `\n\n${inner.trim()}\n\n`;
      case "li": {
        const parent = node.parentElement;
        const isOl = parent && parent.tagName.toLowerCase() === "ol";
        const index = isOl ? Array.from(parent.children).indexOf(node) + 1 : null;
        const prefix = isOl ? `${index}. ` : "* ";
        return `${prefix}${inner.trim()}\n`;
      }
      case "a": {
        const href = node.getAttribute("href") || "#";
        return `[${inner.trim()}](${href})`;
      }
      case "hr":
        return "\n\n---\n\n";
      case "table":
        return `\n\n${formatTable(node)}\n\n`;
      default:
        return inner;
    }
  }

  function formatTable(tableNode) {
    const rows = Array.from(tableNode.querySelectorAll("tr"));
    if (rows.length === 0) return "";
    
    let md = "";
    rows.forEach((row, rowIndex) => {
      const cells = Array.from(row.querySelectorAll("th, td"));
      const cellTexts = cells.map(c => walk(c).trim().replace(/\n/g, " "));
      md += `| ${cellTexts.join(" | ")} |\n`;
      if (rowIndex === 0) {
        md += `| ${cells.map(() => "---").join(" | ")} |\n`;
      }
    });
    return md;
  }

  let result = walk(doc.body || doc);
  // Clean up excess newlines
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}
