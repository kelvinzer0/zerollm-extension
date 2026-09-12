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
// Active Model -> Tab ID mapping: Map<modelId, tabId>
const modelTabMap = new Map();
// Model Queue: Map<modelId, Array<pendingRequest>>
const modelQueues = new Map();
const isProcessingTab = new Map();

// ============================================================
//  STORAGE & INITIALIZATION
// ============================================================

async function loadModels() {
  const data = await chrome.storage.local.get(["customModels", "bridgeUrl", "roomId", "apiKey"]);
  if (data.customModels && Array.isArray(data.customModels) && data.customModels.length > 0) {
    models = data.customModels;
  } else {
    models = [...DEFAULT_PRESETS];
    await chrome.storage.local.set({ customModels: models });
  }

  if (data.bridgeUrl) bridgeUrl = data.bridgeUrl;
  if (data.roomId) roomId = data.roomId;
  if (data.apiKey) apiKey = data.apiKey;
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
 * Mencari tab yang cocok atau OTOMATIS MEMBUKA TAB BARU jika belum terbuka
 */
async function getTabForModel(modelConfig) {
  const patternRegex = wildcardToRegExp(modelConfig.urlPattern);

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
  let targetUrl = modelConfig.urlPattern.replace(/\*/g, "");
  if (!targetUrl.startsWith("http")) {
    targetUrl = "https://" + targetUrl.replace(/^\/+/, "");
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
//  REQUEST DISPATCH & QUEUE MANAGEMENT (MULTI-TAB)
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

/**
 * Mengonversi array pesan OpenAI (termasuk role: system, assistant, user)
 * menjadi satu kesatuan prompt utuh yang dipahami dan dipatuhi oleh Web AI chatbot.
 */
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

  // 2. Jika ada tools eksternal terdaftar, lapisi dengan format tindakan aman bebas konflik
  if (Array.isArray(tools) && tools.length > 0) {
    let toolDirective = "Fungsi tindakan eksternal yang tersedia:\n";
    tools.forEach((t, idx) => {
      const fn = t.function || t;
      const desc = fn.description ? ` (${fn.description})` : "";
      let params = "";
      if (fn.parameters && fn.parameters.properties) {
        params = Object.keys(fn.parameters.properties).join(", ");
      }
      toolDirective += `${idx + 1}. ${fn.name}(${params})${desc}\n`;
    });

    toolDirective += "\nAturan Pemanggilan Tindakan:\n";
    toolDirective += "Jika Anda membutuhkan fungsi di atas untuk menjawab permintaan pengguna, balas HANYA dengan format tindakan berikut:\n";
    toolDirective += "<action name=\"nama_fungsi\">{\"parameter\": \"nilai\"}</action>\n";
    toolDirective += "Jika tidak memerlukan fungsi, berikan jawaban langsung seperti biasa.";

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

  return promptBuilder.trim();
}

    let query = "";
    if (req.messages && Array.isArray(req.messages)) {
      query = formatMessagesToPrompt(req.messages, req.tools);
    } else if (typeof req.prompt === "string") {
      query = req.prompt;
    } else if (typeof req.input === "string") {
      query = req.input;
    }

    if (!modelQueues.has(modelId)) {
      modelQueues.set(modelId, []);
    }
    modelQueues.get(modelId).push({
      requestId: msg.requestId,
      modelConfig,
      query,
      stream: req.stream !== false
    });

    processModelQueue(modelId);
  }
}

async function processModelQueue(modelId) {
  if (isProcessingTab.get(modelId)) return;
  const queue = modelQueues.get(modelId);
  if (!queue || queue.length === 0) return;

/**
 * Menggunakan Chrome DevTools Protocol (CDP) via chrome.debugger untuk menyuntikkan
 * pengetikan teks dan penekanan tombol Enter tingkat hardware asli (isTrusted: true).
 * Bypasses all React Lexical / ProseMirror synthetic event barriers!
 */
async function nativeTypeAndSend(tabId, text, modelConfig) {
  const debuggee = { tabId };
  let attached = false;
  let originalTabId = null;

  try {
    // 0. Auto-Switch: Cek tab aktif saat ini. Jika berbeda dengan tab target, beralih sementara
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (activeTab && activeTab.id !== tabId) {
      originalTabId = activeTab.id;
      console.log(`[ZeroLLM AutoSwitch] Switching focus from tab #${originalTabId} to #${tabId} for native typing...`);
      await chrome.tabs.update(tabId, { active: true });
      await new Promise(r => setTimeout(r, 200));
    }

    // 1. Minta content script fokus ke input box terlebih dahulu & ambil initialCount
    const focusRes = await chrome.tabs.sendMessage(tabId, {
      type: "focusInput",
      modelConfig
    }).catch(() => null);

    await new Promise(r => setTimeout(r, 150));

    // 2. Attach Chrome Debugger
    await chrome.debugger.attach(debuggee, "1.3");
    attached = true;

    // 3. Ketikkan teks menggunakan Input.insertText (native keyboard event)
    await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text });
    await new Promise(r => setTimeout(r, 150));

    // 4. Tekan tombol Enter menggunakan Input.dispatchKeyEvent (rawKeyDown + keyUp)
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      windowsVirtualKeyCode: 13,
      unmodifiedText: "\r",
      text: "\r"
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 13,
      unmodifiedText: "\r",
      text: "\r"
    });

    // 4b. Cadangan klik tombol submit jika masih aktif
    await new Promise(r => setTimeout(r, 100));
    await chrome.tabs.sendMessage(tabId, { type: "clickSubmitIfActive", modelConfig }).catch(() => {});

    console.log(`[ZeroLLM CDP] Successfully typed and pressed Enter via Chrome Debugger on tab #${tabId}`);
    return { success: true, initialCount: focusRes?.initialCount || 0 };
  } catch (err) {
    console.warn("[ZeroLLM CDP] nativeTypeAndSend fallback to DOM:", err.message);
    return { success: false };
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(debuggee);
      } catch (e) {}
    }

    // 5. Restore fokus ke tab awal setelah jeda aman (2.5 detik) agar proses submit selesai
    if (originalTabId) {
      setTimeout(async () => {
        try {
          console.log(`[ZeroLLM AutoSwitch] Restoring focus back to tab #${originalTabId}`);
          await chrome.tabs.update(originalTabId, { active: true });
        } catch (e) {}
      }, 2500);
    }
  }
}

  isProcessingTab.set(modelId, true);
  const task = queue.shift();

  try {
    // 1. Dapatkan atau buka tab otomatis
    const tab = await getTabForModel(task.modelConfig);
    if (!tab) {
      throw new Error(`Could not find or open tab for model '${modelId}' (${task.modelConfig.urlPattern})`);
    }

    // 2. Sambungkan kembali content script jika baru di-reload
    await ensureContentScript(tab.id);

    // 3. Coba ketik & kirim secara native via Chrome Debugger (CDP)
    const cdpResult = await nativeTypeAndSend(tab.id, task.query, task.modelConfig);

    if (cdpResult.success) {
      // 4a. Jika sukses via CDP, mulai observasi respon dari DOM
      await chrome.tabs.sendMessage(tab.id, {
        type: "waitForResponse",
        requestId: task.requestId,
        modelConfig: task.modelConfig,
        query: task.query,
        stream: task.stream,
        initialCount: cdpResult.initialCount
      });
    } else {
      // 4b. Fallback: Eksekusi pengetikan dan submit via content script biasa
      await chrome.tabs.sendMessage(tab.id, {
        type: "executePrompt",
        requestId: task.requestId,
        modelConfig: task.modelConfig,
        query: task.query,
        stream: task.stream
      });
    }
  } catch (err) {
    console.error("[ZeroLLM] processModelQueue error:", err);
    sendToBridge({
      type: "streamError",
      requestId: task.requestId,
      error: err.message
    });
  } finally {
    isProcessingTab.set(modelId, false);
    if (queue && queue.length > 0) {
      processModelQueue(modelId);
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
      break;
    }
    case "streamError":
      sendToBridge({ type: "streamError", requestId: msg.requestId, error: msg.error });
      break;

    case "getState":
      sendResponse({
        connectionState,
        bridgeUrl,
        roomId,
        apiKey,
        models
      });
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
      models
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
