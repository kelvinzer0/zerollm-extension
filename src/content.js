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
    const role = node.getAttribute ? node.getAttribute("role") : null;
    if (role === "button" && !inner.trim()) return "";

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
    const target = (doc && doc.body) ? doc.body : elementOrHtml;
    try {
      // Clone element agar tidak merusak live DOM dan bersihkan elemen UI tombol
      const clone = target.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, svg, button, [role='button'], .copy-btn, .action-btn").forEach(el => el.remove());
      const rawText = (clone.innerText || clone.textContent || "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim();
      if (!isThinkingOnly(rawText)) {
        return rawText;
      }
    } catch(e) {
      const rawText = (target.innerText || "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim();
      if (!isThinkingOnly(rawText)) {
        return rawText;
      }
    }
    return "";
  }
  return parsed;
}

/**
 * Resolve the chat area scope root element from modelConfig.responseScope
 * All response detection will be constrained within this element.
 * Falls back to document.body if no scope matches.
 */
function getScopeRoot(modelConfig) {
  if (modelConfig?.responseScope) {
    const selectors = modelConfig.responseScope.split(",").map(s => s.trim()).filter(Boolean);
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.querySelector("*")) return el; // Must have children (not empty)
      } catch (e) {}
    }
  }
  // Fallback: try common chat area containers
  const fallbacks = ["main", "[role='main']", "#__next", "#app", "#root"];
  for (const sel of fallbacks) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch (e) {}
  }
  return document.body;
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
 * Validasi apakah suatu elemen pantas dijadikan response container
 */
function isValidResponseElement(el) {
  if (!el || !(el instanceof Element)) return false;
  const tag = el.tagName.toLowerCase();
  if (["textarea", "input", "form", "script", "style", "head", "button", "nav", "header", "footer"].includes(tag)) return false;

  // Tolak jika elemen berada di dalam composer/input/editor/footer/sidebar/history
  if (el.closest("form, #prompt-textarea, [contenteditable='true'], [role='textbox'], .composer, footer, header, nav, aside, [class*='sidebar'], [class*='footer'], [class*='disclaimer'], [class*='history'], [class*='navigation'], [class*='menu']")) return false;

  // Tolak elemen footer/disclaimer berdasarkan selector
  if (el.matches("footer, [class*='disclaimer'], [class*='footer'], [class*='bottom-bar'], [class*='legal'], [class*='copyright'], [class*='history'], [class*='sidebar']")) return false;

  // Tolak jika merupakan pesan pengguna (user message)
  if (
    el.matches("[data-message-author-role='user'], [data-testid='user-message'], [class*='user-message'], [class*='userMessage'], [class*='font-user']") ||
    el.closest("[data-message-author-role='user'], [data-testid='user-message'], [class*='user-message'], [class*='userMessage'], [class*='font-user']")
  ) return false;

  // Cek apakah memiliki dimensi atau teks bermakna
  const text = (el.innerText || el.textContent || "").replace(/[\u200B-\u200D\uFEFF\s]/g, "");
  if (!text || text.length < 2) return false;

  // Tolak teks kontrol UI atau timestamp pendek
  if (/^(auto|tulis pesan…|tulis pesan|write your prompt|type a message|salin|copy|share|more actions|sekarang|hari ini|kemarin|today|yesterday|just now|citation sources.*)$/i.test(text)) return false;

  // Tolak teks disclaimer / notice / citation / quota limit yang sering salah ditangkap sebagai respon
  const lowerText = text.toLowerCase();
  if (/(?:dapat membuat kesalahan|may not be accurate|for reference only|can make mistakes|ai-generated|one more step|verify important|consider checking|not always accurate|mimo-v2|bisa saja salah|harap verifikasi|periksa info penting|citation sources|chat.*cowork|chatgpt bilang|file,\s*gambar|tidak tersedia hingga|lanjutkan chat hanya dengan teks|upgrade to plus|usage limit)/i.test(lowerText)) return false;

  return true;
}

/**
 * Find all matching assistant response containers
 * SCOPED: All searches are constrained within responseScope area.
 * Multi-layer detection: Model Selector -> Well-Known AI Selectors -> Smart Action Anchor -> Generic Fallback
 */
function getResponseContainers(modelConfig) {
  const scope = getScopeRoot(modelConfig);

  // 1. Coba selector spesifik dari modelConfig (SCOPED)
  if (modelConfig?.resultContainerSelector) {
    const parts = modelConfig.resultContainerSelector.split(",").map(s => s.trim()).filter(Boolean);
    for (const sel of parts) {
      try {
        const found = scope.querySelectorAll(sel);
        const valid = Array.from(found).filter(isValidResponseElement);
        if (valid.length > 0) return valid;
      } catch (e) {}
    }
  }

  // 2. Coba selector standar industri & platform AI ternama (SCOPED)
  const wellKnownSelectors = [
    "div[data-message-author-role='assistant'] .markdown",
    "div[data-message-author-role='assistant']",
    ".agent-turn div[data-message-author-role='assistant']",
    "div[data-is-streaming='true']",
    "div[data-testid='chat-message']:not([data-testid='user-message'])",
    ".font-claude-message",
    "[class*='font-claude']",
    ".ds-markdown",
    "[class*='ds-markdown']",
    "message-content",
    ".model-response-text",
    "[class*='message-item-assistant']",
    "[class*='chat-item--assistant']",
    "[class*='message-assistant']",
    "[class*='assistant-message']",
    ".message-ai",
    ".chat-bubble-bot",
    "[data-role='assistant']",
    "[data-author='assistant']",
    "[class*='qwen-markdown']"
  ];

  for (const sel of wellKnownSelectors) {
    try {
      const found = scope.querySelectorAll(sel);
      const valid = Array.from(found).filter(isValidResponseElement);
      if (valid.length > 0) return valid;
    } catch (e) {}
  }

  // 3. SMART ANCHOR DISCOVERY (SCOPED): Temukan container lewat tombol aksi asisten
  try {
    const actionButtons = scope.querySelectorAll(
      "button[aria-label*='Copy' i], button[aria-label*='Salin' i], button[aria-label*='复制'], " +
      "button[title*='Copy' i], button[title*='Salin' i], button[title*='复制'], " +
      "button[aria-label*='Good' i], button[aria-label*='Bagus' i], button[aria-label*='赞'], " +
      "button[aria-label*='Regenerate' i], button[aria-label*='Coba lagi' i], button[aria-label*='重新生成'], " +
      "button[aria-label*='Bacakan' i], button[aria-label*='Read aloud' i]"
    );

    const anchorContainers = [];
    const seen = new Set();

    for (const btn of actionButtons) {
      let parent = btn.closest("article, [data-testid*='message'], [class*='message'], [class*='turn'], [class*='item'], [class*='bubble'], [class*='row']");
      if (!parent) {
        parent = btn.parentElement?.parentElement?.parentElement || btn.parentElement?.parentElement;
      }
      if (parent && !seen.has(parent) && isValidResponseElement(parent) && scope.contains(parent)) {
        seen.add(parent);
        anchorContainers.push(parent);
      }
    }

    if (anchorContainers.length > 0) {
      return anchorContainers;
    }
  } catch (e) {}

  // 4. Coba selector elemen umum (SCOPED) dengan teks markdown di dalam area chat
  const genericSelectors = [
    "article:not([class*='user'])",
    ".markdown:not([class*='user'])",
    "[class*='markdown']:not([class*='user'])",
    ".chat-content:not([class*='user'])",
    "[class*='chat-content']:not([class*='user'])"
  ];

  for (const sel of genericSelectors) {
    try {
      const found = scope.querySelectorAll(sel);
      const valid = Array.from(found).filter(isValidResponseElement);
      if (valid.length > 0) return valid;
    } catch (e) {}
  }

  return [];
}

/**
 * DOM Diffing & Positional Turn Tracker (SCOPED):
 * Menemukan respon asisten dengan mencari elemen yang muncul tepat SETELAH teks prompt user
 * dalam urutan DOM percakapan. Pencarian dibatasi dalam responseScope.
 */
function findAssistantResponseByDOMDiff(query, modelConfig) {
  if (!query || typeof query !== "string") return null;

  // Cuplikan teks query pengguna untuk pencocokan (ambil 35 karakter pertama yang unik)
  const cleanQ = query.replace(/[\u200B-\u200D\uFEFF\s]/g, "").toLowerCase();
  const sample = cleanQ.slice(0, Math.min(cleanQ.length, 35));
  if (!sample) return null;

  // SCOPED: Cari hanya di dalam responseScope area
  const scope = getScopeRoot(modelConfig);

  // 1. Cari elemen teks di chat body yang memuat teks prompt user (SCOPED)
  const candidates = Array.from(scope.querySelectorAll("p, div, article, span, li"));
  let userTurnEl = null;

  for (let i = candidates.length - 1; i >= 0; i--) {
    const el = candidates[i];
    // Abaikan area composer/input
    if (el.closest("form, #prompt-textarea, [contenteditable='true'], textarea, [role='textbox'], footer")) continue;
    
    const text = (el.innerText || el.textContent || "").replace(/[\u200B-\u200D\uFEFF\s]/g, "").toLowerCase();
    if (text.includes(sample)) {
      // Temukan kontainer turn pembungkus
      userTurnEl = el.closest("article, [data-testid*='message'], [class*='message'], [class*='turn'], [class*='row'], [class*='item']") || el;
      break;
    }
  }

  if (userTurnEl) {
    // 2. Cari elemen asisten yang berada SETELAH userTurnEl di dalam DOM
    let nextNode = userTurnEl.nextElementSibling;
    while (nextNode) {
      if (isValidResponseElement(nextNode) && scope.contains(nextNode)) {
        return nextNode;
      }
      const innerMessage = nextNode.querySelector("article, [class*='message'], .markdown, div");
      if (innerMessage && isValidResponseElement(innerMessage) && scope.contains(innerMessage)) {
        return innerMessage;
      }
      nextNode = nextNode.nextElementSibling;
    }

    // Cek parent level jika turn user dibungkus dalam wrapper div
    let parent = userTurnEl.parentElement;
    while (parent && parent !== document.body && parent !== scope && parent.tagName.toLowerCase() !== "main") {
      if (parent.nextElementSibling) {
        let sibling = parent.nextElementSibling;
        while (sibling) {
          if (isValidResponseElement(sibling) && scope.contains(sibling)) return sibling;
          const inner = sibling.querySelector("article, [class*='message'], .markdown, div");
          if (inner && isValidResponseElement(inner) && scope.contains(inner)) return inner;
          sibling = sibling.nextElementSibling;
        }
      }
      parent = parent.parentElement;
    }
  }

  return null;
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
  return /^(thinking(\.{0,3}|…)?|thinking process(\.{0,3}|…)?|thinking completed|finished thinking|menalar(\.{0,3}|…)?|sedang berpikir(\.{0,3}|…)?|berhenti berpikir|stop thinking|berpikir(\.{0,3}|…)?|merenung(\.{0,3}|…)?|(?:berpikir|menalar|merenung)\s+selama\s+.*|thought\s+for\s+.*|已完成思考|思考过程)$/i.test(cleaned);
}

function cleanResultMarkdown(markdown) {
  if (!markdown) return "";
  let cleaned = markdown
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    // Hapus header accessibility ChatGPT ("#### ChatGPT bilang:")
    .replace(/^(?:#+\s*)?(?:ChatGPT bilang:|ChatGPT's response:|ChatGPT:|Anda bilang:[^\n]*)\s*/gim, "")
    // Hapus header accessibility & navigation Claude ("Chat Cowork", "Claude merespons:", ikon private Unicode)
    .replace(/^(?:#+\s*)?(?:Claude merespons:|Claude's response:|Claude:|Chat\s*Cowork|[\uE000-\uF8FF][^\n]*)\s*/gim, "")
    // Hapus header thinking Qwen, DeepSeek, ChatGPT, Claude (Merenung), Gemini, Xiaomi MiMo, dll
    .replace(/^(?:#+\s*)?(?:Thinking completed|Thinking process|Thought process|Finished thinking|Thinking|Menalar|Merenung|Sedang berpikir|Berhenti berpikir|Stop thinking|已完成思考|思考过程)(?:\.{0,3}|…)?\s*(?:\n+|$)/gim, "")
    .replace(/^(?:Berhenti berpikir|Stop thinking)\s*\n+/gim, "")
    .replace(/^(?:Berpikir|Menalar|Merenung)\s+selama\s+[^\n]+\n+/gim, "")
    .replace(/^(?:Thought for\s+[^\n]+)\n+/gim, "")
    .replace(/^(?:Thinking completed|Thinking process|Finished thinking|Merenung)\s*/gim, "")
    // Hapus header timestamp ("sekarang", "hari ini")
    .replace(/^(?:#+\s*)?(?:sekarang|just now|hari ini|kemarin|today|yesterday)\s*\n+/gim, "")
    // Hapus footer status generasi ("Generating", "Generating...", "Sedang membuat...", "Stop generating", dll)
    .replace(/(?:\r?\n|\s)*(?:Generating(?:\.{0,3}|…)?|Sedang membuat(?:\.{0,3}|…)?|Sedang menghasilkan(?:\.{0,3}|…)?|Stop generating|Berhenti membuat|Menggenerasi(?:\.{0,3}|…)?)\s*$/gim, "")
    .replace(/(?:\n+|^)(?:Generating(?:\.{0,3}|…)?|Sedang membuat(?:\.{0,3}|…)?|Sedang menghasilkan(?:\.{0,3}|…)?)\s*(?:\n+|$)/gim, "\n\n")
    // Hapus footer disclaimer kuota / gambar ChatGPT ("File, Gambar, dan analisis data tidak tersedia...")
    .replace(/(?:\n+|^)(?:File,\s*Gambar[^\n]*|Files?,\s*images?[^\n]*|analisis data tidak tersedia[^\n]*|Lanjutkan chat hanya dengan teks[^\n]*|Tingkatkan untuk akses lebih luas[^\n]*|Upgrade to Plus[^\n]*|Usage limit reached[^\n]*|penggunaan direset[^\n]*).*$/gim, "")
    // Hapus footer citation / source disclaimer ("Citation sources (0)")
    .replace(/(?:\n+|^)(?:Citation sources\s*(?:\(\d+\))?|Sources\s*(?:\(\d+\))?|Referensi\s*(?:\(\d+\))?)[^\n]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n");
  return cleaned.trim() || markdown.trim();
}

/**
 * Check if the page is currently streaming
 */
function checkIsStreaming(modelConfig) {
  if (modelConfig?.streamSelector) {
    const el = findElementByPattern(modelConfig.streamSelector);
    if (el && (el.offsetParent !== null || window.getComputedStyle(el).display !== "none")) {
      return true;
    }
  }
  const genericStream = document.querySelector(
    ".streaming, [data-is-streaming='true'], .typing-indicator, [class*='streaming'], [class*='typing'], " +
    "button[aria-label*='Stop' i], button[aria-label*='Berhenti' i], button[aria-label*='停止']"
  );
  if (genericStream && (genericStream.offsetParent !== null || window.getComputedStyle(genericStream).display !== "none")) {
    return true;
  }
  return false;
}

/**
 * Enter prompt text into input element using native DOM setters and input events
 * Handles React/Vue/ProseMirror/Svelte input state listeners
 */
async function enterPrompt(inputEl, text, modelConfig = null) {
  if (!inputEl) return;
  inputEl.focus();

  if (inputEl.isContentEditable) {
    // ContentEditable (ChatGPT ProseMirror / Lexical / ChatSmith / Claude)
    inputEl.focus();
    document.execCommand("selectAll", false, null);
    const success = document.execCommand("insertText", false, text);
    if (!success) {
      inputEl.innerHTML = `<p>${text}</p>`;
    }
    inputEl.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
    inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // Standard Textarea / Input with native value setter (DeepSeek / Qwen / MiMo / Grok)
    inputEl.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      inputEl instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
      "value"
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(inputEl, text);
    } else {
      inputEl.value = text;
    }
    inputEl.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
    inputEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  await new Promise(r => setTimeout(r, 350));

  // Dismiss any blocking dialogs/overlays if present (e.g. login prompts, welcome modals)
  const dismissBtn = document.querySelector("button[aria-label='Tutup'], button[aria-label='Close'], button[aria-label='Kembali ke ChatGPT'], button:has(svg path[d*='M18 6L6 18'])");
  if (dismissBtn) {
    try { dismissBtn.click(); } catch(e) {}
    await new Promise(r => setTimeout(r, 200));
  }

  // Trigger Send Button click with full pointer/mouse/click dispatch
  triggerSendOrEnter(modelConfig, inputEl);
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
function observeCompletion(requestId, modelConfig, query, streamMode, initialCount = 0, initialText = "", isRetry = false) {
  return new Promise((resolve, reject) => {
    let lastMarkdown = "";
    let streamStarted = false;
    let stableCount = 0;
    let pollCount = 0;
    const maxPolls = 180; // 90 seconds max

    const interval = setInterval(() => {
      pollCount++;
      // 1. DOM Positional Diffing: cari elemen respon yang berada setelah user prompt
      const diffEl = findAssistantResponseByDOMDiff(query, modelConfig);

      // 2. Standard selector containers
      const currentContainers = getResponseContainers(modelConfig);
      const hasNewContainer = currentContainers.length > initialCount;
      const latestSelectorEl = currentContainers.length > 0 ? currentContainers[currentContainers.length - 1] : null;

      // Prioritaskan elemen yang ditemukan lewat DOM diffing tepat setelah user prompt
      const latestResponseEl = diffEl || latestSelectorEl;

      const rawHtml = latestResponseEl ? latestResponseEl.innerHTML : "";
      const isStreaming = checkIsStreaming(modelConfig);
      const markdown = cleanHtmlToMarkdown(rawHtml || latestResponseEl || "");
      const meaningfulMarkdown = cleanResultMarkdown(markdown);
      const thinkingOnly = isThinkingOnly(markdown) || isThinkingOnly(meaningfulMarkdown);

      // Cek apakah konten ini teks baru dari generasi saat ini
      const isTextDifferent = (!initialText && meaningfulMarkdown.length > 0) || 
                              (Boolean(initialText) && meaningfulMarkdown !== initialText && (!meaningfulMarkdown.startsWith(initialText) || meaningfulMarkdown.length > initialText.length + 5));
      const isNewResponse = Boolean(diffEl) || hasNewContainer || isTextDifferent;
      const hasMeaningfulText = meaningfulMarkdown.replace(/[`\s]/g, "").length > 0;

      // Filter out user message reflections (jangan anggap teks prompt sebagai jawaban)
      const normalizedQuery = (query || "").replace(/[\u200B-\u200D\uFEFF\s]/g, "").toLowerCase();
      const normalizedResponse = meaningfulMarkdown.replace(/[\u200B-\u200D\uFEFF\s]/g, "").toLowerCase();
      const isUserEcho = normalizedQuery.length > 0 && (normalizedResponse === normalizedQuery || (normalizedResponse.startsWith(normalizedQuery) && normalizedResponse.length <= normalizedQuery.length + 5));

      // HANYA proses jika ini benar-benar respon baru (bukan teks lama yang belum terupdate)
      if (hasMeaningfulText && !thinkingOnly && !isUserEcho && isNewResponse) {
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

      if (pollCount % 10 === 0 || pollCount <= 3) {
        console.log(`[ZeroLLM Monitor] Poll #${pollCount}: containers=${currentContainers.length}, streaming=${isStreaming}, streamStarted=${streamStarted}, textLen=${meaningfulMarkdown.length}, stable=${stableCount}`);
      }

      // ── DETEKSI AI BENGONG -> AUTO NEW CHAT & RETRY ──
      // Jika setelah 12.5 detik (25 polls) belum ada respon mengalir sama sekali
      if (!isRetry && pollCount === 25 && !streamStarted && !isStreaming) {
        console.warn("[ZeroLLM Fallback] AI tidak merespon (bengong) setelah 12.5 detik. Membuka Obrolan Baru & mengulang...");
        
        // Coba picu tombol submit/enter sekali lagi
        triggerSendOrEnter(modelConfig);

        setTimeout(async () => {
          if (!streamStarted && !checkIsStreaming(modelConfig)) {
            console.log("[ZeroLLM Fallback] Melakukan New Chat fallback...");
            const newChatSel = modelConfig?.newChatSelector || "a[href='/'], [data-testid='new-chat-button'], [aria-label*='Obrolan baru'], [aria-label*='New chat'], [aria-label*='Percakapan baru'], [aria-label*='新建对话']";
            const newChatBtn = findElementByPattern(newChatSel);
            if (newChatBtn) {
              try { newChatBtn.click(); } catch(e) {}
            }

            // Tunggu input siap di percakapan baru
            await new Promise(r => setTimeout(r, 1500));
            let retryInput = null;
            for (let i = 0; i < 15; i++) {
              retryInput = findElementByPattern(modelConfig?.startChatSelector) ||
                           findElementByPattern(modelConfig?.continueChatSelector) ||
                           document.querySelector("#prompt-textarea, #mobile-composer-prompt, textarea, [contenteditable='true']");
              if (retryInput && !retryInput.disabled && retryInput.getAttribute("aria-disabled") !== "true") break;
              await new Promise(r => setTimeout(r, 400));
            }

            if (retryInput) {
              console.log("[ZeroLLM Fallback] Mengetik ulang prompt di percakapan baru...");
              await enterPrompt(retryInput, query);
              await new Promise(r => setTimeout(r, 400));
              triggerSendOrEnter(modelConfig);

              pollCount = 0;
              isRetry = true;
              initialCount = getResponseContainers(modelConfig).length;
              initialText = "";
              lastMarkdown = "";
            }
          }
        }, 1500);
      }

      // Selesai jika:
      // 1. Teks baru terdeteksi (streamStarted) dan memiliki teks bermakna
      // 2. Tidak lagi dalam status streaming ATAU teks sudah stabil minimal 3 detik (stableCount >= 6 fail-safe)
      // 3. Teks stabil minimal 2 putaran polling (1 detik)
      const isDoneStreaming = !isStreaming || stableCount >= 6;
      if (streamStarted && hasMeaningfulText && !thinkingOnly && isDoneStreaming && stableCount >= 2 && pollCount >= 2) {
        clearInterval(interval);
        console.log(`[ZeroLLM Monitor] Response completed successfully (${meaningfulMarkdown.length} chars)`);
        resolve(cleanResultMarkdown(lastMarkdown));
        return;
      }

      // Safety timeout
      if (pollCount >= maxPolls) {
        clearInterval(interval);
        if (lastMarkdown && hasMeaningfulText && !thinkingOnly) {
          console.log(`[ZeroLLM Monitor] Max polls reached, returning last stable text (${lastMarkdown.length} chars)`);
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
  await enterPrompt(inputEl, query, modelConfig);

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
  // If msg.query is provided, type directly via enterPrompt (bypasses CDP focus loss on ProseMirror)
  if (msg.type === "focusInput") {
    (async () => {
      // 1. Tutup modal/banner promosi atau dialog error yang menghalangi
      const dismissBtns = document.querySelectorAll("button[aria-label='Tutup'], button[aria-label='Close'], button[aria-label='Kembali ke ChatGPT'], button:has(svg path[d*='M18 6L6 18'])");
      dismissBtns.forEach(btn => { try { btn.click(); } catch(e) {} });

      // 2. Tunggu input element selesai dimuat / dihidrasi SPA (hingga 12 detik)
      let inputEl = null;
      for (let i = 0; i < 24; i++) {
        inputEl = findElementByPattern(msg.modelConfig?.continueChatSelector) || 
                  findElementByPattern(msg.modelConfig?.startChatSelector) ||
                  document.querySelector("#prompt-textarea, #mobile-composer-prompt, textarea, [contenteditable='true']");
        
        if (inputEl && !inputEl.disabled && inputEl.getAttribute("aria-disabled") !== "true") {
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }

      if (inputEl) {
        const prevContainers = getResponseContainers(msg.modelConfig);
        const lastEl = prevContainers.length > 0 ? prevContainers[prevContainers.length - 1] : null;
        const initialText = lastEl ? cleanResultMarkdown(cleanHtmlToMarkdown(lastEl.innerHTML || lastEl)) : "";

        // Jika query dikirim langsung: ketik dan submit di content.js (bypass CDP focus loss)
        if (msg.query) {
          await enterPrompt(inputEl, msg.query, msg.modelConfig);
          sendResponse({ success: true, directTyped: true, initialCount: prevContainers.length, initialText });
        } else {
          // Legacy: hanya fokus dan bersihkan, biarkan CDP mengetik
          inputEl.focus();
          if (inputEl.isContentEditable) {
            // Untuk ProseMirror: JANGAN execCommand("delete") karena kehilangan fokus.
            // Cukup selectAll, lalu CDP akan replace via insertText.
            document.execCommand("selectAll", false, null);
          } else {
            inputEl.value = "";
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
          }
          sendResponse({ success: true, initialCount: prevContainers.length, initialText });
        }
      } else {
        sendResponse({ success: false, error: "Input not found or still loading after 12s" });
      }
    })();
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
