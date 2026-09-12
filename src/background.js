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
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Mencari tab yang cocok atau OTOMATIS MEMBUKA TAB BARU jika belum terbuka
 */
async function getTabForModel(modelConfig) {
  const patternRegex = wildcardToRegExp(modelConfig.urlPattern);
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

    let query = "";
    if (req.messages && Array.isArray(req.messages)) {
      const lastUser = [...req.messages].reverse().find(m => m.role === "user");
      query = lastUser?.content || "";
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

    // 3. Kirim query ke tab untuk diproses
    await chrome.tabs.sendMessage(tab.id, {
      type: "executePrompt",
      requestId: task.requestId,
      modelConfig: task.modelConfig,
      query: task.query,
      stream: task.stream
    });
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
    case "response":
      sendToBridge({ type: "response", requestId: msg.requestId, content: msg.content, usage: msg.usage });
      break;
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
