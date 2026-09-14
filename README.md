# ⚡ ZeroLLM — Universal Web-to-LLM Chrome Extension

Turn any web AI chatbot interface (**ChatGPT, Claude, Gemini, DeepSeek, Grok, Qwen, ChatSmith**, etc.) into a **100% standard OpenAI-compatible API endpoint** (`/v1/chat/completions`, `/v1/models`) powered by your browser session and the high-performance [ZeroLLM Bridge Gateway](https://github.com/kelvinzer0/llm-bridge-go).

---

## 🌟 Fitur Utama

- **OpenAI Standard Compatibility**:
  - Endpoint `/v1/chat/completions` (Streaming SSE & Non-streaming).
  - Endpoint `/v1/models` (Daftar model aktif sinkron otomatis).
- **Dual Execution Modes**:
  - **Multi-Window Parallel Mode**: Membuka jendela khusus untuk setiap chatbot dan mengeksekusi request secara bersamaan (paralel tanpa antre).
  - **Sequential Single-Window Mode**: Menggunakan antrean tertib FIFO dengan lock tab otomatis untuk menghemat memori.
- **Native Hardware Typing (CDP)**:
  - Pengetikan tingkat hardware via *Chrome DevTools Protocol* (`chrome.debugger`) untuk mem-bypass synthetic input barrier (React Lexical, ProseMirror, DraftJS).
- **Anti-Hibernation Keepalive (MV3)**:
  - Port heartbeat aktif dua arah antara content script dan service worker mencegah penutupan paksa 30 detik pada Chrome Manifest V3.
- **Tool Calling & Semantic XML Parser**:
  - Otomatis mengubah tool calls OpenAI menjadi format prompt yang dipahami LLM web dan mengekstrak balasan kembali menjadi `tool_calls` JSON valid.
- **Instant Response Cache**:
  - In-memory cache 10 menit dengan 0ms latency untuk query yang identik.

---

## 📁 Struktur Direktori Modular

```
zerollm-extension/
├── manifest.json            # Manifest V3 Configuration
├── package.json             # Build & packaging scripts
├── .gitignore               # Clean repo hygiene (ignores zips, temp files)
├── icons/                   # Extension icons (16px, 48px, 128px)
├── lib/
│   └── html-to-markdown.js  # DOM to Markdown conversion engine
├── scripts/
│   └── package.js           # Zero-dependency build packager
└── src/
    ├── background.js        # Main background service worker coordinator
    ├── presets.js           # Default model presets catalog (18+ chatbots)
    ├── content.js           # Isolated DOM extractor and 10s heartbeat keepalive
    ├── popup.html           # Management UI popup
    ├── popup.js             # UI state controller & smart credentials sync
    └── modules/             # Modular architectural components
        ├── bridge.js        # WebSocket bridge client & keepalive heartbeat
        ├── tab-manager.js   # Multi-tab router & atomic worker tab pool
        ├── tools.js         # Tool call parser, XML converter & prompt formatter
        ├── cdp.js           # Chrome DevTools Protocol native input injector
        └── cache.js         # In-memory query cache & stream buffer suppressor
```

---

## 🚀 Cara Menggunakan

### 1. Pasang Ekstensi di Chrome / Edge / Brave
1. Buka browser dan arahkan ke `chrome://extensions/`.
2. Aktifkan **Developer mode** di pojok kanan atas.
3. Klik tombol **Load unpacked** dan pilih folder `zerollm-extension`.

### 2. Hubungkan ke Bridge Gateway
1. Buka popup ekstensi ZeroLLM (ikon di toolbar browser).
2. Pindah ke tab **⚡ Cloudflare Bridge**.
3. Masukkan **Bridge URL** (default: `https://public-llm-bridge.warunglakku.com`).
4. Buat room baru dengan klik **🚀 Create New Room** atau masukkan **Room ID** & **API Key** Anda.
5. Klik **⚡ Connect / Save**.

### 3. Panggil dari Kode / Terminal
Gunakan endpoint standar OpenAI SDK atau `curl`:

```bash
curl https://public-llm-bridge.warunglakku.com/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt",
    "messages": [{"role": "user", "content": "Halo! Siapa namamu?"}]
  }'
```

---

## 🛠️ Developer Scripts

```bash
# Membuat paket distribusi ZIP terbaru (zerollm-extension-vX.X.X.zip)
npm run package
```

---

## 📜 Lisensi

MIT License © 2026 [Kelvin Andrian](https://github.com/kelvinzer0)
