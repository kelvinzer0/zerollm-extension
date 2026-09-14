import { DEFAULT_PRESETS } from "./presets.js";

// DOM Elements
const connDot = document.getElementById("connDot");
const connText = document.getElementById("connText");
const modelsList = document.getElementById("modelsList");
const modelCountBadge = document.getElementById("modelCountBadge");
const parallelToggle = document.getElementById("parallelToggle");
const modeBadge = document.getElementById("modeBadge");
const modeDesc = document.getElementById("modeDesc");

// Form elements
const mId = document.getElementById("mId");
const mUrl = document.getElementById("mUrl");
const mNewChatUrl = document.getElementById("mNewChatUrl");
const mNewChat = document.getElementById("mNewChat");
const mStart = document.getElementById("mStart");
const mContinue = document.getElementById("mContinue");
const mStream = document.getElementById("mStream");
const mDone = document.getElementById("mDone");
const mContainer = document.getElementById("mContainer");
const saveModelBtn = document.getElementById("saveModelBtn");
const resetPresetBtn = document.getElementById("resetPresetBtn");

// Connection elements
const cfgBridgeUrl = document.getElementById("cfgBridgeUrl");
const cfgRoomId = document.getElementById("cfgRoomId");
const dispApiKey = document.getElementById("dispApiKey");
const dispBaseUrl = document.getElementById("dispBaseUrl");
const newRoomBtn = document.getElementById("newRoomBtn");
const reconnectBtn = document.getElementById("reconnectBtn");
const copyKeyBtn = document.getElementById("copyKeyBtn");
const copyUrlBtn = document.getElementById("copyUrlBtn");

let currentModels = [];
let currentApiKey = "";

// Tabs switching logic
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    const target = document.getElementById(`tab-${btn.dataset.tab}`);
    if (target) target.classList.add("active");
  });
});

function renderModels(models) {
  currentModels = models || [];
  modelCountBadge.textContent = `${currentModels.length} Models`;
  modelsList.innerHTML = "";

  if (currentModels.length === 0) {
    modelsList.innerHTML = `<p style="color: #64748b; text-align: center; padding: 12px;">No models registered yet.</p>`;
    return;
  }

  currentModels.forEach((m, idx) => {
    const card = document.createElement("div");
    card.className = "model-card";
    card.innerHTML = `
      <div class="model-info">
        <h4>${m.name || m.id} <span style="font-size: 10px; color: #3b82f6; font-family: monospace;">(${m.id})</span></h4>
        <p>🎯 ${m.urlPattern}</p>
      </div>
      <div class="model-actions">
        <label class="switch" title="Enable/Disable Model">
          <input type="checkbox" ${m.enabled !== false ? "checked" : ""} data-idx="${idx}" class="toggle-model">
          <span class="slider"></span>
        </label>
        <button class="btn btn-secondary edit-model" data-idx="${idx}" style="padding: 4px 8px; font-size: 11px;">✏️</button>
        <button class="btn btn-danger delete-model" data-idx="${idx}" style="padding: 4px 8px; font-size: 11px;">🗑️</button>
      </div>
    `;
    modelsList.appendChild(card);
  });

  // Attach card event listeners
  document.querySelectorAll(".toggle-model").forEach(cb => {
    cb.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      currentModels[idx].enabled = e.target.checked;
      saveModelsToBackground(currentModels);
    });
  });

  document.querySelectorAll(".edit-model").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(btn.dataset.idx, 10);
      const m = currentModels[idx];
      mId.value = m.id || "";
      mUrl.value = m.urlPattern || "";
      if (mNewChatUrl) mNewChatUrl.value = m.newChatUrl || m.defaultUrl || "";
      mNewChat.value = m.newChatSelector || "";
      mStart.value = m.startChatSelector || "";
      mContinue.value = m.continueChatSelector || "";
      mStream.value = m.streamSelector || "";
      mDone.value = m.doneSelector || "";
      mContainer.value = m.resultContainerSelector || "";

      // Switch to create tab
      document.querySelector("[data-tab='create']").click();
    });
  });

  document.querySelectorAll(".delete-model").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(btn.dataset.idx, 10);
      currentModels.splice(idx, 1);
      saveModelsToBackground(currentModels);
      renderModels(currentModels);
    });
  });
}

function updateState(state) {
  if (!state) return;
  
  // Connection pill
  connDot.className = `dot ${state.connectionState}`;
  connText.textContent = state.connectionState === "connected" ? "Connected" : 
                         state.connectionState === "connecting" ? "Connecting..." : "Disconnected";

  if (state.bridgeUrl) {
    cfgBridgeUrl.value = state.bridgeUrl;
    dispBaseUrl.textContent = `${state.bridgeUrl.replace(/\/+$/, "")}/v1`;
  }
  if (state.roomId) cfgRoomId.value = state.roomId;
  if (state.apiKey) {
    currentApiKey = state.apiKey;
    dispApiKey.textContent = state.apiKey;
  } else {
    currentApiKey = "";
    dispApiKey.textContent = "-";
  }

  // Multi-Window Parallel Mode toggle state
  const isParallel = state.executionMode === "parallel";
  if (parallelToggle) parallelToggle.checked = isParallel;
  if (modeBadge) {
    modeBadge.textContent = isParallel ? "Parallel" : "Queue";
    modeBadge.style.color = isParallel ? "#10b981" : "#3b82f6";
    modeBadge.style.background = isParallel ? "rgba(16, 185, 129, 0.2)" : "rgba(59, 130, 246, 0.2)";
  }
  if (modeDesc) {
    modeDesc.textContent = isParallel
      ? "Mode Aktif: Multi-Window (Setiap AI di jendela terpisah, respon serentak paralel)."
      : "Mode Aktif: Sequential Queue (1 jendela bergantian, hemat memori, tab lock anti-mogok).";
  }

  renderModels(state.models);
}

if (parallelToggle) {
  parallelToggle.addEventListener("change", (e) => {
    const mode = e.target.checked ? "parallel" : "sequential";
    chrome.runtime.sendMessage({
      type: "setExecutionMode",
      mode
    });
    if (modeBadge) {
      modeBadge.textContent = e.target.checked ? "Parallel" : "Queue";
      modeBadge.style.color = e.target.checked ? "#10b981" : "#3b82f6";
      modeBadge.style.background = e.target.checked ? "rgba(16, 185, 129, 0.2)" : "rgba(59, 130, 246, 0.2)";
    }
    if (modeDesc) {
      modeDesc.textContent = e.target.checked
        ? "Mode Aktif: Multi-Window (Setiap AI di jendela terpisah, respon serentak paralel)."
        : "Mode Aktif: Sequential Queue (1 jendela bergantian, hemat memori, tab lock anti-mogok).";
    }
  });
}

function saveModelsToBackground(newModels) {
  chrome.runtime.sendMessage({
    type: "saveModels",
    models: newModels
  });
}

// ── Save/Create Model Handler ──────────────────────────────────────────
saveModelBtn.addEventListener("click", () => {
  const modelId = mId.value.trim();
  const urlPattern = mUrl.value.trim();
  const newChatUrl = mNewChatUrl ? mNewChatUrl.value.trim() : "";
  const newChatSel = mNewChat.value.trim();
  const startChat = mStart.value.trim();
  const continueChat = mContinue.value.trim();
  const streamSel = mStream.value.trim();
  const doneSel = mDone.value.trim();
  const containerSel = mContainer.value.trim();

  if (!modelId || !urlPattern) {
    alert("Model ID and URL Wildcard Pattern are required!");
    return;
  }

  const existingIndex = currentModels.findIndex(m => m.id === modelId);
  const newModelObj = {
    id: modelId,
    name: modelId,
    enabled: true,
    urlPattern,
    defaultUrl: newChatUrl || (existingIndex >= 0 ? currentModels[existingIndex].defaultUrl : undefined),
    newChatUrl: newChatUrl || (existingIndex >= 0 ? currentModels[existingIndex].newChatUrl : undefined),
    newChatSelector: newChatSel,
    startChatSelector: startChat,
    continueChatSelector: continueChat,
    streamSelector: streamSel,
    doneSelector: doneSel,
    resultContainerSelector: containerSel,
    description: `Web AI model for ${urlPattern}`
  };

  if (existingIndex >= 0) {
    currentModels[existingIndex] = newModelObj;
  } else {
    currentModels.push(newModelObj);
  }

  saveModelsToBackground(currentModels);
  renderModels(currentModels);

  // Clear inputs
  mId.value = "";
  mUrl.value = "";
  if (mNewChatUrl) mNewChatUrl.value = "";
  mStart.value = "";
  mContinue.value = "";
  mStream.value = "";
  mDone.value = "";
  mContainer.value = "";

  document.querySelector("[data-tab='models']").click();
});

// ── Reset to Presets ──────────────────────────────────────────────────
resetPresetBtn.addEventListener("click", () => {
  if (confirm("Reset to full presets suite (ChatGPT, Claude, Gemini, DeepSeek, Grok, Perplexity, Kimi, Qwen, Doubao, GLM, Copilot, Mistral, Poe, ChatSmith, etc.)?")) {
    currentModels = [...DEFAULT_PRESETS];
    saveModelsToBackground(currentModels);
    renderModels(currentModels);
    document.querySelector("[data-tab='models']").click();
  }
});

// ── New Room Creation ─────────────────────────────────────────────────
newRoomBtn.addEventListener("click", async () => {
  const base = cfgBridgeUrl.value.trim().replace(/\/+$/, "");
  newRoomBtn.textContent = "Creating Room...";
  newRoomBtn.disabled = true;

  try {
    const res = await fetch(`${base}/new`, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();

    if (!data.api_key) {
      throw new Error("Bridge endpoint did not return an 'api_key'. If you are self-hosting, check your Nginx configuration: public-llm-bridge may be proxying to mcp-bridge instead of llm-bridge.");
    }
    
    cfgRoomId.value = data.room;
    currentApiKey = data.api_key;
    dispApiKey.textContent = data.api_key;
    dispBaseUrl.textContent = data.api_base_url || `${base}/v1`;

    chrome.runtime.sendMessage({
      type: "connect",
      url: base,
      room: data.room,
      apiKey: data.api_key
    });
  } catch (err) {
    alert(`Failed to create room: ${err.message}`);
  } finally {
    newRoomBtn.textContent = "🚀 Create New Room";
    newRoomBtn.disabled = false;
  }
});

// ── Reconnect ─────────────────────────────────────────────────────────
reconnectBtn.addEventListener("click", () => {
  const base = cfgBridgeUrl.value.trim().replace(/\/+$/, "");
  const room = cfgRoomId.value.trim();
  chrome.runtime.sendMessage({
    type: "connect",
    url: base,
    room: room,
    apiKey: currentApiKey
  });
});

// ── Copy buttons ──────────────────────────────────────────────────────
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "✅";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}

copyKeyBtn.addEventListener("click", () => {
  copyToClipboard(dispApiKey.textContent, copyKeyBtn);
});

copyUrlBtn.addEventListener("click", () => {
  copyToClipboard(dispBaseUrl.textContent, copyUrlBtn);
});

// ── Listeners ─────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ type: "getState" }, updateState);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "stateUpdate") {
    updateState(msg.state);
  }
});
