/**
 * ZeroLLM GitHub Auto-Updater Module
 * 
 * Periodically checks for new releases on GitHub, notifies the user,
 * and enables one-click download / seamless update detection.
 */

const GITHUB_REPO = "kelvinzer0/zerollm-extension";
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/**
 * Compare two semver strings (e.g., "1.40.2" > "1.40.1")
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
export function compareVersions(v1, v2) {
  const clean1 = (v1 || "").replace(/^v/, "").trim();
  const clean2 = (v2 || "").replace(/^v/, "").trim();

  const parts1 = clean1.split(".").map(n => parseInt(n, 10) || 0);
  const parts2 = clean2.split(".").map(n => parseInt(n, 10) || 0);

  const maxLen = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * Check GitHub for latest release and compare with current manifest version
 */
export async function checkGitHubRelease() {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const res = await fetch(RELEASES_API, {
      headers: { "Accept": "application/vnd.github.v3+json" }
    });

    if (!res.ok) {
      console.warn(`[ZeroLLM Updater] GitHub release check returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const latestTag = data.tag_name || "";
    const latestVersion = latestTag.replace(/^v/, "");
    const releaseUrl = data.html_url || `https://github.com/${GITHUB_REPO}/releases`;
    const releaseNotes = (data.body || "").slice(0, 300);

    // Find ZIP asset or fallback to zipball
    let zipUrl = data.zipball_url;
    if (data.assets && Array.isArray(data.assets)) {
      const zipAsset = data.assets.find(a => a.name && a.name.endsWith(".zip"));
      if (zipAsset) zipUrl = zipAsset.browser_download_url;
      const crxAsset = data.assets.find(a => a.name && a.name.endsWith(".crx"));
      if (crxAsset) var crxUrl = crxAsset.browser_download_url;
    }

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    const updateInfo = {
      hasUpdate,
      currentVersion,
      latestVersion,
      latestTag,
      releaseUrl,
      releaseNotes,
      zipUrl,
      crxUrl: crxUrl || null,
      publishedAt: data.published_at,
      lastChecked: Date.now()
    };

    await chrome.storage.local.set({ updateInfo });

    if (hasUpdate) {
      console.log(`[ZeroLLM Updater] 🚀 New version available: ${latestTag} (current: v${currentVersion})`);
      
      // Update badge
      if (chrome.action?.setBadgeText) {
        chrome.action.setBadgeText({ text: "NEW" });
        chrome.action.setBadgeBackgroundColor({ color: "#2563eb" });
      }

      // Show Chrome Notification (if notifications permission available)
      if (chrome.notifications?.create) {
        chrome.notifications.create("zerollm-update-notice", {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: `ZeroLLM Update: ${latestTag} Tersedia!`,
          message: `Versi baru ${latestTag} telah dirilis di GitHub. Buka popup ZeroLLM untuk memperbarui.`,
          priority: 2
        });
      }
    } else {
      console.log(`[ZeroLLM Updater] Extension is up-to-date (v${currentVersion})`);
      if (chrome.action?.setBadgeText) {
        // Clear update badge if no update
        const currentBadge = await chrome.action.getBadgeText({});
        if (currentBadge === "NEW") {
          chrome.action.setBadgeText({ text: "" });
        }
      }
    }

    return updateInfo;
  } catch (err) {
    console.warn("[ZeroLLM Updater] Failed to check for updates:", err.message);
    return null;
  }
}

/**
 * Initialize periodic alarm for update checking
 */
export function initAutoUpdater() {
  if (chrome.alarms?.create) {
    chrome.alarms.create("check-zerollm-update", {
      periodInMinutes: 30 // Cek setiap 30 menit
    });

    // Jalankan cek sekali saat startup setelah delay 5 detik
    setTimeout(() => {
      checkGitHubRelease();
    }, 5000);
  }
}
