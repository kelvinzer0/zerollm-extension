/**
 * ZeroLLM Multi-Tab Router & Background Service Worker
 * 
 * Fitur Utama:
 * 1. AUTO-OPEN & AUTO-INJECT:
 *    - Jika tab belum ada: otomatis membuka tab baru di background.
 *    - Jika extension di-reload: otomatis menyambung ulang content script ke tab yang sudah ada
 *      tanpa perlu refresh tab manual!
 * 2. Active Keepalive Heartbeat: Mengirim ping berkala (15s) agar WebSocket ke Cloudflare Worker
 *    dan Chrome MV3 Service Worker tidak tertidur (sleep/hibernation).
 * 3. Multi-tab parallel orchestration: Map<modelId, tabId>.
 * 4. Integrasi Cloudflare Worker Bridge via WebSocket.
 */

import { DEFAULT_PRESETS } from "./presets.js";

let ws = null;
let bridgeUrl = "https://llm-bridge.insidexofficial.workers.dev";
let roomId = "default";
let apiKey = "";
let connectionState = "disconnected";
let reconnectTimer = null;
let pingInterval = null;

// User defined & preset models
let models = [];
// Execution mode: "sequential" (single window queue) | "parallel" (dedicated multi-window parallel)
let executionMode = "sequential";

// Active Model -> Tab ID mapping: Map<modelId, tabId>
const modelTabMap = new Map();
// Model -> Window ID mapping (digunakan saat parallel mode aktif): Map<modelId, windowId>
const modelWindowMap = new Map();

// Sequential Single-Window FIFO Queue
const globalQueue = [];
let isProcessingGlobalQueue = false;

// Parallel Multi-Window Queues per Model: Map<modelId, Array<task>>
const modelQueues = new Map();
const isProcessingModel = new Map();

// Map request aktif: Map<requestId, { resolve, reject, task, targetTabId, originalTabId }>
const activeRequests = new Map();

// ============================================================
//  STORAGE & INITIALIZATION
// ============================================================

async function loadModels() {
  const data = await chrome.storage.local.get(["customModels", "bridgeUrl", "roomId", "apiKey", "executionMode"]);
  if (data.customModels && Array.isArray(data.customModels) && data.customModels.length > 0) {
    // Preserve custom models & user edits, but auto-append newly introduced default presets
    const existingIds = new Set(data.customModels.map(m => m.id));
    let hasNew = false;
    models = [...data.customModels];
    for (const preset of DEFAULT_PRESETS) {
      if (!existingIds.has(preset.id)) {
        models.push({ ...preset });
        hasNew = true;
      }
    }
    if (hasNew) {
      await chrome.storage.local.set({ customModels: models });
    }
  } else {
    models = [...DEFAULT_PRESETS];
    await chrome.storage.local.set({ customModels: models });
  }

  if (data.bridgeUrl) bridgeUrl = data.bridgeUrl;
  if (data.roomId) roomId = data.roomId;
  if (data.apiKey) apiKey = data.apiKey;
  if (data.executionMode) executionMode = data.executionMode;
}

// ============================================================
//  AUTO RE-ATTACH ON EXTENSION RELOAD
// ============================================================

/**
 * Otomatis inject content script ke semua tab yang cocok dengan model aktif
 * ketika extension baru saja di-reload. Mencegah user harus refresh tab manual!
 */
async function autoAttachExistingTabs() {
  try {
    const allTabs = await chrome.tabs.query({});
    for (const model of models) {
      if (model.enabled === false) continue;
      const patternRegex = wildcardToRegExp(model.urlPattern);
      const matchingTab = allTabs.find(t => t.url && patternRegex.test(t.url));
      if (matchingTab) {
        modelTabMap.set(model.id, matchingTab.id);
        console.log(`[ZeroLLM] Auto-reattaching tab #${matchingTab.id} for model ${model.id}`);
        await injectContentScriptSilently(matchingTab.id);
      }
    }
  } catch (err) {
    console.warn("[ZeroLLM] autoAttachExistingTabs warning:", err.message);
  }
}

async function injectContentScriptSilently(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    if (res && res.pong) return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/content.js"]
      });
      return true;
    } catch (scriptErr) {
      return false;
    }
  }
  return false;
}

// ============================================================
//  MULTI-TAB RESOLUTION & AUTO-OPEN
// ============================================================

function wildcardToRegExp(pattern) {
  let norm = pattern.trim();
  const hasTrailingSlashStar = norm.endsWith("/*");
  if (hasTrailingSlashStar) {
    norm = norm.slice(0, -2);
  }
  let escaped = norm
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (hasTrailingSlashStar) {
    escaped += "(?:/.*)?";
  }
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Mencari tab yang cocok atau OTOMATIS MEMBUKA TAB/WINDOW BARU jika belum terbuka
 */
async function getTabForModel(modelConfig) {
  const patternRegex = wildcardToRegExp(modelConfig.urlPattern);

  // ── MODE PARALEL (MULTI-WINDOW) ──────────────────────────────
  if (executionMode === "parallel") {
    // 1. Cek window terdaftar untuk model ini
    const winId = modelWindowMap.get(modelConfig.id);
    if (winId) {
      try {
        const win = await chrome.windows.get(winId, { populate: true });
        const tab = win.tabs?.find(t => t.url && patternRegex.test(t.url)) || win.tabs?.[0];
        if (tab) {
          modelTabMap.set(modelConfig.id, tab.id);
          return tab;
        }
      } catch (e) {
        modelWindowMap.delete(modelConfig.id);
      }
    }

    // 2. Cek apakah ada window manapun yang memiliki tab yang cocok
    const allWindows = await chrome.windows.getAll({ populate: true }).catch(() => []);
    for (const w of allWindows) {
      const match = w.tabs?.find(t => t.url && patternRegex.test(t.url));
      if (match) {
        modelWindowMap.set(modelConfig.id, w.id);
        modelTabMap.set(modelConfig.id, match.id);
        return match;
      }
    }

    // 3. Jika belum ada: Buka Jendela Baru Khusus (Dedicated Window) untuk model ini!
    console.log(`[ZeroLLM Parallel] Opening dedicated window for model ${modelConfig.id}...`);
    let targetUrl = modelConfig.urlPattern.replace(/\*/g, "");
    if (!targetUrl.startsWith("http")) {
      targetUrl = "https://" + targetUrl.replace(/^\/+/, "");
    }

    const newWin = await chrome.windows.create({
      url: targetUrl,
      type: "normal",
      width: 960,
      height: 720,
      focused: false
    });
    const createdTab = newWin.tabs?.[0];
    if (newWin.id) modelWindowMap.set(modelConfig.id, newWin.id);
    if (createdTab) modelTabMap.set(modelConfig.id, createdTab.id);

    // Tunggu tab selesai dimuat (max 10 detik)
    await new Promise(resolve => {
      const listener = (tabId, info) => {
        if (createdTab && tabId === createdTab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(resolve, 10000);
    });

    return createdTab;
  }

  // ── MODE SEQUENTIAL (SINGLE-WINDOW) ──────────────────────────
  // 0. Prioritaskan active tab di jendela yang sedang dibuka user jika cocok!
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url && patternRegex.test(activeTab.url)) {
      modelTabMap.set(modelConfig.id, activeTab.id);
      return activeTab;
    }
  } catch (e) {}

  const allTabs = await chrome.tabs.query({});

  // 1. Cek tab yang sudah dipetakan sebelumnya
  const existingTabId = modelTabMap.get(modelConfig.id);
  if (existingTabId) {
    const tab = allTabs.find(t => t.id === existingTabId);
    if (tab && tab.url && patternRegex.test(tab.url)) {
      return tab;
    }
  }

  // 2. Cari tab yang sedang terbuka dan cocok dengan URL pattern
  const matchingTab = allTabs.find(t => t.url && patternRegex.test(t.url));
  if (matchingTab) {
    modelTabMap.set(modelConfig.id, matchingTab.id);
    return matchingTab;
  }

  // 3. Jika belum terbuka sama sekali -> OTOMATIS BUKA TAB BARU DI BACKGROUND
  console.log(`[ZeroLLM] No tab open for ${modelConfig.id}. Opening target URL automatically...`);
  let targetUrl = modelConfig.defaultUrl;
  if (!targetUrl) {
    targetUrl = modelConfig.urlPattern.replace(/\*/g, "");
    if (!targetUrl.startsWith("http")) {
      targetUrl = "https://" + targetUrl.replace(/^\/+/, "");
    }
  }

  const newTab = await chrome.tabs.create({
    url: targetUrl,
    active: false
  });
  modelTabMap.set(modelConfig.id, newTab.id);

  // Tunggu tab selesai dimuat (max 10 detik)
  await new Promise(resolve => {
    const listener = (tabId, info) => {
      if (tabId === newTab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 10000);
  });

  return newTab;
}

/**
 * Memastikan content script siap merespon perintah
 */
async function ensureContentScript(tabId) {
  const isReady = await injectContentScriptSilently(tabId);
  if (!isReady) {
    await new Promise(r => setTimeout(r, 500));
    await injectContentScriptSilently(tabId);
  }
}

// ============================================================
//  WEBSOCKET BRIDGE CONNECTION & ACTIVE KEEPALIVE
// ============================================================

function connectBridge(url, room, key) {
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  clearInterval(pingInterval);

  bridgeUrl = url;
  roomId = room;
  apiKey = key || "";
  connectionState = "connecting";
  broadcastState();

  const wsUrl = url.replace(/^http/, "ws") + `/ws/extension?room=${roomId}`;
  console.log(`[ZeroLLM] Connecting to Bridge: ${wsUrl}`);

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      connectionState = "connected";
      broadcastState();
      clearTimeout(reconnectTimer);
      chrome.storage.local.set({ bridgeUrl: url, roomId: room, apiKey });

      // Sinkronisasi model ke Cloudflare Worker
      syncModelsToBridge();

      // Mulai heartbeat keepalive aktif setiap 15 detik agar koneksi tidak pernah putus/hibernasi
      clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      }, 15000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleBridgeMessage(msg);
      } catch (err) {
        console.error("[ZeroLLM] Error parsing message:", err);
      }
    };

    ws.onclose = () => {
      connectionState = "disconnected";
      broadcastState();
      clearInterval(pingInterval);
      ws = null;
      reconnectTimer = setTimeout(() => {
        if (bridgeUrl && roomId) connectBridge(bridgeUrl, roomId, apiKey);
      }, 3000);
    };

    ws.onerror = (err) => {
      console.error("[ZeroLLM] WebSocket error:", err);
    };
  } catch (err) {
    connectionState = "disconnected";
    broadcastState();
  }
}

function disconnectBridge() {
  clearTimeout(reconnectTimer);
  clearInterval(pingInterval);
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  connectionState = "disconnected";
  broadcastState();
}

function sendToBridge(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function syncModelsToBridge() {
  const activeModels = models
    .filter(m => m.enabled !== false)
    .map(m => ({
      id: m.id,
      name: m.name || m.id,
      owned_by: "zerollm-extension",
      description: m.description || `Web AI model for ${m.urlPattern}`
    }));

  sendToBridge({
    type: "registerModels",
    models: activeModels
  });
}

// ============================================================
//  PROMPT FORMATTER & TOOL CALL PARSER
// ============================================================

/**
 * Ekstraksi pemanggilan tool standar OpenAI dari balasan model.
 * Mendukung format pelapis (layered): <action name="...">...</action>, [ACTION: ...], dan blok JSON.
 */
function parseToolCalls(text) {
  if (!text || typeof text !== "string") return null;

  const calls = [];

  // Pola 1 (Utama / Bebas Konflik): <action name="...">...</action> atau <call name="...">...</call>
  const tagRegex = /<(?:action|call)\s+name=["\x27]([\w_-]+)["\x27]\s*>([\s\S]*?)<\/(?:action|call)>/gi;
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    const fnName = match[1];
    let argsStr = match[2].trim();
    try {
      const parsed = JSON.parse(argsStr);
      argsStr = JSON.stringify(parsed);
    } catch(e) {
      if (!argsStr.startsWith("{")) argsStr = JSON.stringify({ input: argsStr });
    }
    calls.push({
      id: "call_" + Math.random().toString(36).substring(2, 10),
      type: "function",
      function: { name: fnName, arguments: argsStr }
    });
  }

  // Pola 1b: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
  if (calls.length === 0) {
    const xmlToolRegex = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi;
    while ((match = xmlToolRegex.exec(text)) !== null) {
      try {
        const obj = JSON.parse(match[1].trim());
        const fnName = obj.name || obj.tool;
        const args = obj.arguments || obj.parameters || {};
        if (fnName) {
          calls.push({
            id: obj.id || `call_${Math.random().toString(36).substring(2, 10)}`,
            type: "function",
            function: {
              name: fnName,
              arguments: typeof args === "string" ? args : JSON.stringify(args)
            }
          });
        }
      } catch(e) {}
    }
  }

  // Pola 1c: ```tool_json\n{"tool":"...", "parameters":{...}}\n```
  if (calls.length === 0) {
    const toolJsonRegex = /```(?:tool_json|tool)\s*\n?([\s\S]*?)\n?```/gi;
    while ((match = toolJsonRegex.exec(text)) !== null) {
      try {
        const obj = JSON.parse(match[1].trim());
        const fnName = obj.tool || obj.name;
        const args = obj.parameters || obj.arguments || {};
        if (fnName) {
          calls.push({
            id: obj.id || `call_${Math.random().toString(36).substring(2, 10)}`,
            type: "function",
            function: {
              name: fnName,
              arguments: typeof args === "string" ? args : JSON.stringify(args)
            }
          });
        }
      } catch(e) {}
    }
  }

  // Pola 2 (Alternatif): [ACTION: nama_fungsi({"param": "nilai"})]
  if (calls.length === 0) {
    const bracketRegex = /\[(?:ACTION|PANGGIL_FUNGSI|TOOL|CALL):\s*([\w_-]+)\(([\s\S]*?)\)\]/gi;
    while ((match = bracketRegex.exec(text)) !== null) {
      const fnName = match[1];
      let argsStr = match[2].trim();
      try {
        const parsed = JSON.parse(argsStr);
        argsStr = JSON.stringify(parsed);
      } catch(e) {
        argsStr = JSON.stringify({ param: argsStr });
      }
      calls.push({
        id: "call_" + Math.random().toString(36).substring(2, 10),
        type: "function",
        function: { name: fnName, arguments: argsStr }
      });
    }
  }

  // Pola 3 (Fallback JSON murni jika model memilih format JSON langsung)
  if (calls.length === 0) {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    let candidate = jsonMatch ? jsonMatch[1].trim() : text.trim();

    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidate = candidate.slice(firstBrace, lastBrace + 1);
    }

    try {
      const parsed = JSON.parse(candidate);

      if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
        return parsed.tool_calls.map(tc => ({
          id: tc.id || `call_${Math.random().toString(36).substring(2, 10)}`,
          type: "function",
          function: {
            name: tc.name || tc.function?.name,
            arguments: typeof tc.arguments === "string" 
              ? tc.arguments 
              : JSON.stringify(tc.arguments || tc.function?.arguments || {})
          }
        })).filter(tc => tc.function.name);
      }

      if (parsed.tool && (parsed.parameters !== undefined || parsed.arguments !== undefined)) {
        return [{
          id: parsed.id || `call_${Math.random().toString(36).substring(2, 10)}`,
          type: "function",
          function: {
            name: parsed.tool,
            arguments: typeof (parsed.parameters || parsed.arguments) === "string"
              ? (parsed.parameters || parsed.arguments)
              : JSON.stringify(parsed.parameters || parsed.arguments || {})
          }
        }];
      }

      if (parsed.name && (parsed.arguments !== undefined || parsed.parameters !== undefined)) {
        return [{
          id: parsed.id || `call_${Math.random().toString(36).substring(2, 10)}`,
          type: "function",
          function: {
            name: parsed.name,
            arguments: typeof (parsed.arguments || parsed.parameters) === "string"
              ? (parsed.arguments || parsed.parameters)
              : JSON.stringify(parsed.arguments || parsed.parameters || {})
          }
        }];
      }
    } catch (e) {}
  }

  return calls.length > 0 ? calls : null;
}

/**
 * Format messages dan tools dari format standar OpenAI Chat Completions
 * menjadi satu kesatuan prompt utuh yang dipahami dan dipatuhi oleh Web AI chatbot.
 */
function formatMessagesToPrompt(messages, tools = []) {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  // 1. Kumpulkan instruksi sistem
  const systemParts = messages
    .filter(m => m.role === "system" && m.content)
    .map(m => m.content.trim());

  // 2. Jika ada tools eksternal terdaftar, lapisi dengan instruksi ketat
  if (Array.isArray(tools) && tools.length > 0) {
    let toolDirective = "Fungsi/Tools eksternal yang tersedia:\n";
    tools.forEach((t, idx) => {
      const fn = t.function || t;
      const desc = fn.description ? ` (${fn.description})` : "";
      let params = "";
      if (fn.parameters && fn.parameters.properties) {
        params = Object.keys(fn.parameters.properties).join(", ");
      }
      toolDirective += `${idx + 1}. ${fn.name}(${params})${desc}\n`;
    });

    toolDirective += "\n[ATURAN PEMANGGILAN TOOL / FUNCTION CALLING]\n";
    toolDirective += "Jika permintaan pengguna membutuhkan informasi eksternal, cuaca, waktu, atau fungsi di atas:\n";
    toolDirective += "Anda WAJIB memanggil fungsinya dan HANYA membalas dengan blok format berikut tanpa teks pembuka/penutup lainnya:\n";
    toolDirective += "<action name=\"nama_fungsi\">{\"parameter\": \"nilai\"}</action>\n";
    toolDirective += "Contoh jika butuh fungsi get_current_weather:\n";
    toolDirective += "<action name=\"get_current_weather\">{\"location\": \"Tokyo\", \"unit\": \"celsius\"}</action>";

    systemParts.push(toolDirective);
  }

  const systemInstruction = systemParts.join("\n\n");

  // 3. Kumpulkan percakapan non-sistem
  const convo = messages.filter(m => m.role !== "system");

  // Jika tidak ada percakapan non-sistem, kirim instruksi sistem saja
  if (convo.length === 0) {
    return systemInstruction;
  }

  // Kasus umum: 1 pesan user (dengan atau tanpa system prompt / tools)
  if (convo.length === 1 && convo[0].role === "user") {
    const userPrompt = (convo[0].content || "").trim();
    if (systemInstruction) {
      return `(Petunjuk / System Directive: ${systemInstruction})\n\n${userPrompt}`;
    }
    return userPrompt;
  }

  // Kasus multi-turn conversation (bisa mencakup role: "tool" hasil eksekusi fungsi)
  let promptBuilder = "";
  if (systemInstruction) {
    promptBuilder += `(Petunjuk / System Directive: ${systemInstruction})\n\n`;
  }

  promptBuilder += "[Riwayat Percakapan]\n";
  for (let i = 0; i < convo.length - 1; i++) {
    const msg = convo[i];
    if (msg.role === "tool") {
      const toolId = msg.name || msg.tool_call_id || "eksternal";
      promptBuilder += `[Hasil Eksekusi Tool (${toolId})]:\n${(msg.content || "").trim()}\n\n`;
    } else if (msg.role === "assistant") {
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const callsStr = msg.tool_calls.map(tc => `${tc.function?.name || tc.name}(${tc.function?.arguments || JSON.stringify(tc.arguments || {})})`).join(", ");
        promptBuilder += `Assistant [Memanggil Tool: ${callsStr}]\n\n`;
      } else {
        promptBuilder += `Assistant: ${(msg.content || "").trim()}\n\n`;
      }
    } else {
      promptBuilder += `User: ${(msg.content || "").trim()}\n\n`;
    }
  }

  const lastMsg = convo[convo.length - 1];
  if (lastMsg.role === "tool") {
    const toolId = lastMsg.name || lastMsg.tool_call_id || "eksternal";
    promptBuilder += `[Hasil Eksekusi Tool (${toolId})]:\n${(lastMsg.content || "").trim()}\n\nJawablah permintaan awal pengguna berdasarkan hasil tool di atas:`;
  } else {
    promptBuilder += "[Permintaan Pengguna Saat Ini]\n";
    promptBuilder += `${(lastMsg.content || "").trim()}`;
  }

  const finalPrompt = promptBuilder.trim();
  return stripInboundMeta(finalPrompt);
}

/**
 * Membersihkan blok metadata sistem/inbound yang tidak perlu agar AI chatbot
 * web tidak terdistraksi atau mengalami halusinasi.
 */
function stripInboundMeta(text) {
  if (!text) return "";
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/(?:Conversation info|Sender|Thread starter|Replied message|Forwarded message context|Chat history since last reply)\s*\(untrusted[^)]*\):\s*```json\n[\s\S]*?```\s*/g, "")
    .replace(/`json\{[^`]*\}`\s*/g, "")
    .replace(/\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?:\s+GMT[+-]\d+)?\]\s*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================
//  REQUEST DISPATCH & QUEUE MANAGEMENT (MULTI-TAB)
// ============================================================

// ============================================================
//  NATIVE TYPING VIA CHROME DEVTOOLS PROTOCOL (CDP)
// ============================================================

/**
 * Menggunakan Chrome DevTools Protocol (CDP) via chrome.debugger untuk menyuntikkan
 * pengetikan teks dan penekanan tombol Enter tingkat hardware asli (isTrusted: true).
 * Bypasses all React Lexical / ProseMirror synthetic event barriers!
 * Catatan: Fungsi ini TIDAK me-restore tab. Tab tetap aktif selama generasi!
 */
async function nativeTypeAndSend(tabId, text, modelConfig) {
  const debuggee = { tabId };
  let attached = false;

  try {
    // 1. Minta content script fokus ke input box terlebih dahulu & ambil initialCount
    const focusRes = await chrome.tabs.sendMessage(tabId, {
      type: "focusInput",
      modelConfig
    }).catch(() => null);

    await new Promise(r => setTimeout(r, 200));

    // 2. Attach Chrome Debugger
    await chrome.debugger.attach(debuggee, "1.3");
    attached = true;

    // 3. Ketikkan teks menggunakan Input.insertText (native keyboard event)
    await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text });
    
    // Jeda 450ms agar React Lexical / ProseMirror selesai memproses state internal
    await new Promise(r => setTimeout(r, 450));

    // 4. Tekan tombol Enter menggunakan Input.dispatchKeyEvent standar keyboard hardware
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      macCharCode: 13,
      text: "\r",
      unmodifiedText: "\r"
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });

    // Jeda singkat agar DOM React/Lexical memproses penekanan tombol Enter
    await new Promise(r => setTimeout(r, 300));

    console.log(`[ZeroLLM CDP] Successfully typed and pressed Enter via Chrome Debugger on tab #${tabId}`);
    return {
      success: true,
      initialCount: focusRes?.initialCount || 0,
      initialText: focusRes?.initialText || ""
    };
  } catch (err) {
    console.warn("[ZeroLLM CDP] nativeTypeAndSend fallback to DOM:", err.message);
    return { success: false };
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(debuggee);
      } catch (e) {}
    }
  }
}

// ============================================================
//  REQUEST DISPATCH & QUEUE MANAGEMENT (SEQUENTIAL TAB LOCK)
// ============================================================

async function handleBridgeMessage(msg) {
  if (msg.type === "ping") {
    sendToBridge({ type: "pong" });
    return;
  }

  if (msg.type === "completionRequest" || msg.type === "responsesRequest") {
    const req = msg.request || {};
    const modelId = req.model;
    const modelConfig = models.find(m => m.id === modelId && m.enabled !== false);

    if (!modelConfig) {
      sendToBridge({
        type: "streamError",
        requestId: msg.requestId,
        error: `Model '${modelId}' is not registered or enabled in ZeroLLM extension`
      });
      return;
    }

    let query = "";
    if (req.messages && Array.isArray(req.messages)) {
      query = formatMessagesToPrompt(req.messages, req.tools);
    } else if (typeof req.prompt === "string") {
      query = req.prompt;
    } else if (typeof req.input === "string") {
      query = req.input;
    }

    const taskItem = {
      requestId: msg.requestId,
      modelConfig,
      query,
      stream: req.stream !== false
    };

    if (executionMode === "parallel") {
      // MODE PARALEL (MULTI-WINDOW): Setiap model berjalan serentak di jendela khususnya masing-masing!
      if (!modelQueues.has(modelId)) {
        modelQueues.set(modelId, []);
      }
      modelQueues.get(modelId).push(taskItem);
      processParallelModelQueue(modelId);
    } else {
      // MODE SEQUENTIAL (SINGLE-WINDOW): Antrean tertib bergantian, 1 tab aktif terkunci sampai selesai
      globalQueue.push(taskItem);
      processGlobalQueue();
    }
  }
}

/**
 * Pemrosesan antrean per-model untuk Mode Paralel Multi-Window
 * ChatGPT dan ChatSmith dapat merespon serentak secara bersamaan tanpa saling menunggu!
 */
async function processParallelModelQueue(modelId) {
  if (isProcessingModel.get(modelId)) return;
  const queue = modelQueues.get(modelId);
  if (!queue || queue.length === 0) return;

  isProcessingModel.set(modelId, true);
  const task = queue.shift();
  let targetTabId = null;

  try {
    // 1. Dapatkan tab pada dedicated window untuk model ini
    const tab = await getTabForModel(task.modelConfig);
    if (!tab) {
      throw new Error(`Could not find or open dedicated window/tab for model '${task.modelConfig.id}'`);
    }
    targetTabId = tab.id;

    // 2. Pastikan tab aktif di window miliknya
    await chrome.tabs.update(targetTabId, { active: true }).catch(() => {});

    // 3. Sambungkan kembali content script jika perlu
    await ensureContentScript(targetTabId);

    // 4. Eksekusi prompt dan TUNGGU hingga respon model ini selesai
    await new Promise(async (resolve, reject) => {
      const timeoutMs = 120000;
      const timer = setTimeout(() => {
        activeRequests.delete(task.requestId);
        reject(new Error(`Timeout waiting for AI response from model '${task.modelConfig.id}' after 120s`));
      }, timeoutMs);

      activeRequests.set(task.requestId, {
        task,
        targetTabId,
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      try {
        const cdpResult = await nativeTypeAndSend(targetTabId, task.query, task.modelConfig);
        if (cdpResult.success) {
          await chrome.tabs.sendMessage(targetTabId, {
            type: "waitForResponse",
            requestId: task.requestId,
            modelConfig: task.modelConfig,
            query: task.query,
            stream: task.stream,
            initialCount: cdpResult.initialCount,
            initialText: cdpResult.initialText
          });
        } else {
          await chrome.tabs.sendMessage(targetTabId, {
            type: "executePrompt",
            requestId: task.requestId,
            modelConfig: task.modelConfig,
            query: task.query,
            stream: task.stream
          });
        }
      } catch (err) {
        clearTimeout(timer);
        activeRequests.delete(task.requestId);
        reject(err);
      }
    });

  } catch (err) {
    console.error(`[ZeroLLM Parallel] Error processing model ${modelId}:`, err);
    sendToBridge({
      type: "streamError",
      requestId: task.requestId,
      error: err.message || "Failed to process prompt"
    });
  } finally {
    activeRequests.delete(task.requestId);
    isProcessingModel.set(modelId, false);

    // Lanjutkan memproses antrean berikutnya untuk model ini jika ada
    if (queue && queue.length > 0) {
      processParallelModelQueue(modelId);
    }
  }
}

async function processGlobalQueue() {
  if (isProcessingGlobalQueue) return;
  if (globalQueue.length === 0) return;

  isProcessingGlobalQueue = true;
  const task = globalQueue.shift();

  let originalTabId = null;
  let targetTabId = null;

  try {
    // 1. Dapatkan atau buka tab otomatis untuk model
    const tab = await getTabForModel(task.modelConfig);
    if (!tab) {
      throw new Error(`Could not find or open tab for model '${task.modelConfig.id}' (${task.modelConfig.urlPattern})`);
    }
    targetTabId = tab.id;

    // 2. Cek tab aktif saat ini.
    // Jika bukan tab target, beralih fokus ke tab target agar AI (khususnya ChatGPT) tidak dibekukan (throttled) oleh browser!
    const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (currentActive && currentActive.id !== targetTabId) {
      originalTabId = currentActive.id;
      console.log(`[ZeroLLM TabLock] Switching active tab from #${originalTabId} to target tab #${targetTabId} for model ${task.modelConfig.id}`);
      await chrome.tabs.update(targetTabId, { active: true });
      await new Promise(r => setTimeout(r, 250));
    }

    // 3. Sambungkan kembali content script jika perlu
    await ensureContentScript(targetTabId);

    // 4. Eksekusi prompt dan TUNGGU hingga generasi respon SELESAI
    await new Promise(async (resolve, reject) => {
      const timeoutMs = 120000; // 2 menit timeout keamanan
      const timer = setTimeout(() => {
        activeRequests.delete(task.requestId);
        reject(new Error(`Timeout waiting for AI response from model '${task.modelConfig.id}' after 120s`));
      }, timeoutMs);

      activeRequests.set(task.requestId, {
        task,
        targetTabId,
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      try {
        // Coba ketik secara native via Chrome Debugger (CDP)
        const cdpResult = await nativeTypeAndSend(targetTabId, task.query, task.modelConfig);

        if (cdpResult.success) {
          // Observasi DOM
          await chrome.tabs.sendMessage(targetTabId, {
            type: "waitForResponse",
            requestId: task.requestId,
            modelConfig: task.modelConfig,
            query: task.query,
            stream: task.stream,
            initialCount: cdpResult.initialCount,
            initialText: cdpResult.initialText
          });
        } else {
          // Fallback DOM typing
          await chrome.tabs.sendMessage(targetTabId, {
            type: "executePrompt",
            requestId: task.requestId,
            modelConfig: task.modelConfig,
            query: task.query,
            stream: task.stream
          });
        }
      } catch (err) {
        clearTimeout(timer);
        activeRequests.delete(task.requestId);
        reject(err);
      }
    });

  } catch (err) {
    console.error(`[ZeroLLM] Error processing task ${task.requestId}:`, err);
    sendToBridge({
      type: "streamError",
      requestId: task.requestId,
      error: err.message || "Failed to process prompt"
    });
  } finally {
    activeRequests.delete(task.requestId);

    // 5. Kembalikan tab ke originalTabId HANYA jika antrean sudah selesai (kosong)!
    // Jika masih ada request berikutnya di antrean, tab model berikutnya akan langsung diaktifkan
    if (globalQueue.length === 0 && originalTabId) {
      try {
        await new Promise(r => setTimeout(r, 600));
        console.log(`[ZeroLLM TabLock] Generation complete. Restoring focus back to tab #${originalTabId}`);
        await chrome.tabs.update(originalTabId, { active: true });
      } catch (e) {}
    }

    isProcessingGlobalQueue = false;

    // Lanjutkan memproses antrean berikutnya jika ada
    if (globalQueue.length > 0) {
      processGlobalQueue();
    }
  }
}

// ============================================================
//  MESSAGE HANDLING FROM POPUP / CONTENT SCRIPT
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // Forwarded from content script to Cloudflare Worker
    case "stream":
      sendToBridge({ type: "stream", requestId: msg.requestId, delta: msg.delta });
      break;
    case "response": {
      const toolCalls = parseToolCalls(msg.content);
      if (toolCalls && toolCalls.length > 0) {
        console.log(`[ZeroLLM ToolCalls] Detected ${toolCalls.length} tool calls in response:`, toolCalls);
        sendToBridge({
          type: "response",
          requestId: msg.requestId,
          content: null,
          tool_calls: toolCalls,
          finish_reason: "tool_calls",
          usage: msg.usage
        });
      } else {
        sendToBridge({
          type: "response",
          requestId: msg.requestId,
          content: msg.content,
          finish_reason: "stop",
          usage: msg.usage
        });
      }

      // Beritahu queue processor bahwa generasi telah selesai tuntas
      const active = activeRequests.get(msg.requestId);
      if (active) {
        active.resolve(msg);
      }
      break;
    }
    case "streamError": {
      sendToBridge({ type: "streamError", requestId: msg.requestId, error: msg.error });
      const active = activeRequests.get(msg.requestId);
      if (active) {
        active.reject(new Error(msg.error));
      }
      break;
    }

    case "getState":
      sendResponse({
        connectionState,
        bridgeUrl,
        roomId,
        apiKey,
        models,
        executionMode
      });
      break;

    case "setExecutionMode":
      executionMode = msg.mode;
      chrome.storage.local.set({ executionMode });
      broadcastState();
      sendResponse({ success: true, executionMode });
      break;

    case "connect":
      connectBridge(msg.url, msg.room, msg.apiKey);
      break;

    case "disconnect":
      disconnectBridge();
      break;

    case "saveModels":
      models = msg.models;
      chrome.storage.local.set({ customModels: models });
      syncModelsToBridge();
      broadcastState();
      sendResponse({ success: true });
      break;
  }
  return true;
});

function broadcastState() {
  chrome.runtime.sendMessage({
    type: "stateUpdate",
    state: {
      connectionState,
      bridgeUrl,
      roomId,
      apiKey,
      models,
      executionMode
    }
  }).catch(() => {});
}

// Auto-start on load & Auto-attach tabs
loadModels().then(async () => {
  await autoAttachExistingTabs();
  if (bridgeUrl && roomId) {
    connectBridge(bridgeUrl, roomId, apiKey);
  }
});
