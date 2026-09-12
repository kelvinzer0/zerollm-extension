/**
 * ZeroLLM Content Script (Automated Web Tab Controller)
 * Handles finding input fields, typing user queries, clicking send/submitting,
 * detecting stream states via regex/selectors, observing mutations,
 * and converting live HTML responses to clean Markdown.
 */

// Simple in-script HTML to Markdown conversion (self-contained)
function cleanHtmlToMarkdown(elementOrHtml) {
  if (!elementOrHtml) return "";

  let doc;
  if (typeof elementOrHtml === "string") {
    const parser = new DOMParser();
    doc = parser.parseFromString(elementOrHtml, "text/html");
  } else if (elementOrHtml instanceof Element) {
    doc = elementOrHtml;
  } else {
    return String(elementOrHtml || "").trim();
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
        const trimmedInner = inner.trim();
        if (!trimmedInner) return "";
        const lang = node.getAttribute("data-language") || 
                     node.className.match(/language-([a-zA-Z0-9_-]+)/)?.[1] || "";
        return `\n\n\`\`\`${lang}\n${trimmedInner}\n\`\`\`\n\n`;
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

  const parsed = walk(doc.body || doc)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!parsed && (elementOrHtml instanceof Element || (doc && doc.body))) {
    const rawText = ((doc.body || elementOrHtml).innerText || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim();
    if (isThinkingOnly(rawText)) {
      return "";
    }
    return rawText;
  }
  return parsed;
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
  } catch (e) {}

  // 2. Check if formatted as regex /pattern/flags
  let regex = null;
  const match = selectorOrRegex.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    try { regex = new RegExp(match[1], match[2]); } catch (e) {}
  } else {
    try { regex = new RegExp(selectorOrRegex, "i"); } catch (e) {}
  }

  if (regex) {
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
function getResponseContainers(modelConfig) {
  const selectors = [
    modelConfig.resultContainerSelector,
    "div[data-message-author-role='assistant']",
    ".agent-turn [data-message-author-role='assistant']",
    "[data-message-author-role='assistant'] .markdown",
    "[data-message-author-role='assistant']",
    "[class*='assistantMessage'] [class*='messageCopy']",
    "[class*='assistantMessage']",
    ".markdown",
    "article",
    ".message-ai",
    ".chat-bubble-bot",
    "message-content"
  ].filter(Boolean);

  for (const sel of selectors) {
    try {
      const list = document.querySelectorAll(sel);
      if (list.length > 0) return Array.from(list);
    } catch (e) {}
  }
  return [];
}

function checkIsDone(modelConfig) {
  if (!modelConfig.doneSelector) return false;
  const el = findElementByPattern(modelConfig.doneSelector);
  if (el) {
    const isVisible = el.offsetParent !== null || window.getComputedStyle(el).display !== "none";
    const isEnabled = !el.disabled && !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true";
    return isVisible && isEnabled;
  }
  return false;
}

function isThinkingOnly(text) {
  if (!text) return false;
  const cleaned = text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim().toLowerCase();
  return /^(thinking(\.{0,3}|…)?|menalar(\.{0,3}|…)?|sedang berpikir(\.{0,3}|…)?|berhenti berpikir|stop thinking|berpikir(\.{0,3}|…)?|(?:berpikir|menalar)\s+selama\s+.*|thought\s+for\s+.*)$/i.test(cleaned);
}

function cleanResultMarkdown(markdown) {
  if (!markdown) return "";
  let cleaned = markdown
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/^(?:#+\s*)?(?:Thinking|Menalar|Sedang berpikir|Berhenti berpikir|Stop thinking)(?:\.{0,3}|…)?\s*\n+/gi, "")
    .replace(/^(?:Berhenti berpikir|Stop thinking)\s*\n+/gi, "")
    .replace(/^(?:Berpikir|Menalar)\s+selama\s+[^\n]+\n+/gi, "")
    .replace(/^(?:Thought for\s+[^\n]+)\n+/gi, "");
  return cleaned.trim() || markdown.trim();
}

/**
 * Check if the page is currently streaming
 */
function checkIsStreaming(modelConfig) {
  if (modelConfig.streamSelector) {
    const el = findElementByPattern(modelConfig.streamSelector);
    if (el && (el.offsetParent !== null || window.getComputedStyle(el).display !== "none")) {
      return true;
    }
  }
  const genericStream = document.querySelector(".streaming, [data-is-streaming='true'], .typing-indicator");
  if (genericStream && (genericStream.offsetParent !== null || window.getComputedStyle(genericStream).display !== "none")) {
    return true;
  }
  return false;
}

/**
 * Enter prompt text into input element using native DOM setters and input events
 * Handles React/Vue/ProseMirror input state listeners
 */
async function enterPrompt(inputEl, text) {
  inputEl.focus();

  if (inputEl.isContentEditable) {
    // ContentEditable (ChatGPT ProseMirror / Lexical)
    inputEl.focus();
    // Select all existing content
    document.execCommand("selectAll", false, null);
    // Insert text so React synthetic events update properly
    const success = document.execCommand("insertText", false, text);
    if (!success) {
      inputEl.innerHTML = `<p>${text}</p>`;
    }
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // Standard Textarea / Input with native value setter
    const nativeSetter = Object.getOwnPropertyDescriptor(
      inputEl instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
      "value"
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(inputEl, text);
    } else {
      inputEl.value = text;
    }
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  await new Promise(r => setTimeout(r, 400));

  // Dismiss any blocking dialogs/overlays if present (e.g. login prompts, welcome modals)
  const dismissBtn = document.querySelector("button[aria-label='Tutup'], button[aria-label='Close'], button[aria-label='Kembali ke ChatGPT'], button:has(svg path[d*='M18 6L6 18'])");
  if (dismissBtn) {
    try { dismissBtn.click(); } catch(e) {}
    await new Promise(r => setTimeout(r, 300));
  }

  // Find and click submit button
  const form = inputEl.closest("form");
  const submitBtn = (form ? form.querySelector("button[type='submit']") : null) || 
                   document.querySelector("button[data-testid='send-button'], button[data-testid='fruitjuice-send-button'], button[aria-label*='Send'], button[aria-label*='Kirim'], button[aria-label*='prompt']");

  if (submitBtn && !submitBtn.disabled) {
    submitBtn.click();
  } else {
    // Keyboard Enter fallback with full event pipeline
    const enterOpts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    inputEl.dispatchEvent(new KeyboardEvent("keydown", enterOpts));
    inputEl.dispatchEvent(new KeyboardEvent("keypress", enterOpts));
    inputEl.dispatchEvent(new KeyboardEvent("keyup", enterOpts));
  }
}

/**
 * Trigger Send Button click or Keyboard Enter on input box
 */
function triggerSendOrEnter(modelConfig) {
  // 1. Cari submit button dengan selector paling lengkap
  let submitBtn = null;
  if (modelConfig?.doneSelector) {
    submitBtn = findElementByPattern(modelConfig.doneSelector);
  }
  if (!submitBtn) {
    submitBtn = document.querySelector(
      "button[data-testid='send-button']:not([disabled]), " +
      "button[data-testid='fruitjuice-send-button']:not([disabled]), " +
      "button.wm-composer-submitButton:not([disabled]), " +
      "button[aria-label*='Kirim']:not([disabled]), " +
      "button[aria-label*='Send']:not([disabled]), " +
      "form button[type='submit']:not([disabled]), " +
      ".send-button:not([disabled])"
    );
  }

  if (submitBtn && !submitBtn.disabled && submitBtn.getAttribute("aria-disabled") !== "true") {
    // Multi-event mouse dispatch agar React dan pointer capture mendeteksi klik asli
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(type => {
      submitBtn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    try { submitBtn.click(); } catch(e) {}
    console.log("[ZeroLLM ContentScript] Clicked submit button successfully");
    return true;
  }

  // 2. Jika tombol send tidak terdeteksi atau disabled: picu Enter keyboard event langsung ke input/textarea
  let inputEl = findElementByPattern(modelConfig?.continueChatSelector) || 
                findElementByPattern(modelConfig?.startChatSelector) ||
                document.querySelector("#prompt-textarea, textarea, [contenteditable='true']");

  if (inputEl) {
    inputEl.focus();
    ["keydown", "keypress", "keyup"].forEach(type => {
      inputEl.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        charCode: type === "keypress" ? 13 : 0,
        bubbles: true,
        cancelable: true,
        composed: true,
        shiftKey: false
      }));
    });
    console.log("[ZeroLLM ContentScript] Dispatched Enter keyboard event to input element");
    return true;
  }

  return false;
}

/**
 * Observe live AI response stream in the DOM until completion
 */
function observeCompletion(requestId, modelConfig, query, streamMode, initialCount = 0, initialText = "") {
  return new Promise((resolve, reject) => {
    let lastMarkdown = "";
    let streamStarted = false;
    let stableCount = 0;
    let pollCount = 0;
    const maxPolls = 180; // 90 seconds max

    const interval = setInterval(() => {
      pollCount++;
      const currentContainers = getResponseContainers(modelConfig);
      
      const hasNewContainer = currentContainers.length > initialCount;
      const latestResponseEl = currentContainers.length > 0 ? currentContainers[currentContainers.length - 1] : null;

      const rawHtml = latestResponseEl ? latestResponseEl.innerHTML : "";
      const isStreaming = checkIsStreaming(modelConfig);
      const markdown = cleanHtmlToMarkdown(rawHtml || latestResponseEl || "");
      const meaningfulMarkdown = cleanResultMarkdown(markdown);
      const thinkingOnly = isThinkingOnly(markdown) || isThinkingOnly(meaningfulMarkdown);

      // Cek apakah konten ini teks baru dari generasi saat ini
      const isDifferentFromInitial = !initialText || meaningfulMarkdown !== initialText;
      const hasMeaningfulText = meaningfulMarkdown.replace(/[`\s]/g, "").length > 0;

      if (hasMeaningfulText && !thinkingOnly && (hasNewContainer || isDifferentFromInitial || isStreaming)) {
        if (meaningfulMarkdown !== lastMarkdown) {
          const delta = meaningfulMarkdown.startsWith(lastMarkdown) ? 
                        meaningfulMarkdown.slice(lastMarkdown.length) : 
                        meaningfulMarkdown;
          
          lastMarkdown = meaningfulMarkdown;
          streamStarted = true;
          stableCount = 0;

          if (streamMode && delta) {
            chrome.runtime.sendMessage({
              type: "stream",
              requestId,
              delta: { content: delta }
            });
          }
        } else {
          stableCount++;
        }
      } else {
        stableCount = 0;
      }

      // Selesai jika:
      // 1. Teks baru terdeteksi (streamStarted)
      // 2. Tidak lagi dalam status streaming (!isStreaming)
      // 3. Teks stabil minimal 2 putaran polling (1 detik)
      if (streamStarted && hasMeaningfulText && !thinkingOnly && !isStreaming && stableCount >= 2 && pollCount >= 2) {
        clearInterval(interval);
        resolve(cleanResultMarkdown(lastMarkdown));
        return;
      }

      // Safety timeout
      if (pollCount >= maxPolls) {
        clearInterval(interval);
        if (lastMarkdown && hasMeaningfulText && !thinkingOnly) {
          resolve(cleanResultMarkdown(lastMarkdown));
        } else {
          reject(new Error("Timeout waiting for AI response from page DOM"));
        }
      }
    }, 500);
  });
}

/**
 * Execute completion in the current web page tab (Legacy / Fallback DOM Mode)
 */
async function executeTabCompletion(requestId, modelConfig, query, streamMode) {
  console.log(`[ZeroLLM ContentScript] Executing query for model ${modelConfig.id}: "${query}"`);

  // 1. Find Chat Input Box (dengan retry untuk menunggu hidrasi SPA React/Vue)
  let inputEl = findElementByPattern(modelConfig.continueChatSelector) || 
                findElementByPattern(modelConfig.startChatSelector) ||
                document.querySelector("#prompt-textarea, #mobile-composer-prompt, textarea, [contenteditable='true']");

  if (!inputEl) {
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 500));
      inputEl = findElementByPattern(modelConfig.continueChatSelector) || 
                findElementByPattern(modelConfig.startChatSelector) ||
                document.querySelector("#prompt-textarea, #mobile-composer-prompt, textarea, [contenteditable='true']");
      if (inputEl) break;
    }
  }

  if (!inputEl) {
    throw new Error(`Chat input area not found for model ${modelConfig.id}. Please ensure the chat page is loaded.`);
  }

  // Count existing assistant messages to target newly created response
  const prevContainers = getResponseContainers(modelConfig);
  const initialCount = prevContainers.length;
  const lastEl = prevContainers.length > 0 ? prevContainers[prevContainers.length - 1] : null;
  const initialText = lastEl ? cleanResultMarkdown(cleanHtmlToMarkdown(lastEl.innerHTML || lastEl)) : "";

  // 2. Submit prompt
  await enterPrompt(inputEl, query);

  // 3. Monitor DOM response with Polling
  return observeCompletion(requestId, modelConfig, query, streamMode, initialCount, initialText);
}

// Listen for messages from background.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ping") {
    sendResponse({ pong: true, url: window.location.href });
    return true;
  }

  // Prepare input element and focus before Chrome Debugger CDP typing
  if (msg.type === "focusInput") {
    // 1. Tutup modal/banner promosi atau dialog error yang menghalangi
    const dismissBtns = document.querySelectorAll("button[aria-label='Tutup'], button[aria-label='Close'], button[aria-label='Kembali ke ChatGPT'], button:has(svg path[d*='M18 6L6 18'])");
    dismissBtns.forEach(btn => { try { btn.click(); } catch(e) {} });

    let inputEl = findElementByPattern(msg.modelConfig?.continueChatSelector) || 
                  findElementByPattern(msg.modelConfig?.startChatSelector) ||
                  document.querySelector("#prompt-textarea, #mobile-composer-prompt, textarea, [contenteditable='true']");

    // 2. Jika input tidak ditemukan, form disabled, atau chat macet: klik tombol Obrolan Baru
    if (msg.forceNewChat || !inputEl || inputEl.disabled || inputEl.getAttribute("aria-disabled") === "true") {
      const newChatSel = msg.modelConfig?.newChatSelector || "a[href='/'], [data-testid='new-chat-button'], [aria-label*='Obrolan baru'], [aria-label*='New chat'], [aria-label*='Percakapan baru']";
      const newChatBtn = findElementByPattern(newChatSel);
      if (newChatBtn) {
        try { newChatBtn.click(); } catch(e) {}
      } else if (window.location.pathname.startsWith("/c/")) {
        window.location.href = "/";
      }

      setTimeout(() => {
        let freshInput = findElementByPattern(msg.modelConfig?.startChatSelector) ||
                         document.querySelector("#prompt-textarea, #mobile-composer-prompt, textarea, [contenteditable='true']");
        if (freshInput) {
          freshInput.focus();
          const prevContainers = getResponseContainers(msg.modelConfig);
          const lastEl = prevContainers.length > 0 ? prevContainers[prevContainers.length - 1] : null;
          const initialText = lastEl ? cleanResultMarkdown(cleanHtmlToMarkdown(lastEl.innerHTML || lastEl)) : "";
          sendResponse({ success: true, initialCount: prevContainers.length, initialText });
        } else {
          sendResponse({ success: false, error: "Input not found after New Chat" });
        }
      }, 600);
      return true;
    }

    if (inputEl) {
      inputEl.focus();
      // Bersihkan teks lama sebelum pengetikan teks baru agar tidak bertumpuk
      if (inputEl.isContentEditable) {
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
      } else {
        inputEl.value = "";
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const prevContainers = getResponseContainers(msg.modelConfig);
      const lastEl = prevContainers.length > 0 ? prevContainers[prevContainers.length - 1] : null;
      const initialText = lastEl ? cleanResultMarkdown(cleanHtmlToMarkdown(lastEl.innerHTML || lastEl)) : "";
      sendResponse({ success: true, initialCount: prevContainers.length, initialText });
    } else {
      sendResponse({ success: false, error: "Input not found" });
    }
    return true;
  }

  // Klik tombol kirim atau picu Enter keyboard jika masih aktif setelah penekanan Enter via CDP
  if (msg.type === "clickSubmitIfActive") {
    triggerSendOrEnter(msg.modelConfig);
    sendResponse({ ok: true });
    return true;
  }

  // Wait for AI response (used after Chrome Debugger native CDP typing)
  if (msg.type === "waitForResponse") {
    const { requestId, modelConfig, query, stream, initialCount, initialText } = msg;

    observeCompletion(requestId, modelConfig, query, stream, initialCount || 0, initialText || "")
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
          error: err.message || "Failed to observe AI response from page"
        });
      });

    sendResponse({ accepted: true });
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
