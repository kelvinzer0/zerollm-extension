/**
 * ZeroLLM Multi-Tab Router & Background Service Worker
 * 
 * Solves:
 * 1. Multiple tabs orchestration: Maintains a mapping of Model -> TabID,
 *    so multiple models (e.g. ChatGPT, ChatSmith, Claude) can run in parallel
 *    across different tabs simultaneously without interference!
 * 2. Connects to LLM Bridge via WebSocket.
 * 3. Handles registration of dynamic models from user configurations.
 * 4. Routes incoming completionRequest/responsesRequest to the appropriate tab.
 */

import { DEFAULT_PRESETS } from "./presets.js";

let ws = null;
let bridgeUrl = "https://llm-bridge.insidexofficial.workers.dev";
let roomId = "default";
let apiKey = "";
let connectionState = "disconnected";
let reconnectTimer = null;

// User defined & preset models
let models = [];
// Active Model -> Tab ID mapping: Map<modelId, tabId>
const modelTabMap = new Map();
// Model Queue: Map<modelId, Array<pendingRequest>> to queue requests per tab
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
//  MULTI-TAB RESOLUTION & ORCHESTRATION
// ============================================================

/**
 * Convert a pattern like *://chatgpt.com/* into a RegExp
 */
function wildcardToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Find or open a suitable tab for a given model
 */
async function getTabForModel(modelConfig) {
  const patternRegex = wildcardToRegExp(modelConfig.urlPattern);
  const allTabs = await chrome.tabs.query({});

  // 1. Check if we already have an assigned tab that is still valid
  const existingTabId = modelTabMap.get(modelConfig.id);
  if (existingTabId) {
    const tab = allTabs.find(t => t.id === existingTabId);
    if (tab && tab.url && patternRegex.test(tab.url)) {
      return tab;
    }
  }

  // 2. Find any open tab matching the model's urlPattern
  const matchingTab = allTabs.find(t => t.url && patternRegex.test(t.url));
  if (matchingTab) {
    modelTabMap.set(modelConfig.id, matchingTab.id);
    return matchingTab;
  }

  // 3. If active tab matches or fallback
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && activeTab.url && patternRegex.test(activeTab.url)) {
    modelTabMap.set(modelConfig.id, activeTab.id);
    return activeTab;
  }

  // 4. Open a new tab if none found
  let targetUrl = modelConfig.urlPattern.replace(/\*/g, "");
  if (!targetUrl.startsWith("http")) targetUrl = "https://" + targetUrl.replace(/^\/+/, "");

  const newTab = await chrome.tabs.create({ url: targetUrl, active: false });
  modelTabMap.set(modelConfig.id, newTab.id);

  // Wait for the new tab to load
  await new Promise(resolve => {
    const listener = (tabId, info) => {
      if (tabId === newTab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 8000); // 8s fallback
  });

  return newTab;
}

/**
 * Ensure content script is running in the target tab
 */
async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    if (res && res.pong) return;
  } catch (e) {
    // Ping failed, inject content.js dynamically
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/content.js"]
      });
      await new Promise(r => setTimeout(r, 300));
    } catch (scriptErr) {
      console.warn("[ZeroLLM] Could not executeScript:", scriptErr.message);
    }
  }
}

// ============================================================
//  WEBSOCKET BRIDGE CONNECTION
// ============================================================

function connectBridge(url, room, key) {
  if (ws) {
    try { ws.close(); } catch (e) {}
    ws = null;
  }

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

      // Register all enabled models with Cloudflare Worker
      syncModelsToBridge();
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
      ws = null;
      reconnectTimer = setTimeout(() => {
        if (bridgeUrl && roomId) connectBridge(bridgeUrl, roomId, apiKey);
      }, 5000);
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

    // Extract query text
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
    // 1. Resolve tab for this specific model (multi-tab support)
    const tab = await getTabForModel(task.modelConfig);
    if (!tab) {
      throw new Error(`Tab for model '${modelId}' (${task.modelConfig.urlPattern}) not found. Please open the chat page tab.`);
    }

    await ensureContentScript(tab.id);

    // 2. Dispatch prompt to the tab
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

    // Popup management
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

// Auto-start on load
loadModels().then(() => {
  if (bridgeUrl && roomId) {
    connectBridge(bridgeUrl, roomId, apiKey);
  }
});
