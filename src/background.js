/**
 * ZeroLLM — Universal Web-to-LLM Bridge
 * Background Service Worker (Manifest V3 Modular Architecture)
 */

import { DEFAULT_PRESETS } from "./presets.js";
import {
  getFromCache,
  saveToCache,
  processStreamDelta,
  deleteStreamBuffer
} from "./modules/cache.js";
import {
  formatMessagesToPrompt,
  parseToolCalls,
  stripZeroLlmTags
} from "./modules/tools.js";
import { nativeTypeAndSend } from "./modules/cdp.js";
import {
  acquireWorkerTab,
  releaseWorkerTab,
  getTabForModel,
  waitForTabComplete,
  navigateToHomeAreaIfNeeded,
  ensureContentScript,
  autoAttachExistingTabs,
  hardRefreshModelTabs,
  modelTabMap,
  modelWindowMap,
  dedicatedWindows,
  activeTabWorkers,
  reservedTabs
} from "./modules/tab-manager.js";
import {
  connectBridge,
  disconnectBridge,
  sendToBridge,
  syncModelsToBridge,
  getBridgeState,
  setBridgeCredentials,
  configureBridge,
  broadcastBridgeState
} from "./modules/bridge.js";
import { setMediaBlocker } from "./modules/media-blocker.js";

// Models state & execution mode
let models = [...DEFAULT_PRESETS];
let executionMode = "parallel"; // "sequential" | "parallel"
let blockMedia = true; // Ultra-Speed native declarative image/media blocker

// Task management
const globalQueue = [];
let isProcessingGlobalQueue = false;
const pendingParallelTasks = [];
const activeRequests = new Map();

// ── Bridge Callbacks Configuration ────────────────────────────────────
configureBridge({
  onMessage: handleBridgeMessage,
  onStateChange: (bridgeState) => {
    broadcastState(bridgeState);
  }
});

function broadcastState(extra = {}) {
  const currentBridge = getBridgeState();
  chrome.runtime.sendMessage({
    type: "stateUpdate",
    state: {
      connectionState: currentBridge.connectionState,
      bridgeUrl: currentBridge.bridgeUrl,
      roomId: currentBridge.roomId,
      apiKey: currentBridge.apiKey,
      models,
      executionMode,
      blockMedia,
      ...extra
    }
  }).catch(() => {});
}

// ── Storage & Initialization ──────────────────────────────────────────
async function loadModels() {
  const data = await chrome.storage.local.get(["customModels", "bridgeUrl", "roomId", "apiKey", "executionMode", "blockMedia"]);
  if (data.customModels && Array.isArray(data.customModels) && data.customModels.length > 0) {
    const existingIds = new Set(data.customModels.map(m => m.id));
    let updatedModels = data.customModels.map(m => {
      const defaultPreset = DEFAULT_PRESETS.find(p => p.id === m.id);
      if (defaultPreset) {
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

  let bridgeUrl = data.bridgeUrl || "https://public-llm-bridge.warunglakku.com";
  if (bridgeUrl.includes("insidexofficial.workers.dev")) {
    bridgeUrl = "https://public-llm-bridge.warunglakku.com";
    chrome.storage.local.set({ bridgeUrl });
  }
  let roomId = data.roomId || "default";
  let apiKey = data.apiKey || "";
  if (data.executionMode) executionMode = data.executionMode;
  if (data.blockMedia !== undefined) blockMedia = Boolean(data.blockMedia);

  setBridgeCredentials(bridgeUrl, roomId, apiKey);
  setMediaBlocker(blockMedia, models);

  if (!roomId || roomId === "default" || roomId.trim() === "") {
    await ensureRoomAndKey();
  }
}

async function ensureRoomAndKey() {
  const current = getBridgeState();
  if (current.roomId && current.roomId !== "default" && current.roomId.trim() !== "") {
    return true;
  }
  const base = (current.bridgeUrl || "https://public-llm-bridge.warunglakku.com").replace(/\/+$/, "");
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`${base}/new`, {
      headers: { "User-Agent": "ZeroLLM-Extension/1.34" },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data.room && data.api_key) {
        setBridgeCredentials(base, data.room, data.api_key);
        await chrome.storage.local.set({ bridgeUrl: base, roomId: data.room, apiKey: data.api_key });
        broadcastState();
        return true;
      }
    }
  } catch (err) {
    console.warn("[ZeroLLM] Auto-registration /new failed or timed out:", err.message);
  }
  return false;
}

// ── Bridge Incoming Message Handler ───────────────────────────────────
async function handleBridgeMessage(msg) {
  // Touching Chrome API on every incoming message to keep MV3 SW active
  try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) {}

  if (msg.type === "ping") {
    sendToBridge({ type: "pong" });
    return;
  }

  if (msg.type === "requestModels") {
    console.log("[ZeroLLM] Bridge requested model sync, sending active models...");
    syncModelsToBridge(models);
    return;
  }

  if (msg.type === "completionRequest" || msg.type === "responsesRequest") {
    const req = msg.request || {};
    const rawModelId = typeof req.model === "string" ? req.model.trim() : "";
    const cleanModelId = rawModelId.includes("/") ? rawModelId.split("/").pop().trim().toLowerCase() : rawModelId.toLowerCase();

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

    // In-memory cache check (instant 0ms response)
    const cached = getFromCache(modelConfig.id, query);
    if (cached) {
      console.log(`[ZeroLLM Cache] ⚡ Cache HIT for model '${modelConfig.id}'`);
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
      executeParallelTask(taskItem);
    } else {
      globalQueue.push(taskItem);
      processGlobalQueue();
    }
  }
}

// ── Task Execution ───────────────────────────────────────────────────
function dispatchNextPendingParallelTask() {
  if (pendingParallelTasks.length === 0) return;
  const nextTask = pendingParallelTasks.shift();
  if (nextTask) {
    executeParallelTask(nextTask);
  }
}

async function executeParallelTask(task) {
  let targetTabId = null;

  try {
    const tab = await acquireWorkerTab(task.modelConfig);
    if (!tab || !tab.id) {
      pendingParallelTasks.push(task);
      return;
    }
    targetTabId = tab.id;

    activeTabWorkers.set(targetTabId, {
      requestId: task.requestId,
      modelId: task.modelConfig.id,
      startTime: Date.now()
    });

    await chrome.tabs.update(targetTabId, { active: true }).catch(() => {});
    await waitForTabComplete(targetTabId, 15000);
    await new Promise(r => setTimeout(r, 400));
    await navigateToHomeAreaIfNeeded(targetTabId, task.modelConfig);
    await ensureContentScript(targetTabId);

    await new Promise(async (resolve, reject) => {
      const timeoutMs = 300000;
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
      releaseWorkerTab(targetTabId, dispatchNextPendingParallelTask);
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
    const tab = await getTabForModel(task.modelConfig, executionMode);
    if (!tab) {
      throw new Error(`Could not find or open tab for model '${task.modelConfig.id}' (${task.modelConfig.urlPattern})`);
    }
    targetTabId = tab.id;

    const [currentActive] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    if (currentActive && currentActive.id !== targetTabId) {
      originalTabId = currentActive.id;
      console.log(`[ZeroLLM TabLock] Switching active tab from #${originalTabId} to target tab #${targetTabId}`);
      await chrome.tabs.update(targetTabId, { active: true });
      await new Promise(r => setTimeout(r, 60));
    }

    await waitForTabComplete(targetTabId, 15000);
    await navigateToHomeAreaIfNeeded(targetTabId, task.modelConfig);
    await ensureContentScript(targetTabId);

    await new Promise(async (resolve, reject) => {
      const timeoutMs = 300000;
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
    console.error(`[ZeroLLM] Error processing task ${task.requestId}:`, err);
    sendToBridge({
      type: "streamError",
      requestId: task.requestId,
      error: err.message || "Failed to process prompt"
    });
  } finally {
    activeRequests.delete(task.requestId);

    if (globalQueue.length === 0 && originalTabId) {
      try {
        await new Promise(r => setTimeout(r, 600));
        await chrome.tabs.update(originalTabId, { active: true });
      } catch (e) {}
    }

    isProcessingGlobalQueue = false;

    if (globalQueue.length > 0) {
      processGlobalQueue();
    }
  }
}

// ── Chrome Message Router ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "stream": {
      if (msg.delta && typeof msg.delta.content === "string") {
        const processedContent = processStreamDelta(msg.requestId, msg.delta.content, (tagBlock) => {
          return parseToolCalls(tagBlock) !== null;
        });
        if (processedContent) {
          sendToBridge({
            type: "stream",
            requestId: msg.requestId,
            delta: { ...msg.delta, content: processedContent }
          });
        }
      } else {
        sendToBridge({ type: "stream", requestId: msg.requestId, delta: msg.delta });
      }
      return false;
    }

    case "response": {
      deleteStreamBuffer(msg.requestId);
      const cleanContent = stripZeroLlmTags(msg.content);
      const toolCalls = parseToolCalls(msg.content);

      if (toolCalls && toolCalls.length > 0) {
        const textWithoutToolCalls = cleanContent
          .replace(/<(?:zerollm_tool_call|zerollm_call|zerollm:call|action|call|zerollm_code)[^>]*?>[\s\S]*?<\/(?:zerollm_tool_call|zerollm_call|zerollm:call|action|call)>/gi, "")
          .replace(/<tool_call[^>]*?>[\s\S]*?<\/tool_call>/gi, "")
          .replace(/\[(?:ACTION|PANGGIL_FUNGSI|TOOL|CALL):[\s\S]*?\]/gi, "")
          .replace(/<(?:function|invoke)[^>]*?>[\s\S]*?<\/(?:function|invoke)>/gi, "")
          .trim();

        console.log(`[ZeroLLM ToolCalls] Detected ${toolCalls.length} tool calls in response:`, toolCalls);
        sendToBridge({
          type: "response",
          requestId: msg.requestId,
          content: textWithoutToolCalls || null,
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

      const active = activeRequests.get(msg.requestId);
      if (active && active.task) {
        saveToCache(active.task.modelConfig.id, active.task.query, {
          content: cleanContent,
          tool_calls: toolCalls,
          finish_reason: (toolCalls && toolCalls.length > 0) ? "tool_calls" : "stop",
          usage: msg.usage
        });
        active.resolve({ content: cleanContent, toolCalls });
      }
      return false;
    }

    case "streamError": {
      sendToBridge({ type: "streamError", requestId: msg.requestId, error: msg.error });
      const active = activeRequests.get(msg.requestId);
      if (active) {
        active.reject(new Error(msg.error));
      }
      return false;
    }

    case "getState": {
      const bState = getBridgeState();
      sendResponse({
        connectionState: bState.connectionState,
        bridgeUrl: bState.bridgeUrl,
        roomId: bState.roomId,
        apiKey: bState.apiKey,
        models,
        executionMode,
        blockMedia
      });
      return false;
    }

    case "setExecutionMode": {
      executionMode = msg.mode;
      chrome.storage.local.set({ executionMode });
      broadcastState();
      sendResponse({ success: true, executionMode });
      return false;
    }

    case "setBlockMedia": {
      blockMedia = Boolean(msg.enabled);
      chrome.storage.local.set({ blockMedia });
      setMediaBlocker(blockMedia, models);
      broadcastState();
      sendResponse({ success: true, blockMedia });
      return false;
    }

    case "connect": {
      setBridgeCredentials(msg.url, msg.room, msg.apiKey);
      chrome.storage.local.set({ bridgeUrl: msg.url, roomId: msg.room, apiKey: msg.apiKey || "" });
      connectBridge(msg.url, msg.room, msg.apiKey, true, () => models);
      if (msg.hardRefresh) {
        hardRefreshModelTabs(models);
      }
      sendResponse({ success: true, connectionState: getBridgeState().connectionState });
      return false;
    }

    case "hardRefreshTabs": {
      hardRefreshModelTabs(models).then(() => {
        try { sendResponse({ success: true }); } catch (_) {}
      });
      return true;
    }

    case "disconnect": {
      disconnectBridge();
      sendResponse({ success: true });
      return false;
    }

    case "saveModels": {
      models = msg.models;
      chrome.storage.local.set({ customModels: models });
      syncModelsToBridge(models);
      broadcastState();
      sendResponse({ success: true });
      return false;
    }

    default:
      return false;
  }
});

// ── Clean up closed tabs & dedicated windows ──────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabWorkers.delete(tabId);
  reservedTabs.delete(tabId);
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

// ── MV3 Service Worker Keep-Alive Port Listener ───────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "zerollm-keepalive") {
    port.onMessage.addListener(() => {
      // Periodic heartbeat ping from content script keeps MV3 service worker active
      try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) {}
    });
    port.onDisconnect.addListener(() => {
      const _ = chrome.runtime.lastError;
    });
  }
});

// ── MV3 Alarm Periodic Health Check & Reconnect ───────────────────────
try {
  chrome.alarms.create("zerollm-keepalive-alarm", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "zerollm-keepalive-alarm") {
      try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) {}
      const bState = getBridgeState();
      if (!bState.ws || bState.ws.readyState !== WebSocket.OPEN) {
        if (bState.bridgeUrl && bState.roomId && bState.roomId !== "default") {
          console.log(`[ZeroLLM Alarm] Bridge disconnected. Reconnecting to ${bState.bridgeUrl} (room: ${bState.roomId})...`);
          connectBridge(bState.bridgeUrl, bState.roomId, bState.apiKey, true, () => models);
        }
      } else {
        try { bState.ws.send(JSON.stringify({ type: "pong" })); } catch (e) {}
        syncModelsToBridge(models);
      }
    }
  });
} catch (e) {}

// ── Auto-start on load ────────────────────────────────────────────────
loadModels().then(async () => {
  const bState = getBridgeState();
  if (bState.bridgeUrl && bState.roomId && bState.roomId !== "default") {
    connectBridge(bState.bridgeUrl, bState.roomId, bState.apiKey, true, () => models);
  }
  autoAttachExistingTabs(models).catch(() => {});
});
