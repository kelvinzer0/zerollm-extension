/**
 * ZeroLLM Cloudflare / Go WebSocket Bridge Client
 * 
 * Manages WebSocket connection, bidirectional keepalive, model synchronization,
 * and state broadcasting.
 */

import { DEFAULT_PRESETS } from "../presets.js";

let ws = null;
let bridgeUrl = "https://public-llm-bridge.warunglakku.com";
let roomId = "default";
let apiKey = "";
let connectionState = "disconnected";
let reconnectTimer = null;
let pingInterval = null;
let reconnectAttempts = 0;
let activeWsUrl = null;
let activeWsRoom = null;

let onMessageCallback = null;
let onStateChangeCallback = null;

export function configureBridge(callbacks = {}) {
  if (callbacks.onMessage) onMessageCallback = callbacks.onMessage;
  if (callbacks.onStateChange) onStateChangeCallback = callbacks.onStateChange;
}

export function getBridgeState() {
  return {
    ws,
    bridgeUrl,
    roomId,
    apiKey,
    connectionState,
    activeWsUrl,
    activeWsRoom
  };
}

export function setBridgeCredentials(url, room, key) {
  if (url) bridgeUrl = url.trim().replace(/\/+$/, "");
  if (room) roomId = room.trim();
  if (key !== undefined && key !== null) apiKey = key.trim();
}

export function broadcastBridgeState(extraState = {}) {
  if (typeof onStateChangeCallback === "function") {
    onStateChangeCallback({
      connectionState,
      bridgeUrl,
      roomId,
      apiKey,
      ...extraState
    });
  }
}

export function sendToBridge(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function syncModelsToBridge(modelsList = []) {
  const sourceModels = (modelsList && modelsList.length > 0) ? modelsList : DEFAULT_PRESETS;
  let activeModels = sourceModels
    .filter(m => m.enabled !== false)
    .map(m => ({
      id: m.id,
      name: m.name || m.id,
      owned_by: "zerollm-extension",
      description: m.description || `Web AI model for ${m.urlPattern || m.id}`
    }));

  if (activeModels.length === 0) {
    activeModels = DEFAULT_PRESETS.map(m => ({
      id: m.id,
      name: m.name || m.id,
      owned_by: "zerollm-extension",
      description: m.description || `Web AI model for ${m.urlPattern || m.id}`
    }));
  }

  sendToBridge({
    type: "registerModels",
    models: activeModels
  });
  console.log(`[ZeroLLM] Synced ${activeModels.length} models to bridge (room: ${roomId})`);
}

export function connectBridge(url, room, key, force = false, getModelsFn = null) {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  if (!url || !room || room === "default") {
    console.warn("[ZeroLLM] connectBridge: url or roomId is invalid", { url, room });
    return;
  }

  const cleanUrl = (url || "").trim().replace(/\/+$/, "");
  const cleanRoom = (room || "").trim();
  const wsBase = cleanUrl.replace(/^http/, "ws");
  const wsUrl = `${wsBase}/ws/extension?room=${encodeURIComponent(cleanRoom)}`;

  // Jika tidak di-force dan socket SUDAH OPEN ke URL dan room yang sama persis, jangan reconnect
  if (!force && ws && ws.readyState === WebSocket.OPEN && activeWsUrl === wsUrl) {
    console.log(`[ZeroLLM] Already connected to ${wsUrl}.`);
    if (typeof getModelsFn === "function") syncModelsToBridge(getModelsFn());
    connectionState = "connected";
    broadcastBridgeState();
    return;
  }

  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  clearInterval(pingInterval);

  bridgeUrl = cleanUrl;
  roomId = cleanRoom;
  activeWsUrl = wsUrl;
  activeWsRoom = cleanRoom;

  if (key !== undefined && key !== null && key !== "") {
    apiKey = key.trim();
  }
  connectionState = "connecting";
  broadcastBridgeState();

  console.log(`[ZeroLLM] Connecting to Bridge: ${wsUrl}`);

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[ZeroLLM] WebSocket connected to ${cleanUrl} (room: ${cleanRoom})`);
      connectionState = "connected";
      reconnectAttempts = 0;
      broadcastBridgeState();
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      chrome.storage.local.set({ bridgeUrl: cleanUrl, roomId: cleanRoom, apiKey: apiKey || key });

      if (typeof getModelsFn === "function") {
        syncModelsToBridge(getModelsFn());
      } else {
        syncModelsToBridge();
      }

      // Mulai heartbeat keepalive aktif setiap 5 detik
      clearInterval(pingInterval);
      let pingCounter = 0;
      pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
          // Touching Chrome API resets the MV3 30-second service worker idle timer
          try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) {}
          pingCounter++;
          if (pingCounter % 6 === 0) {
            if (typeof getModelsFn === "function") {
              syncModelsToBridge(getModelsFn());
            } else {
              syncModelsToBridge();
            }
          }
        }
      }, 5000);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (typeof onMessageCallback === "function") {
          onMessageCallback(msg);
        }
      } catch (err) {
        console.error("[ZeroLLM] Error parsing message:", err);
      }
    };

    ws.onclose = (event) => {
      console.warn(`[ZeroLLM] WebSocket closed (code: ${event.code}). Scheduling reconnect...`);
      connectionState = "disconnected";
      activeWsUrl = null;
      activeWsRoom = null;
      broadcastBridgeState();
      clearInterval(pingInterval);
      ws = null;
      clearTimeout(reconnectTimer);
      const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts++), 5000);
      reconnectTimer = setTimeout(() => {
        if (bridgeUrl && roomId) connectBridge(bridgeUrl, roomId, apiKey, true, getModelsFn);
      }, delay);
    };

    ws.onerror = (err) => {
      console.error("[ZeroLLM] WebSocket error:", err);
    };
  } catch (err) {
    console.error("[ZeroLLM] connectBridge exception:", err);
    connectionState = "disconnected";
    activeWsUrl = null;
    activeWsRoom = null;
    broadcastBridgeState();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (bridgeUrl && roomId) connectBridge(bridgeUrl, roomId, apiKey, true, getModelsFn);
    }, 2000);
  }
}

export function disconnectBridge() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempts = 0;
  clearInterval(pingInterval);
  activeWsUrl = null;
  activeWsRoom = null;
  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  connectionState = "disconnected";
  broadcastBridgeState();
}
