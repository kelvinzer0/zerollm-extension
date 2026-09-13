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
let executionMode = "parallel";

// Active Model -> Tab ID mapping: Map<modelId, tabId>
const modelTabMap = new Map();
// Model -> Window ID mapping: Map<modelId, windowId>
const modelWindowMap = new Map();
// Dedicated Worker Windows set: Set<windowId>
const dedicatedWindows = new Set();
// Active Tab Workers map (tracks currently busy tabs): Map<tabId, { requestId, modelId, startTime }>
const activeTabWorkers = new Map();
// Atomic Reserved Tab IDs: Set<tabId> (locked synchronously to prevent race conditions)
const reservedTabs = new Set();
// Concurrency limit per model in worker pool
const MAX_CONCURRENT_WORKERS_PER_MODEL = 3;
// Pending tasks waiting for an available worker in parallel mode
const pendingParallelTasks = [];

// ============================================================
//  IN-MEMORY RESPONSE CACHE (INSTANT 10ms RESPONSES)
// ============================================================
const responseCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 menit TTL

function getCacheKey(modelId, query) {
  return `${modelId}:::${(query || "").trim()}`;
}

function getFromCache(modelId, query) {
  const key = getCacheKey(modelId, query);
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return cached;
}

function saveToCache(modelId, query, result) {
  if (!query || !result) return;
  const key = getCacheKey(modelId, query);
  responseCache.set(key, {
    content: result.content,
    tool_calls: result.tool_calls,
    finish_reason: result.finish_reason || "stop",
    usage: result.usage,
    timestamp: Date.now()
  });
  if (responseCache.size > 200) {
    const firstKey = responseCache.keys().next().value;
    responseCache.delete(firstKey);
  }
}

// Sequential Single-Window FIFO Queue
const globalQueue = [];
let isProcessingGlobalQueue = false;

// Map request aktif: Map<requestId, { resolve, reject, task, targetTabId, originalTabId }>
const activeRequests = new Map();

// ============================================================
//  STORAGE & INITIALIZATION
// ============================================================

async function loadModels() {
  const data = await chrome.storage.local.get(["customModels", "bridgeUrl", "roomId", "apiKey", "executionMode"]);
  if (data.customModels && Array.isArray(data.customModels) && data.customModels.length > 0) {
    // Preserve custom models & user preferences, but update official preset selectors and append new presets
    const existingIds = new Set(data.customModels.map(m => m.id));
    let updatedModels = data.customModels.map(m => {
      const defaultPreset = DEFAULT_PRESETS.find(p => p.id === m.id);
      if (defaultPreset) {
        // Sync selectors and URLs with latest official updates while preserving user enabled preference
        return {
          ...defaultPreset,
          enabled: m.enabled !== undefined ? m.enabled : defaultPreset.enabled
        };
      }
      return m;
    });

    for (const preset of DEFAULT_PRESETS) {
      if (!existingIds.has(preset.id)) {
        updatedModels.push({ ...preset });
      }
    }

    models = updatedModels;
    await chrome.storage.local.set({ customModels: models });
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
 * ATOMIC PRE-WARMED WORKER POOL ACQUISITION
 * Mencari tab idle dan LANGSUNG mengunci (lock) secara sinkron sebelum proses async apapun.
 */
async function acquireWorkerTab(modelConfig) {
  const patternRegex = wildcardToRegExp(modelConfig.urlPattern);

  // 1. Cari tab yang cocok dan saat ini IDLE di semua jendela Chrome
  const allWindows = await chrome.windows.getAll({ populate: true }).catch(() => []);
  
  for (const w of allWindows) {
    if (w.tabs) {
      for (const tab of w.tabs) {
        if (tab.url && patternRegex.test(tab.url)) {
          // ATOMIC SYNCHRONOUS LOCK: Cek reservedTabs dan activeTabWorkers
          if (!reservedTabs.has(tab.id) && !activeTabWorkers.has(tab.id)) {
            reservedTabs.add(tab.id); // Langsung kunci secara atomik!
            dedicatedWindows.add(w.id);
            modelTabMap.set(modelConfig.id, tab.id);
            modelWindowMap.set(modelConfig.id, w.id);
            return tab;
          }
        }
      }
    }
  }

  // 2. Hitung jumlah worker aktif untuk model ini
  let currentModelWorkers = 0;
  for (const [tabId, info] of activeTabWorkers.entries()) {
    if (info.modelId === modelConfig.id) currentModelWorkers++;
  }

  // 3. Jika belum mencapai batas max worker per model: Buat Dedicated Worker Window Baru
  if (currentModelWorkers < MAX_CONCURRENT_WORKERS_PER_MODEL) {
    console.log(`[ZeroLLM Pool] Spawning Pre-warmed Worker #${currentModelWorkers + 1} for '${modelConfig.id}'...`);
    let targetUrl = modelConfig.defaultUrl;
    if (!targetUrl) {
      targetUrl = modelConfig.urlPattern.replace(/^\*:\/\//, "https://").replace(/\*+/g, "");
      if (!targetUrl.startsWith("http")) {
        targetUrl = "https://" + targetUrl.replace(/^[:\/]+/, "");
      }
    }

    const newWin = await chrome.windows.create({
      url: targetUrl,
      type: "normal",
      width: 960,
      height: 720,
      focused: true
    });

    const createdTab = newWin.tabs?.[0];
    if (createdTab) {
      reservedTabs.add(createdTab.id); // Langsung kunci secara atomik!
      if (newWin.id) {
        dedicatedWindows.add(newWin.id);
        modelWindowMap.set(modelConfig.id, newWin.id);
      }
      modelTabMap.set(modelConfig.id, createdTab.id);

      await new Promise(resolve => {
        const listener = (tabId, info) => {
          if (tabId === createdTab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 10000);
      });

      return createdTab;
    }
  }

  return null;
}

function releaseWorkerTab(tabId) {
  if (tabId) {
    reservedTabs.delete(tabId);
    activeTabWorkers.delete(tabId);
  }
  dispatchNextPendingParallelTask();
}

function dispatchNextPendingParallelTask() {
  if (pendingParallelTasks.length === 0) return;
  const nextTask = pendingParallelTasks.shift();
  if (nextTask) {
    executeParallelTask(nextTask);
  }
}

/**
 * Mencari tab yang cocok atau OTOMATIS MEMBUKA TAB/WINDOW BARU jika belum terbuka
 */
async function getTabForModel(modelConfig) {
  const patternRegex = wildcardToRegExp(modelConfig.urlPattern);

  // ── MODE PARALEL (MULTI-WINDOW) ──────────────────────────────
  if (executionMode === "parallel") {
    return acquireWorkerTab(modelConfig);
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
    targetUrl = modelConfig.urlPattern.replace(/^\*:\/\//, "https://").replace(/\*+/g, "");
    if (!targetUrl.startsWith("http")) {
      targetUrl = "https://" + targetUrl.replace(/^[:\/]+/, "");
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
 * Menunggu hingga tab selesai dimuat sepenuhnya (status === 'complete')
 * Mencegah pengiriman prompt saat halaman web masih dalam proses loading / navigating!
 */
async function waitForTabComplete(tabId, maxWaitMs = 15000) {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === "complete") {
      return true;
    }
  } catch (e) {
    return false;
  }

  console.log(`[ZeroLLM] Tab #${tabId} is currently loading. Waiting for page load to finish...`);

  return new Promise(resolve => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        console.log(`[ZeroLLM] Tab #${tabId} load wait timeout after ${maxWaitMs}ms, proceeding...`);
        resolve(false);
      }
    }, maxWaitMs);

    const listener = (tid, changeInfo) => {
      if (tid === tabId && changeInfo.status === "complete") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          console.log(`[ZeroLLM] Tab #${tabId} finished loading!`);
          resolve(true);
        }
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
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

      // Mulai heartbeat keepalive aktif setiap 5 detik agar Service Worker MV3 tidak pernah dihentikan Chrome
      clearInterval(pingInterval);
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
          // Touching Chrome API resets the MV3 30-second service worker idle timer
          try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) {}
        }
      }, 5000);
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
      }, 1000);
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

  // Pola 1 (Utama ZeroLLM): <zerollm_tool_call name="...">...</zerollm_tool_call> atau <zerollm_call name="...">
  const tagRegex = /<(?:zerollm_tool_call|zerollm_call|zerollm:call|action|call)[^>]*?\s+name=["\x27]([\w_-]+)["\x27][^>]*>([\s\S]*?)<\/(?:zerollm_tool_call|zerollm_call|zerollm:call|action|call)>/gi;
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

  // Pola 1b: <tool_call>...</tool_call> (Mendukung JSON murni ATAU XML function/parameter bawaan model seperti Xiaomi MiMo)
  if (calls.length === 0) {
    const xmlToolRegex = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi;
    while ((match = xmlToolRegex.exec(text)) !== null) {
      const inner = match[1].trim();

      // 1b.1 Coba parsing jika isi blok <tool_call> adalah JSON
      try {
        const obj = JSON.parse(inner);
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
          continue;
        }
      } catch(e) {}

      // 1b.2 Parsing XML function & parameter (Format bawaan Xiaomi MiMo, DeepSeek, & Anthropic/Claude):
      // <function=read> atau <function name="read"> atau <invoke name="read">
      const fnMatch = inner.match(/<(?:function|invoke)(?:=|\s+name=)["\x27]?([\w_-]+)["\x27]?[^>]*>/i);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const argsObj = {};

        // Tangkap parameter: <parameter=path>value</parameter> atau <parameter=path>value
        // atau <parameter name="path">value</parameter>
        const paramRegex = /<parameter(?:=|\s+name=)["\x27]?([\w_-]+)["\x27]?[^>]*>([\s\S]*?)(?:<\/parameter>|(?=<parameter|<\/tool_call>|$))/gi;
        let pMatch;
        while ((pMatch = paramRegex.exec(inner)) !== null) {
          const key = pMatch[1];
          let val = pMatch[2].trim();
          try {
            val = JSON.parse(val);
          } catch(e) {}
          argsObj[key] = val;
        }

        calls.push({
          id: `call_${Math.random().toString(36).substring(2, 10)}`,
          type: "function",
          function: {
            name: fnName,
            arguments: JSON.stringify(argsObj)
          }
        });
      }
    }
  }

  // Fallback Pola 1b.3: Deteksi XML <function=...> langsung tanpa pembungkus <tool_call>
  if (calls.length === 0) {
    const standaloneFnRegex = /<(?:function|invoke)(?:=|\s+name=)["\x27]?([\w_-]+)["\x27]?[^>]*>([\s\S]*?)(?:<\/(?:function|invoke)>|$)/gi;
    while ((match = standaloneFnRegex.exec(text)) !== null) {
      const fnName = match[1];
      const inner = match[2].trim();
      const argsObj = {};
      const paramRegex = /<parameter(?:=|\s+name=)["\x27]?([\w_-]+)["\x27]?[^>]*>([\s\S]*?)(?:<\/parameter>|(?=<parameter|$))/gi;
      let pMatch;
      let foundParams = false;
      while ((pMatch = paramRegex.exec(inner)) !== null) {
        foundParams = true;
        const key = pMatch[1];
        let val = pMatch[2].trim();
        try { val = JSON.parse(val); } catch(e) {}
        argsObj[key] = val;
      }
      if (foundParams) {
        calls.push({
          id: `call_${Math.random().toString(36).substring(2, 10)}`,
          type: "function",
          function: {
            name: fnName,
            arguments: JSON.stringify(argsObj)
          }
        });
      }
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
 * Ekstraksi teks dari pesan content yang bisa berupa string murni,
 * array of string, array of parts [{ type: 'text', text: '...' }], atau multimodal.
 */
function extractTextContent(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
          if (part.type === "image_url" || part.type === "image") return "[Gambar]";
          if (part.type === "video_url" || part.type === "video") return "[Video]";
        }
        return String(part);
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text.trim();
    if (typeof content.content === "string") return content.content.trim();
  }
  return String(content).trim();
}

/**
 * Format messages dan tools dari format standar OpenAI Chat Completions
 * menjadi format pesan ber-tagging unik ZeroLLM (<zerollm_user>, <zerollm_assistant>, <zerollm_system>, <zerollm_tool>)
 * agar AI memahami secara presisi batas awal (start) dan akhir (end) tiap pesan.
 */
function formatMessagesToPrompt(messages, tools = []) {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  // 1. Kumpulkan instruksi sistem (termasuk role 'developer' yang dikirim AI SDK / OpenClaw)
  const systemParts = messages
    .filter(m => (m.role === "system" || m.role === "developer") && m.content)
    .map(m => extractTextContent(m.content))
    .filter(Boolean);

  const hasTools = Array.isArray(tools) && tools.length > 0;

  // 2. Jika ada tools eksternal terdaftar, lapisi dengan instruksi pemanggilan tool ZeroLLM
  if (hasTools) {
    let toolDirective = "Fungsi/Tools eksternal yang tersedia:\n";
    const isLargeToolSet = tools.length > 10;

    tools.forEach((t, idx) => {
      const fn = t.function || t;
      const desc = fn.description ? ` (${fn.description.slice(0, isLargeToolSet ? 100 : 300)}${isLargeToolSet && fn.description.length > 100 ? "..." : ""})` : "";
      let params = "";
      if (fn.parameters && fn.parameters.properties) {
        params = Object.keys(fn.parameters.properties).join(", ");
      }
      toolDirective += `${idx + 1}. ${fn.name}(${params})${desc}\n`;
    });

    toolDirective += "\n[ATURAN PEMANGGILAN TOOL - OPENAI SPEC]\n";
    toolDirective += "Jika permintaan pengguna membutuhkan informasi eksternal atau fungsi di atas:\n";
    toolDirective += "Anda WAJIB memanggil fungsinya dengan format tag resmi berikut tanpa teks pembuka/penutup lainnya:\n";
    toolDirective += '<zerollm_tool_call name="nama_fungsi">{"parameter": "nilai"}</zerollm_tool_call>\n';
    toolDirective += "Contoh:\n";
    toolDirective += '<zerollm_tool_call name="get_current_weather">{"location": "Jakarta"}</zerollm_tool_call>';

    systemParts.push(toolDirective);
  }

  const systemInstruction = systemParts.join("\n\n");

  // 3. Kumpulkan percakapan non-sistem
  const convo = messages.filter(m => m.role !== "system" && m.role !== "developer");
  const hasToolResultInHistory = convo.some(m => m.role === "tool" || m.role === "toolResult");

  // Panduan alur respons di bagian akhir (Recency Attention)
  let endGuidance = "\n\n[PANDUAN CARA MENJAWAB UNTUK AI]:\n";
  if (hasTools) {
    endGuidance += "1. Tahap 1 (Pemanggilan Tool): Jika pertanyaan pengguna membutuhkan data eksternal/fungsi di atas, JANGAN meminta maaf atau menolak dengan alasan tidak ada akses. Sistem ZeroLLM yang akan mengeksekusinya untuk Anda!\n";
    endGuidance += "   Anda WAJIB LANGSUNG membalas HANYA dengan tag pemanggilan tool:\n";
    endGuidance += '   <zerollm_tool_call name="nama_fungsi">{"parameter": "nilai"}</zerollm_tool_call>\n';
  }
  if (hasToolResultInHistory) {
    endGuidance += "2. Tahap 2 (Hasil Tool): Di dalam riwayat terdapat tag <zerollm_tool_result>. Jawablah pertanyaan awal pengguna berdasarkan data hasil tool tersebut secara langsung dan alami tanpa tag apapun.\n";
  }
  if (!hasTools && !hasToolResultInHistory) {
    endGuidance += "Jawablah permintaan pengguna di dalam <zerollm_user> terakhir secara langsung dan alami tanpa menyertakan tag <zerollm_*> apapun.";
  } else {
    endGuidance += "3. Jika pertanyaan pengguna TIDAK membutuhkan tool, jawablah langsung secara alami tanpa tag <zerollm_*> apapun.";
  }

  // Jika tidak ada percakapan non-sistem, kirim instruksi sistem saja
  if (convo.length === 0) {
    return `<zerollm_system>\n${stripInboundMeta(systemInstruction)}\n</zerollm_system>${endGuidance}`;
  }

  // Kasus 1 pesan user tunggal (tanpa riwayat multi-turn)
  if (convo.length === 1 && convo[0].role === "user") {
    const userPrompt = stripInboundMeta(extractTextContent(convo[0].content));
    let result = "";
    if (systemInstruction) {
      result = `<zerollm_system>\n${stripInboundMeta(systemInstruction)}\n</zerollm_system>\n\n<zerollm_user>\n${userPrompt}\n</zerollm_user>`;
    } else {
      result = `<zerollm_user>\n${userPrompt}\n</zerollm_user>`;
    }
    return (result + endGuidance).trim();
  }

  // Kasus multi-turn conversation (dibungkus tag awal dan akhir per giliran)
  let promptBuilder = "";
  if (systemInstruction) {
    promptBuilder += `<zerollm_system>\n${stripInboundMeta(systemInstruction)}\n</zerollm_system>\n\n`;
  }

  for (let i = 0; i < convo.length - 1; i++) {
    const msg = convo[i];
    const text = stripInboundMeta(extractTextContent(msg.content));
    if (msg.role === "tool" || msg.role === "toolResult") {
      const toolId = msg.name || msg.tool_call_id || "eksternal";
      promptBuilder += `<zerollm_tool_result name="${toolId}">\n${text}\n</zerollm_tool_result>\n\n`;
    } else if (msg.role === "assistant") {
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const callsStr = msg.tool_calls.map(tc => `<zerollm_tool_call name="${tc.function?.name || tc.name}">${tc.function?.arguments || JSON.stringify(tc.arguments || {})}</zerollm_tool_call>`).join("\n");
        promptBuilder += `<zerollm_assistant>\n${callsStr}\n</zerollm_assistant>\n\n`;
      } else {
        promptBuilder += `<zerollm_assistant>\n${text}\n</zerollm_assistant>\n\n`;
      }
    } else {
      promptBuilder += `<zerollm_user>\n${text}\n</zerollm_user>\n\n`;
    }
  }

  const lastMsg = convo[convo.length - 1];
  const lastText = stripInboundMeta(extractTextContent(lastMsg.content));
  if (lastMsg.role === "tool" || lastMsg.role === "toolResult") {
    const toolId = lastMsg.name || lastMsg.tool_call_id || "eksternal";
    promptBuilder += `<zerollm_tool_result name="${toolId}">\n${lastText}\n</zerollm_tool_result>\n\nJawablah permintaan awal pengguna berdasarkan hasil tool di atas.`;
  } else {
    promptBuilder += `<zerollm_user>\n${lastText}\n</zerollm_user>`;
  }

  promptBuilder += endGuidance;
  return promptBuilder.trim();
}

/**
 * Membersihkan karakter non-printable tak terlihat tanpa menghapus
 * metadata mesin asli milik OpenClaw agar alur kerja OpenClaw tetap utuh.
 */
function stripInboundMeta(text) {
  if (!text) return "";
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

/**
 * Membersihkan tag pembungkus <zerollm_assistant>...</zerollm_assistant>
 * dari balasan jika model ikut memuntahkan tag tersebut.
 */
function stripZeroLlmTags(content) {
  if (!content || typeof content !== "string") return content;
  return content
    .replace(/^<zerollm_assistant>\s*/i, "")
    .replace(/\s*<\/zerollm_assistant>$/i, "")
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
    // 1. Minta content script fokus ke input box DAN langsung ketik teks via enterPrompt
    //    Ini mengatasi masalah ProseMirror (ChatGPT) yang kehilangan fokus saat CDP digunakan
    const focusRes = await chrome.tabs.sendMessage(tabId, {
      type: "focusInput",
      modelConfig,
      query: text  // Kirim teks langsung agar content.js ketik via enterPrompt
    }).catch(() => null);

    // Jika content.js sudah mengetik langsung (directTyped), skip CDP sepenuhnya
    if (focusRes?.directTyped) {
      console.log(`[ZeroLLM CDP] Text typed directly by content.js enterPrompt (bypassed CDP) on tab #${tabId}`);
      return {
        success: true,
        initialCount: focusRes?.initialCount || 0,
        initialText: focusRes?.initialText || ""
      };
    }

    await new Promise(r => setTimeout(r, 200));

    // 2. Fallback: Attach Chrome Debugger untuk mengetik via CDP
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

    // Pastikan tombol Kirim/Submit terklik jika Enter hardware tidak otomatis men-submit
    await chrome.tabs.sendMessage(tabId, {
      type: "clickSubmitIfActive",
      modelConfig
    }).catch(() => {});

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
    const rawModelId = typeof req.model === "string" ? req.model.trim() : "";
    const cleanModelId = rawModelId.includes("/") ? rawModelId.split("/").pop().trim().toLowerCase() : rawModelId.toLowerCase();

    // Cari model berdasarkan exact match atau clean/stripped prefix match
    const modelConfig = models.find(m => {
      if (m.enabled === false) return false;
      if (m.id === rawModelId) return true;
      const mIdClean = (m.id || "").toLowerCase();
      return mIdClean === cleanModelId || mIdClean === rawModelId.toLowerCase();
    });

    if (!modelConfig) {
      sendToBridge({
        type: "streamError",
        requestId: msg.requestId,
        error: `Model '${rawModelId}' is not registered or enabled in ZeroLLM extension`
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

    // ── CEK IN-MEMORY CACHE (INSTANT 10ms RESPONSE) ──
    const cached = getFromCache(modelConfig.id, query);
    if (cached) {
      console.log(`[ZeroLLM Cache] ⚡ Cache HIT for model '${modelConfig.id}' (0ms frontend latency)`);
      if (req.stream !== false && cached.content) {
        sendToBridge({
          type: "stream",
          requestId: msg.requestId,
          delta: { content: cached.content }
        });
      }
      sendToBridge({
        type: "response",
        requestId: msg.requestId,
        content: cached.content,
        tool_calls: cached.tool_calls,
        finish_reason: cached.finish_reason || "stop",
        usage: cached.usage
      });
      return;
    }

    const taskItem = {
      requestId: msg.requestId,
      modelConfig,
      query,
      stream: req.stream !== false
    };

    if (executionMode === "parallel") {
      // TRUE MULTI-WINDOW PARALLEL: Eksekusi serentak via Atomic Pre-warmed Worker Pool!
      executeParallelTask(taskItem);
    } else {
      // MODE SEQUENTIAL (SINGLE-WINDOW): Antrean tertib bergantian, 1 tab aktif terkunci sampai selesai
      globalQueue.push(taskItem);
      processGlobalQueue();
    }
  }
}

/**
 * TRUE MULTI-WINDOW PARALLEL DISPATCHER
 * Setiap request dialokasikan ke dedicated tab/window aktif dan berjalan serentak 100%
 */
async function executeParallelTask(task) {
  let targetTabId = null;

  try {
    // 1. Dapatkan tab pada dedicated window untuk model ini secara atomik
    const tab = await acquireWorkerTab(task.modelConfig);
    if (!tab || !tab.id) {
      // Jika semua max concurrent workers sedang sibuk, antrekan ke pending queue
      pendingParallelTasks.push(task);
      return;
    }
    targetTabId = tab.id;

    // Tandai tab ini sedang aktif memproses requestId ini
    activeTabWorkers.set(targetTabId, {
      requestId: task.requestId,
      modelId: task.modelConfig.id,
      startTime: Date.now()
    });

    // 2. Pastikan tab aktif di window miliknya
    await chrome.tabs.update(targetTabId, { active: true }).catch(() => {});

    // Tunggu tab selesai dimuat sepenuhnya sebelum menyuntikkan prompt
    await waitForTabComplete(targetTabId, 15000);
    await new Promise(r => setTimeout(r, 400));

    // 3. Sambungkan kembali content script jika perlu
    await ensureContentScript(targetTabId);

    // 4. Eksekusi prompt dan TUNGGU hingga respon model ini selesai
    await new Promise(async (resolve, reject) => {
      const timeoutMs = 300000; // 5 menit timeout untuk deep reasoning / long research
      const timer = setTimeout(() => {
        activeRequests.delete(task.requestId);
        reject(new Error(`Timeout waiting for AI response from model '${task.modelConfig.id}' after 300s`));
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
    console.error(`[ZeroLLM Parallel] Error processing task ${task.requestId} for model ${task.modelConfig.id}:`, err);
    sendToBridge({
      type: "streamError",
      requestId: task.requestId,
      error: err.message || "Failed to process prompt"
    });
  } finally {
    activeRequests.delete(task.requestId);
    if (targetTabId) {
      releaseWorkerTab(targetTabId);
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

    // Tunggu tab selesai dimuat sepenuhnya sebelum menyuntikkan prompt
    await waitForTabComplete(targetTabId, 15000);
    await new Promise(r => setTimeout(r, 600));

    // 3. Sambungkan kembali content script jika perlu
    await ensureContentScript(targetTabId);

    // 4. Eksekusi prompt dan TUNGGU hingga generasi respon SELESAI
    await new Promise(async (resolve, reject) => {
      const timeoutMs = 300000; // 5 menit timeout untuk deep reasoning / long research
      const timer = setTimeout(() => {
        activeRequests.delete(task.requestId);
        reject(new Error(`Timeout waiting for AI response from model '${task.modelConfig.id}' after 300s`));
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
      const cleanContent = stripZeroLlmTags(msg.content);
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
          content: cleanContent,
          finish_reason: "stop",
          usage: msg.usage
        });
      }

      // Simpan ke in-memory cache jika query tersedia
      const active = activeRequests.get(msg.requestId);
      if (active && active.task) {
        saveToCache(active.task.modelConfig.id, active.task.query, {
          content: toolCalls && toolCalls.length > 0 ? null : cleanContent,
          tool_calls: toolCalls,
          finish_reason: toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop",
          usage: msg.usage
        });
      }

      // Beritahu queue processor bahwa generasi telah selesai tuntas
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

// Clean up closed tabs and dedicated windows
chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabWorkers.delete(tabId);
  for (const [modelId, tid] of modelTabMap.entries()) {
    if (tid === tabId) modelTabMap.delete(modelId);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  dedicatedWindows.delete(windowId);
  for (const [modelId, wid] of modelWindowMap.entries()) {
    if (wid === windowId) modelWindowMap.delete(modelId);
  }
});

// Auto-start on load & Auto-attach tabs
loadModels().then(async () => {
  await autoAttachExistingTabs();
  if (bridgeUrl && roomId) {
    connectBridge(bridgeUrl, roomId, apiKey);
  }
});
