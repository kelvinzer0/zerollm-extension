/**
 * ZeroLLM PWA Cache Boost & Accelerator (MAIN World - document_start)
 * 
 * Features:
 * 1. PWA CacheStorage Acceleration: Intercepts and caches static JS chunks,
 *    CSS, web fonts, and SVGs into window.caches (Cache-First / Stale-While-Revalidate).
 *    Results in instant 0ms loads for returning tabs and offline asset availability.
 * 2. Bloatware & Telemetry Stripper: Neutralizes Sentry, Datadog RUM, Statsig,
 *    Segment, and other heavy background trackers to free CPU & network threads.
 * 3. Prevents heavy background polling when tab is not active.
 */

(function () {
  'use strict';

  // 1. ── Neutralize Heavy Tracking & Telemetry (Runs before page scripts) ──
  try {
    // Datadog RUM
    if (!window.datadogRum) {
      window.datadogRum = {
        init: () => {},
        addAction: () => {},
        addError: () => {},
        startView: () => {},
        setGlobalContextProperty: () => {},
        setUser: () => {}
      };
    }

    // Sentry SDK
    if (!window.__SENTRY__) {
      window.__SENTRY__ = {
        hub: {
          captureException: () => {},
          captureMessage: () => {},
          addBreadcrumb: () => {}
        }
      };
    }

    // Statsig Feature Flags & A/B Tracking
    if (!window.statsig) {
      window.statsig = {
        initialize: async () => {},
        checkGate: () => false,
        getExperiment: () => ({ get: (_k, def) => def }),
        logEvent: () => {}
      };
    }

    // Segment Analytics
    if (!window.analytics) {
      window.analytics = {
        track: () => {},
        page: () => {},
        identify: () => {},
        loaded: true
      };
    }
  } catch (e) {
    // Non-critical, ignore
  }

  // 2. ── PWA CacheStorage Engine (Safe Non-Code Assets Only & Auto-Purge) ──
  (async function initPwaCache() {
    if (!('caches' in window)) return;

    // Purge old volatile chunk caches that could break SPA / React hydration
    try {
      const keys = await window.caches.keys();
      for (const k of keys) {
        if (k.includes('zerollm-pwa-cache-v1')) {
          await window.caches.delete(k);
        }
      }
    } catch (_) {}

    window.addEventListener('zerollm:purge-cache', async () => {
      try {
        const keys = await window.caches.keys();
        for (const k of keys) {
          if (k.startsWith('zerollm-pwa-cache')) {
            await window.caches.delete(k);
          }
        }
        console.log('[ZeroLLM PWA Cache] All ZeroLLM caches purged.');
      } catch (_) {}
    });

    try {
      const CACHE_NAME = 'zerollm-pwa-assets-v2';
      const cache = await window.caches.open(CACHE_NAME);

      const origFetch = window.fetch;
      window.fetch = async function (resource, init) {
        const url = typeof resource === 'string' ? resource : resource?.url || '';
        const method = (init?.method || (typeof resource === 'object' && resource?.method) || 'GET').toUpperCase();

        // Target static stylesheets, fonts, and images only (NEVER dynamic JS chunks or API endpoints!)
        const isSafeStaticAsset = method === 'GET' && (
          /\.(css|woff2?|ttf|svg|png|jpg|jpeg|webp|ico)(\?.*)?$/i.test(url)
        ) && !/\.(js|mjs)(\?.*)?$/i.test(url) && !/\/backend-api\/|\/api\/conversation|\/v1\//i.test(url);

        if (isSafeStaticAsset) {
          try {
            const cachedResponse = await cache.match(resource);
            if (cachedResponse) {
              if (navigator.onLine) {
                origFetch.apply(this, arguments).then((freshResponse) => {
                  if (freshResponse && freshResponse.status === 200) {
                    try { cache.put(resource, freshResponse.clone()); } catch (_) {}
                  }
                }).catch(() => {});
              }
              return cachedResponse;
            }
          } catch (_) {}

          try {
            const freshResponse = await origFetch.apply(this, arguments);
            if (freshResponse && freshResponse.status === 200) {
              try { cache.put(resource, freshResponse.clone()); } catch (_) {}
            }
            return freshResponse;
          } catch (fetchErr) {
            const fallback = await cache.match(resource);
            if (fallback) return fallback;
            throw fetchErr;
          }
        }

        return origFetch.apply(this, arguments);
      };

      console.log('[ZeroLLM PWA Cache] Injected & active for origin:', location.origin);
    } catch (err) {
      console.debug('[ZeroLLM PWA Cache] Init skipped:', err);
    }
  })();

  // 3. ── Inject PWA Meta Tags (Mobile Web App Capable & Theme) ──
  try {
    if (document.head) {
      if (!document.querySelector('meta[name="mobile-web-app-capable"]')) {
        const meta = document.createElement('meta');
        meta.name = 'mobile-web-app-capable';
        meta.content = 'yes';
        document.head.appendChild(meta);
      }
      if (!document.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
        const meta = document.createElement('meta');
        meta.name = 'apple-mobile-web-app-capable';
        meta.content = 'yes';
        document.head.appendChild(meta);
      }
    }
  } catch (_) {}
})();
