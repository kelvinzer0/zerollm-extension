# ⚡ ZeroLLM — Universal Web-to-LLM Chrome Extension

ZeroLLM turns any AI chatbot web interface (ChatGPT, ChatSmith, Claude, Gemini, etc.) into an **OpenAI-compatible LLM endpoint** (`/v1/chat/completions`) powered by your browser session and [LLM Bridge Cloudflare Workers](https://github.com/kelvinzer0/llm-bridge-cf).

---

## 🌟 Fitur Utama & Cara Kerja

1. **5 Kolom Konfigurasi Model (Create Model)**:
   - **URL Wildcard Area Working**: Pola wildcard URL tab target, misal `*://chatsmith.io/*`, `*://chatgpt.com/c/*`, dll.
   - **Regex Start Chat Area**: Regex atau selector untuk mendeteksi kotak input obrolan baru.
   - **Regex Continue Chat Area**: Regex atau selector untuk melanjutkan pesan pada obrolan aktif.
   - **Result Area Regex Respon (Detect Sedang Stream)**: Selector/Regex untuk mendeteksi AI sedang men-generate / tombol stop muncul (misal `button[aria-label*='Stop']`, `.streaming`, `.typing`).
   - **Result Area Regex Respon (Detect Sudah Done)**: Selector/Regex untuk mendeteksi pesan selesai di-generate / tombol kirim muncul kembali.
   - **Result Container Area**: Mengambil DOM hasil jawaban untuk diubah otomatis menjadi Markdown.

2. **Auto Parse Output ke Markdown Standard**:
   - Menghasilkan Markdown bersih dari elemen HTML DOM (heading `#`, list `*`, bold `**`, codeblock ```, table `|`, links).

3. **Multi-Tab Orchestration (Solusi Kendala Multiple Tab)**:
   - ZeroLLM mengisolasi proses per-model ke antrean masing-masing (`modelQueues`).
   - Memetakan setiap model ke Tab ID browser secara otomatis (`modelTabMap`).
   - Anda bisa menjalankan request untuk model **ChatGPT** dan **ChatSmith** secara bersamaan! Extension akan mendispatch query ke tab ChatGPT dan ChatSmith secara paralel tanpa tumpang tindih.

---

## 🚀 Cara Menggunakan

1. **Pasang Extension di Chrome**:
   - Buka `chrome://extensions/`
   - Aktifkan **Developer mode**
   - Klik **Load unpacked** dan pilih folder `zerollm-extension`
2. **Sambungkan ke Bridge**:
   - Buka popup ZeroLLM
   - Masukkan Cloudflare Bridge URL (default: `https://llm-bridge.insidexofficial.workers.dev`)
   - Klik **🚀 Create New Room**
   - Salin **API Key** yang dihasilkan
3. **Buka Tab Chatbot AI**:
   - Buka tab `chatgpt.com`, `chatsmith.io`, `claude.ai`, dll.
   - Model akan otomatis terdaftar dan siap menerima query dari OpenAI client / SDK!

---

## 🧪 Preset yang Tersedia

- **ChatGPT**: `*://chatgpt.com/*`
- **ChatSmith**: `*://chatsmith.io/*`
- **Claude**: `*://claude.ai/*`
- **Google Gemini**: `*://gemini.google.com/*`
- **Generic AI**: `*://*/*`

## Lisensi

MIT License © 2026 Kelvin Andrian
