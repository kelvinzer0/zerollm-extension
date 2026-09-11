/**
 * ZeroLLM Content Script (Automated Web Tab Controller)
 * Handles finding input fields, typing user queries, clicking send/submitting,
 * detecting stream states via regex/selectors, observing mutations,
 * and converting live HTML responses to clean Markdown.
 */

// Simple in-script HTML to Markdown conversion (self-contained)
function cleanHtmlToMarkdown(elementOrHtml) {
  let doc;
  if (typeof elementOrHtml === "string") {
    const parser = new DOMParser();
    doc = parser.parseFromString(elementOrHtml, "text/html");
  } else if (elementOrHtml instanceof Element) {
    doc = elementOrHtml;
  } else {
    return String(elementOrHtml || "");
  }

  function walk(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const tag = node.tagName.toLowerCase();
    if (["script", "style", "noscript", "svg", "button", "iframe"].includes(tag)) return "";

    let inner = "";
    for (const child of node.childNodes) {
      inner += walk(child);
    }

    switch (tag) {
      case "h1": return `\n\n# ${inner.trim()}\n\n`;
      case "h2": return `\n\n## ${inner.trim()}\n\n`;
      case "h3": return `\n\n### ${inner.trim()}\n\n`;
      case "h4": return `\n\n#### ${inner.trim()}\n\n`;
      case "h5": return `\n\n##### ${inner.trim()}\n\n`;
      case "h6": return `\n\n###### ${inner.trim()}\n\n`;
      case "p": return `\n\n${inner.trim()}\n\n`;
      case "br": return "\n";
      case "strong":
      case "b": return `**${inner.trim()}**`;
      case "em":
      case "i": return `*${inner.trim()}*`;
      case "code":
        if (node.parentElement && node.parentElement.tagName.toLowerCase() === "pre") {
          return inner;
        }
        return `\`${inner}\``;
      case "pre": {
        const lang = node.getAttribute("data-language") || 
                     node.className.match(/language-([a-zA-Z0-9_-]+)/)?.[1] || "";
        return `\n\n\`\`\`${lang}\n${inner.trim()}\n\`\`\`\n\n`;
      }
      case "blockquote": return `\n\n> ${inner.trim().split("\n").join("\n> ")}\n\n`;
      case "ul": return `\n\n${inner.trim()}\n\n`;
      case "ol": return `\n\n${inner.trim()}\n\n`;
      case "li": return `* ${inner.trim()}\n`;
      case "a": return `[${inner.trim()}](${node.getAttribute("href") || "#"})`;
      case "hr": return "\n\n---\n\n";
      default: return inner;
    }
  }

  return walk(doc.body || doc).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Match a DOM element using CSS selector OR Regex test
 */
function findElementByPattern(selectorOrRegex) {
  if (!selectorOrRegex) return null;
  selectorOrRegex = selectorOrRegex.trim();

  // 1. Try direct CSS selector first
  try {
    const el = document.querySelector(selectorOrRegex);
    if (el) return el;
  } catch (e) {
    // Might be regex string or custom pattern
  }

  // 2. Check if formatted as regex /pattern/flags
  let regex = null;
  const match = selectorOrRegex.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    try { regex = new RegExp(match[1], match[2]); } catch (e) {}
  } else {
    // Plain string regex
    try { regex = new RegExp(selectorOrRegex, "i"); } catch (e) {}
  }

  if (regex) {
    // Search elements by ID, class name, placeholder, aria-label, or text
    const candidates = document.querySelectorAll("textarea, input, [contenteditable='true'], button, div, article");
    for (const c of candidates) {
      const textToTest = [
        c.id,
        c.className,
        c.getAttribute("placeholder") || "",
        c.getAttribute("aria-label") || "",
        c.getAttribute("data-testid") || ""
      ].join(" ");
      if (regex.test(textToTest)) return c;
    }
  }

  return null;
}

/**
 * Find all matching assistant response containers
 */
function getResponseContainers(config) {
  const selector = config.resultContainerSelector || config.doneSelector || ".markdown, article";
  try {
    const list = document.querySelectorAll(selector);
    if (list.length > 0) return Array.from(list);
  } catch (e) {}
  return [];
}

/**
 * Check if the page is currently streaming
 */
function checkIsStreaming(config) {
  if (!config.streamSelector) return false;
  const el = findElementByPattern(config.streamSelector);
  if (el) {
    // Check if element is visible
    return el.offsetParent !== null || window.getComputedStyle(el).display !== "none";
  }
  return false;
}

/**
 * Enter prompt text into input element
 */
async function enterPrompt(inputEl, text) {
  inputEl.focus();

  if (inputEl.isContentEditable) {
    inputEl.textContent = text;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  } else if ("value" in inputEl) {
    inputEl.value = text;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  await new Promise(r => setTimeout(r, 200));

  // Trigger Enter or find submit button
  const form = inputEl.closest("form");
  const submitBtn = form ? form.querySelector("button[type='submit']") : 
                   document.querySelector("button[data-testid='send-button'], button[aria-label*='Send']");

  if (submitBtn) {
    submitBtn.click();
  } else {
    inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    inputEl.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  }
}

/**
 * Execute completion in the current web page tab
 */
async function executeTabCompletion(requestId, modelConfig, query, streamMode) {
  console.log(`[ZeroLLM ContentScript] Executing query for model ${modelConfig.id}: "${query}"`);

  // 1. Find Chat Input Box
  const inputEl = findElementByPattern(modelConfig.continueChatSelector) || 
                  findElementByPattern(modelConfig.startChatSelector) ||
                  document.querySelector("textarea, [contenteditable='true']");

  if (!inputEl) {
    throw new Error(`Chat input area not found for model ${modelConfig.id}. Check selector: ${modelConfig.startChatSelector}`);
  }

  // Count existing assistant messages to target newly created response
  const prevContainers = getResponseContainers(modelConfig);
  const initialCount = prevContainers.length;

  // 2. Submit prompt
  await enterPrompt(inputEl, query);

  // 3. Monitor DOM response with MutationObserver & Polling
  return new Promise((resolve, reject) => {
    let lastMarkdown = "";
    let streamStarted = false;
    let streamEnded = false;
    let pollCount = 0;
    const maxPolls = 180; // 90 seconds timeout (500ms intervals)

    const interval = setInterval(() => {
      pollCount++;
      const currentContainers = getResponseContainers(modelConfig);
      
      // Target the latest response
      const latestResponseEl = currentContainers.length > initialCount ? 
                               currentContainers[currentContainers.length - 1] : 
                               currentContainers[currentContainers.length - 1];

      let rawHtml = "";
      if (latestResponseEl) {
        rawHtml = latestResponseEl.innerHTML;
      }

      const isStreaming = checkIsStreaming(modelConfig);
      const markdown = cleanHtmlToMarkdown(rawHtml || latestResponseEl || "");

      if (markdown && markdown !== lastMarkdown) {
        const delta = markdown.startsWith(lastMarkdown) ? 
                      markdown.slice(lastMarkdown.length) : 
                      markdown;
        
        lastMarkdown = markdown;
        streamStarted = true;

        if (streamMode && delta) {
          chrome.runtime.sendMessage({
            type: "stream",
            requestId,
            delta: { content: delta }
          });
        }
      }

      // Check if finished streaming:
      // Either isStreaming switched to false, or doneSelector is matched and content is settled
      if (streamStarted && !isStreaming && pollCount > 3) {
        clearInterval(interval);
        resolve(lastMarkdown);
        return;
      }

      // Safety timeout
      if (pollCount >= maxPolls) {
        clearInterval(interval);
        if (lastMarkdown) {
          resolve(lastMarkdown);
        } else {
          reject(new Error("Timeout waiting for AI response from page DOM"));
        }
      }
    }, 500);
  });
}

// Listen for messages from background.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ping") {
    sendResponse({ pong: true, url: window.location.href });
    return true;
  }

  if (msg.type === "executePrompt") {
    const { requestId, modelConfig, query, stream } = msg;

    executeTabCompletion(requestId, modelConfig, query, stream)
      .then(fullMarkdown => {
        chrome.runtime.sendMessage({
          type: "response",
          requestId,
          content: fullMarkdown,
          usage: {
            prompt_tokens: Math.ceil(query.length / 4),
            completion_tokens: Math.ceil(fullMarkdown.length / 4),
            total_tokens: Math.ceil((query.length + fullMarkdown.length) / 4)
          }
        });
      })
      .catch(err => {
        chrome.runtime.sendMessage({
          type: "streamError",
          requestId,
          error: err.message || "Failed to execute prompt on page"
        });
      });

    sendResponse({ accepted: true });
    return true;
  }
});
