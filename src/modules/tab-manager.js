/**
 * ZeroLLM Multi-Tab Router & Tab Worker Pool Manager
 * 
 * Manages:
 * - Active Model -> Tab ID mapping
 * - Dedicated Multi-Window parallel workers
 * - Atomic worker tab acquisition & locking
 * - Navigation & Home Area reset
 * - Auto-attachment of content scripts
 */

// Active Model -> Tab ID mapping: Map<modelId, tabId>
export const modelTabMap = new Map();
// Model -> Window ID mapping: Map<modelId, windowId>
export const modelWindowMap = new Map();
// Dedicated Worker Windows set: Set<windowId>
export const dedicatedWindows = new Set();
// Active Tab Workers map: Map<tabId, { requestId, modelId, startTime }>
export const activeTabWorkers = new Map();
// Atomic Reserved Tab IDs: Set<tabId> (locked synchronously to prevent race conditions)
export const reservedTabs = new Set();

export const MAX_CONCURRENT_WORKERS_PER_MODEL = 3;

export function wildcardToRegExp(pattern) {
  let norm = (pattern || "").trim();
  const hasTrailingSlashStar = norm.endsWith("/*");
  if (hasTrailingSlashStar) {
    norm = norm.slice(0, -2);
  }
  let escaped = norm
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\?/g, ".")
    .replace(/\*\\\./g, "(?:[^/]+\\.)?")
    .replace(/\*/g, ".*");

  if (hasTrailingSlashStar) {
    escaped += "(?:/.*)?";
  }
  return new RegExp(`^${escaped}$`, "i");
}

export async function injectContentScriptSilently(tabId) {
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

export async function ensureContentScript(tabId) {
  const isReady = await injectContentScriptSilently(tabId);
  if (!isReady) {
    await new Promise(r => setTimeout(r, 500));
    await injectContentScriptSilently(tabId);
  }
}

export async function waitForTabComplete(tabId, maxWaitMs = 15000) {
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

export async function navigateToHomeAreaIfNeeded(tabId, modelConfig) {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || !tab.url) return;

    // 1. Cek apakah tab yang ada sudah memiliki input chat yang aktif dan siap dipakai
    try {
      const readyCheck = await chrome.tabs.sendMessage(tabId, {
        type: "checkInputReady",
        modelConfig
      }).catch(() => null);

      if (readyCheck?.ready) {
        console.log(`[ZeroLLM Navigation] Tab #${tabId} sudah memiliki input chat yang aktif. Melewati navigasi/reload.`);
        return;
      }
    } catch (e) {}

    const currentUrl = tab.url;
    let homeUrl = modelConfig.newChatUrl || modelConfig.defaultUrl;
    if (!homeUrl && modelConfig.urlPattern) {
      homeUrl = modelConfig.urlPattern.replace(/^\*:\/\//, "https://").replace(/\*+/g, "");
      if (!homeUrl.startsWith("http")) {
        homeUrl = "https://" + homeUrl.replace(/^[:\/]+/, "");
      }
    }
    if (!homeUrl) return;

    const normCurrent = currentUrl.replace(/\/+$/, "");
    const normHome = homeUrl.replace(/\/+$/, "");

    if (normCurrent === normHome) {
      return;
    }

    const isOldThread = 
      /\/#\/chat\/[a-zA-Z0-9_-]+/i.test(currentUrl) ||
      /\/c\/[a-zA-Z0-9_-]+/i.test(currentUrl) ||
      /\/chat\/[a-zA-Z0-9_-]+/i.test(currentUrl) ||
      /\/conversation\/[a-zA-Z0-9_-]+/i.test(currentUrl) ||
      /\/thread\/[a-zA-Z0-9_-]+/i.test(currentUrl) ||
      /\/s\/[a-zA-Z0-9_-]+/i.test(currentUrl);

    if (isOldThread) {
      console.log(`[ZeroLLM Navigation] Input belum siap pada tab #${tabId} (${currentUrl}). Melakukan Soft-Reset instan...`);
      
      try {
        const softRes = await chrome.tabs.sendMessage(tabId, {
          type: "softResetChat",
          homeUrl: homeUrl
        }).catch(() => null);

        if (softRes?.success) {
          console.log(`[ZeroLLM Navigation] Soft-Reset instan berhasil (${softRes.method})!`);
          await new Promise(r => setTimeout(r, 250));
          return;
        }
      } catch (softErr) {}

      console.log(`[ZeroLLM Navigation] Fallback navigasi ke: ${homeUrl}...`);
      await chrome.tabs.update(tabId, { url: homeUrl });
      await waitForTabComplete(tabId, 15000);
      await new Promise(r => setTimeout(r, 800));
      await ensureContentScript(tabId);
    }
  } catch (err) {
    console.warn("[ZeroLLM Navigation] Gagal navigasi ke home area:", err.message);
  }
}

/**
 * ATOMIC PRE-WARMED WORKER POOL ACQUISITION
 * Mencari tab idle dan LANGSUNG mengunci (lock) secara sinkron sebelum proses async apapun.
 */
export async function acquireWorkerTab(modelConfig) {
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

export function releaseWorkerTab(tabId, onWorkerFreed) {
  if (tabId) {
    reservedTabs.delete(tabId);
    activeTabWorkers.delete(tabId);
  }
  if (typeof onWorkerFreed === "function") {
    onWorkerFreed();
  }
}

export async function getTabForModel(modelConfig, executionMode = "parallel") {
  const patternRegex = wildcardToRegExp(modelConfig.urlPattern);

  if (executionMode === "parallel") {
    return acquireWorkerTab(modelConfig);
  }

  // MODE SEQUENTIAL: Cek active tab
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url && patternRegex.test(activeTab.url)) {
      modelTabMap.set(modelConfig.id, activeTab.id);
      return activeTab;
    }
  } catch (e) {}

  const allTabs = await chrome.tabs.query({});

  // Cek tab yang sudah dipetakan sebelumnya
  const existingTabId = modelTabMap.get(modelConfig.id);
  if (existingTabId) {
    const tab = allTabs.find(t => t.id === existingTabId);
    if (tab && tab.url && patternRegex.test(tab.url)) {
      return tab;
    }
  }

  // Cari tab yang sedang terbuka dan cocok
  const matchingTab = allTabs.find(t => t.url && patternRegex.test(t.url));
  if (matchingTab) {
    modelTabMap.set(modelConfig.id, matchingTab.id);
    return matchingTab;
  }

  // Buka tab baru jika belum ada
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

export async function autoAttachExistingTabs(models) {
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

export async function hardRefreshModelTabs(models) {
  try {
    const allTabs = await chrome.tabs.query({});
    for (const model of models) {
      if (model.enabled === false) continue;
      const patternRegex = wildcardToRegExp(model.urlPattern);
      for (const tab of allTabs) {
        if (tab.url && patternRegex.test(tab.url)) {
          console.log(`[ZeroLLM] Hard refreshing tab #${tab.id} for model ${model.id} (bypassing cache)...`);
          try {
            await chrome.tabs.sendMessage(tab.id, { type: "purgePwaCache" }).catch(() => {});
          } catch (_) {}
          try {
            chrome.tabs.reload(tab.id, { bypassCache: true });
          } catch (_) {}
        }
      }
    }
  } catch (err) {
    console.warn("[ZeroLLM] hardRefreshModelTabs error:", err.message);
  }
}
