/**
 * ZeroLLM Prompt Formatter & Tool Calling Parser Module
 * 
 * Handles bidirectional transformation:
 * - OpenAI chat completion messages & tool specs -> ZeroLLM semantic XML prompts
 * - Raw LLM text outputs -> OpenAI tool_calls objects & clean assistant text
 */

export function safeParseJsonArgs(argsStr, fnName) {
  if (!argsStr || typeof argsStr !== "string") return "{}";
  argsStr = argsStr.trim();

  // 0. Sanitasi komprehensif tag <zerollm_code> dan pembungkus di dalam argumen
  argsStr = argsStr.replace(/^<zerollm_code[^>]*>/i, "").trim();
  argsStr = argsStr.replace(/<\/(?:zerollm_code|zerollm_tool_call|action|call)>$/i, "").trim();

  // Normalisasi jika tag <zerollm_code> membungkus nilai properti JSON: {"command": <zerollm_code>...}
  argsStr = argsStr.replace(/:\s*<zerollm_code[^>]*>([\s\S]*?)(?:<\/zerollm_code>|$)/gi, (m, codeContent) => {
    return ": " + JSON.stringify(codeContent.trim());
  });

  // Hapus sisa tag pembuka dan penutup <zerollm_code> di mana pun dalam string
  argsStr = argsStr.replace(/<zerollm_code[^>]*>/gi, "").replace(/<\/zerollm_code>/gi, "").trim();

  // Hapus sisa tag markdown code block ```lang jika ada
  argsStr = argsStr.replace(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/g, "$1").trim();

  // Sanitasi autolinked markdown link [https://...](https://...) menjadi URL murni https://...
  argsStr = argsStr.replace(/\[\s*(https?:\/\/[^\s\]]+?)(?:["'\s>]+)?\s*\]\(\s*https?:\/\/[^\s\)]+?\s*\)/gi, (match, url) => {
    return url.replace(/["'>\s\\]+$/, "");
  });

  // 1. Dukungan XML parameter di dalam tag tool: <parameter name="filePath">...</parameter>
  if (argsStr.includes("<parameter")) {
    const paramRegex = /<parameter(?:=|\s+name=)["\x27]?([\w_-]+)["\x27]?[^>]*>([\s\S]*?)(?:<\/parameter>|(?=<parameter|$))/gi;
    let pMatch;
    const argsObj = {};
    let found = false;
    while ((pMatch = paramRegex.exec(argsStr)) !== null) {
      found = true;
      const key = pMatch[1];
      let val = pMatch[2].trim();
      try { val = JSON.parse(val); } catch(e) {}
      argsObj[key] = val;
    }
    if (found) return JSON.stringify(argsObj);
  }

  // 2. Coba parse langsung jika sudah valid JSON
  try {
    const parsed = JSON.parse(argsStr);
    if (typeof parsed === "object" && parsed !== null) {
      return JSON.stringify(parsed);
    }
  } catch(e) {}

  // 3. Normalisasi trailing comma
  try {
    const noTrailing = argsStr.replace(/,\s*([\}\]])/g, "$1");
    const parsed = JSON.parse(noTrailing);
    if (typeof parsed === "object" && parsed !== null) {
      return JSON.stringify(parsed);
    }
  } catch(e) {}

  // 3b. Normalisasi kutip satu (single quote) jika mirip Python dict {'a': 1}
  try {
    const doubleQuoted = argsStr.replace(/'/g, '"');
    const parsed = JSON.parse(doubleQuoted);
    if (typeof parsed === "object" && parsed !== null) {
      return JSON.stringify(parsed);
    }
  } catch(e) {}

  // 4. Bi-directional property peeling untuk JSON objek yang mengandung kode/kutip unescaped
  if (argsStr.startsWith("{") && argsStr.endsWith("}")) {
    let inner = argsStr.slice(1, -1).trim();
    const result = {};

    // Standard JSON property regex matching dari DEPAN:
    // Mencocokkan "key": value, di mana value adalah tipe standar (number, bool, null, atau properly-escaped string)
    const standardFrontRegex = /^\s*"([a-zA-Z0-9_]+)"\s*:\s*(true|false|null|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*")\s*(?:,\s*|$)/;
    let matchedFront = true;
    while (matchedFront) {
      const m = inner.match(standardFrontRegex);
      if (m) {
        const k = m[1];
        let v = m[2];
        try { v = JSON.parse(v); } catch (_) {}
        result[k] = v;
        inner = inner.slice(m[0].length).trim();
      } else {
        matchedFront = false;
      }
    }

    // Standard JSON property regex matching dari BELAKANG:
    // Mencocokkan , "key": value $
    const standardBackRegex = /,\s*"([a-zA-Z0-9_]+)"\s*:\s*(true|false|null|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*")\s*$/;
    let matchedBack = true;
    const backProps = [];
    while (matchedBack) {
      const m = inner.match(standardBackRegex);
      if (m) {
        const k = m[1];
        let v = m[2];
        try { v = JSON.parse(v); } catch (_) {}
        backProps.unshift({ key: k, value: v });
        inner = inner.slice(0, m.index).trim();
      } else {
        matchedBack = false;
      }
    }

    for (const bp of backProps) {
      result[bp.key] = bp.value;
    }

    // Sisa di dalam `inner` adalah payload string kode yang memuat unescaped double quotes / raw newlines
    // Contoh: "content": "<!DOCTYPE html>\n<html lang="en">...</html>"
    if (inner.length > 0) {
      const payloadMatch = inner.match(/^\s*"([a-zA-Z0-9_]+)"\s*:\s*"?([\s\S]*)/);
      if (payloadMatch) {
        const payloadKey = payloadMatch[1];
        let payloadVal = payloadMatch[2].trim();
        if (payloadVal.endsWith("\"")) {
          payloadVal = payloadVal.slice(0, -1);
        }
        // Unescape sequence standar seperti \n, \r, \t sambil menjaga kutip ganda internal
        payloadVal = payloadVal.replace(/\\n/g, "\n")
                               .replace(/\\r/g, "\r")
                               .replace(/\\t/g, "\t")
                               .replace(/\\"/g, "\"")
                               .replace(/\\\\/g, "\\");
        result[payloadKey] = payloadVal;
      } else {
        const fallbackKey = (fnName === "exec" || fnName === "bash") ? "command"
                          : (fnName === "read" || fnName === "edit" || fnName === "write") ? "content"
                          : "input";
        result[fallbackKey] = inner;
      }
    }

    if (Object.keys(result).length > 0) {
      return JSON.stringify(result);
    }
  }

  // 5. Jika bukan objek JSON sama sekali tapi teks perintah mentah / skrip kode
  if (!argsStr.startsWith("{")) {
    const defaultKey = (fnName === "exec" || fnName === "bash") ? "command"
                     : (fnName === "read" || fnName === "edit" || fnName === "write") ? "path"
                     : "input";
    return JSON.stringify({ [defaultKey]: argsStr.trim() });
  }

  // 6. Fallback terakhir: bungkus raw text sebagai input JSON valid
  return JSON.stringify({ input: argsStr.trim() });
}

export function parseToolCalls(text) {
  if (!text || typeof text !== "string") return null;

  const calls = [];

  // Pola 1 (Utama ZeroLLM): <zerollm_tool_call name="...">...</zerollm_tool_call> atau <zerollm_call name="...">
  const tagRegex = /<(?:zerollm_tool_call|zerollm_call|zerollm:call|action|call|zerollm_code)[^>]*?(?:name|lang)=["\x27]?([\w_-]+)["\x27]?[^>]*>([\s\S]*?)<\/(?:zerollm_tool_call|zerollm_call|zerollm:call|action|call)>/gi;
  let match;
  while ((match = tagRegex.exec(text)) !== null) {
    let fnName = match[1];
    if (fnName === "sh" || fnName === "shell" || fnName === "zsh") {
      fnName = "bash";
    }
    const argsStr = safeParseJsonArgs(match[2], fnName);
    calls.push({
      id: "call_" + Math.random().toString(36).substring(2, 10),
      type: "function",
      function: { name: fnName, arguments: argsStr }
    });
  }

  // Pola 1b: <tool_call>...</tool_call> (Mendukung JSON murni ATAU XML function/parameter)
  if (calls.length === 0) {
    const xmlToolRegex = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi;
    while ((match = xmlToolRegex.exec(text)) !== null) {
      const inner = match[1].trim();

      try {
        const obj = JSON.parse(inner);
        const fnName = obj.name || obj.tool;
        const args = obj.arguments || obj.parameters || {};
        if (fnName) {
          calls.push({
            id: obj.id || `call_${Math.random().toString(36).substring(2, 10)}`,
            type: "function",
            function: {
              name: fnName,
              arguments: typeof args === "string" ? args : JSON.stringify(args)
            }
          });
          continue;
        }
      } catch(e) {}

      const fnMatch = inner.match(/<(?:function|invoke)(?:=|\s+name=)["\x27]?([\w_-]+)["\x27]?[^>]*>/i);
      if (fnMatch) {
        const fnName = fnMatch[1];
        const argsObj = {};

        const paramRegex = /<parameter(?:=|\s+name=)["\x27]?([\w_-]+)["\x27]?[^>]*>([\s\S]*?)(?:<\/parameter>|(?=<parameter|<\/tool_call>|$))/gi;
        let pMatch;
        while ((pMatch = paramRegex.exec(inner)) !== null) {
          const key = pMatch[1];
          let val = pMatch[2].trim();
          try {
            val = JSON.parse(val);
          } catch(e) {}
          argsObj[key] = val;
        }

        calls.push({
          id: `call_${Math.random().toString(36).substring(2, 10)}`,
          type: "function",
          function: {
            name: fnName,
            arguments: JSON.stringify(argsObj)
          }
        });
      }
    }
  }

  // Fallback Pola 1b.3: Deteksi XML <function=...> langsung tanpa pembungkus <tool_call>
  if (calls.length === 0) {
    const standaloneFnRegex = /<(?:function|invoke)(?:=|\s+name=)["\x27]?([\w_-]+)["\x27]?[^>]*>([\s\S]*?)(?:<\/(?:function|invoke)>|$)/gi;
    while ((match = standaloneFnRegex.exec(text)) !== null) {
      const fnName = match[1];
      const inner = match[2].trim();
      const argsObj = {};
      const paramRegex = /<parameter(?:=|\s+name=)["\x27]?([\w_-]+)["\x27]?[^>]*>([\s\S]*?)(?:<\/parameter>|(?=<parameter|$))/gi;
      let pMatch;
      let foundParams = false;
      while ((pMatch = paramRegex.exec(inner)) !== null) {
        foundParams = true;
        const key = pMatch[1];
        let val = pMatch[2].trim();
        try { val = JSON.parse(val); } catch(e) {}
        argsObj[key] = val;
      }
      if (foundParams) {
        calls.push({
          id: `call_${Math.random().toString(36).substring(2, 10)}`,
          type: "function",
          function: {
            name: fnName,
            arguments: JSON.stringify(argsObj)
          }
        });
      }
    }
  }

  // Pola 1c: ```tool_json\n{"tool":"...", "parameters":{...}}\n```
  if (calls.length === 0) {
    const toolJsonRegex = /```(?:tool_json|tool)\s*\n?([\s\S]*?)\n?```/gi;
    while ((match = toolJsonRegex.exec(text)) !== null) {
      try {
        const obj = JSON.parse(match[1].trim());
        const fnName = obj.tool || obj.name;
        const args = obj.parameters || obj.arguments || {};
        if (fnName) {
          calls.push({
            id: obj.id || `call_${Math.random().toString(36).substring(2, 10)}`,
            type: "function",
            function: {
              name: fnName,
              arguments: typeof args === "string" ? args : JSON.stringify(args)
            }
          });
        }
      } catch(e) {}
    }
  }

  // Pola 2 (Alternatif): [ACTION: nama_fungsi({"param": "nilai"})]
  if (calls.length === 0) {
    const bracketRegex = /\[(?:ACTION|PANGGIL_FUNGSI|TOOL|CALL):\s*([\w_-]+)\(([\s\S]*?)\)\]/gi;
    while ((match = bracketRegex.exec(text)) !== null) {
      const fnName = match[1];
      const argsStr = safeParseJsonArgs(match[2], fnName);
      calls.push({
        id: "call_" + Math.random().toString(36).substring(2, 10),
        type: "function",
        function: { name: fnName, arguments: argsStr }
      });
    }
  }

  // Pola 3 (Fallback JSON murni)
  if (calls.length === 0) {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    let candidate = jsonMatch ? jsonMatch[1].trim() : text.trim();

    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      candidate = candidate.slice(firstBrace, lastBrace + 1);
    }

    try {
      const parsed = JSON.parse(candidate);

      if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
        return parsed.tool_calls.map(tc => ({
          id: tc.id || `call_${Math.random().toString(36).substring(2, 10)}`,
          type: "function",
          function: {
            name: tc.name || tc.function?.name,
            arguments: typeof tc.arguments === "string" 
              ? tc.arguments 
              : JSON.stringify(tc.arguments || tc.function?.arguments || {})
          }
        })).filter(tc => tc.function.name);
      }

      if (parsed.tool && (parsed.parameters !== undefined || parsed.arguments !== undefined)) {
        return [{
          id: parsed.id || `call_${Math.random().toString(36).substring(2, 10)}`,
          type: "function",
          function: {
            name: parsed.tool,
            arguments: typeof (parsed.parameters || parsed.arguments) === "string"
              ? (parsed.parameters || parsed.arguments)
              : JSON.stringify(parsed.parameters || parsed.arguments || {})
          }
        }];
      }

      if (parsed.name && (parsed.arguments !== undefined || parsed.parameters !== undefined)) {
        return [{
          id: parsed.id || `call_${Math.random().toString(36).substring(2, 10)}`,
          type: "function",
          function: {
            name: parsed.name,
            arguments: typeof (parsed.arguments || parsed.parameters) === "string"
              ? (parsed.arguments || parsed.parameters)
              : JSON.stringify(parsed.arguments || parsed.parameters || {})
          }
        }];
      }
    } catch (e) {}
  }

  return calls.length > 0 ? calls : null;
}

export function extractTextContent(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
          if (part.type === "image_url" || part.type === "image") return "[Gambar]";
          if (part.type === "video_url" || part.type === "video") return "[Video]";
          try { return JSON.stringify(part); } catch (e) {}
        }
        return String(part);
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text.trim();
    if (typeof content.content === "string") return content.content.trim();
    try {
      return JSON.stringify(content);
    } catch (e) {
      return String(content).trim();
    }
  }
  return String(content).trim();
}

export function resolveToolName(convo, msg) {
  if (msg.name && msg.name !== "eksternal") return msg.name;
  const callId = msg.tool_call_id || msg.id;
  if (!callId) return msg.name || "tool";

  for (const m of convo) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const matched = m.tool_calls.find(tc => tc.id === callId);
      if (matched) {
        return matched.function?.name || matched.name || "tool";
      }
    }
  }
  return msg.name || "tool";
}

export function sanitizeXmlTag(key) {
  if (!key) return "property";
  let clean = String(key)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^[^a-zA-Z_]+/, "_");
  return clean || "property";
}

export function escapeXmlAttr(str) {
  if (!str) return "";
  return String(str).replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatTextWithCodeTags(text) {
  if (typeof text !== "string") return String(text);
  return text.replace(/```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)\n```/g, (match, lang, code) => {
    const langAttr = lang ? ` lang="${lang}"` : "";
    return `<zerollm_code${langAttr}>\n${code}\n</zerollm_code>`;
  });
}

export function jsonToXml(data, indent = 1) {
  if (data === null || data === undefined) return "";
  if (typeof data !== "object") {
    return formatTextWithCodeTags(String(data));
  }

  const spaces = "  ".repeat(indent);
  let xml = "";

  if (Array.isArray(data)) {
    for (const item of data) {
      const child = jsonToXml(item, indent + 1);
      if (child.includes("\n")) {
        xml += `${spaces}<item>\n${child}\n${spaces}</item>\n`;
      } else {
        xml += `${spaces}<item>${child}</item>\n`;
      }
    }
    return xml.trimEnd();
  }

  for (const [rawKey, val] of Object.entries(data)) {
    const tag = sanitizeXmlTag(rawKey);
    if (val === null || val === undefined) {
      xml += `${spaces}<${tag}></${tag}>\n`;
    } else if (typeof val === "object") {
      const child = jsonToXml(val, indent + 1);
      if (child) {
        xml += `${spaces}<${tag}>\n${child}\n${spaces}</${tag}>\n`;
      } else {
        xml += `${spaces}<${tag}></${tag}>\n`;
      }
    } else {
      const formattedVal = formatTextWithCodeTags(String(val));
      if (formattedVal.includes("\n")) {
        xml += `${spaces}<${tag}>\n${formattedVal}\n${spaces}</${tag}>\n`;
      } else {
        xml += `${spaces}<${tag}>${formattedVal}</${tag}>\n`;
      }
    }
  }

  return xml.trimEnd();
}

export function formatToolResultToXml(content, toolName = "tool", toolCallId = "") {
  let parsed = null;
  let rawText = "";

  if (typeof content === "object" && content !== null) {
    parsed = content;
  } else if (typeof content === "string") {
    rawText = content.trim();
    if ((rawText.startsWith("{") && rawText.endsWith("}")) || 
        (rawText.startsWith("[") && rawText.endsWith("]"))) {
      try {
        parsed = JSON.parse(rawText);
        if (typeof parsed === "string" && 
            ((parsed.startsWith("{") && parsed.endsWith("}")) || 
             (parsed.startsWith("[") && parsed.endsWith("]")))) {
          try { parsed = JSON.parse(parsed); } catch (e) {}
        }
      } catch (e) {
        parsed = null;
      }
    }
  } else if (content !== undefined && content !== null) {
    rawText = String(content).trim();
  }

  if (parsed === null) {
    if (rawText.startsWith("<") && rawText.endsWith(">")) {
      return rawText;
    }
    const isErrorText = /^(error|fatal|fail|exception):/i.test(rawText);
    const tag = isErrorText ? "error" : "output";
    return `<${tag}>\n${rawText}\n</${tag}>`;
  }

  if (parsed && typeof parsed === "object" && Array.isArray(parsed.content)) {
    const isErr = parsed.isError === true;
    let out = `  <status>${isErr ? "error" : "success"}</status>\n`;
    for (const item of parsed.content) {
      if (item && item.type === "text" && typeof item.text === "string") {
        out += `  <content>\n${formatTextWithCodeTags(item.text)}\n  </content>\n`;
      } else if (item && typeof item === "object") {
        out += `  <content_block type="${escapeXmlAttr(item.type || "unknown")}">\n${jsonToXml(item, 2)}\n  </content_block>\n`;
      }
    }
    return out.trim();
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && 
      (parsed.stdout !== undefined || parsed.stderr !== undefined || parsed.exitCode !== undefined || parsed.exit_code !== undefined)) {
    let out = "";
    const exitCode = parsed.exitCode !== undefined ? parsed.exitCode : parsed.exit_code;
    const isErr = (exitCode !== undefined && exitCode !== 0) || (parsed.stderr && !parsed.stdout);
    out += `  <status>${isErr ? "error" : "success"}</status>\n`;
    if (exitCode !== undefined) {
      out += `  <exit_code>${exitCode}</exit_code>\n`;
    }
    if (parsed.stdout) {
      out += `  <stdout>\n${formatTextWithCodeTags(parsed.stdout)}\n  </stdout>\n`;
    }
    if (parsed.stderr) {
      out += `  <stderr>\n${formatTextWithCodeTags(parsed.stderr)}\n  </stderr>\n`;
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (["stdout", "stderr", "exitCode", "exit_code"].includes(k)) continue;
      const valXml = jsonToXml({ [k]: v }, 1);
      if (valXml) out += `${valXml}\n`;
    }
    return out.trim();
  }

  return jsonToXml(parsed, 1).trim();
}

export function formatMessagesToPrompt(messages, tools = []) {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  const systemParts = messages
    .filter(m => (m.role === "system" || m.role === "developer") && m.content)
    .map(m => extractTextContent(m.content))
    .filter(Boolean);

  const hasTools = Array.isArray(tools) && tools.length > 0;

  if (hasTools) {
    let toolListStr = "";
    const isLargeToolSet = tools.length > 10;

    tools.forEach((t, idx) => {
      const fn = t.function || t;
      const desc = fn.description ? ` (${fn.description.slice(0, isLargeToolSet ? 100 : 300)}${isLargeToolSet && fn.description.length > 100 ? "..." : ""})` : "";
      let params = "";
      if (fn.parameters && fn.parameters.properties) {
        params = Object.keys(fn.parameters.properties).join(", ");
      }
      toolListStr += `${idx + 1}. ${fn.name}(${params})${desc}\n`;
    });

    let toolDirective = `<zerollm_available_tools>\n${toolListStr.trim()}\n</zerollm_available_tools>\n\n`;
    toolDirective += "[ATURAN PEMANGGILAN TOOL - OPENAI SPEC]\n";
    toolDirective += "Gunakan fungsi di dalam tag <zerollm_available_tools> jika permintaan pengguna membutuhkan aksi atau data eksternal.\n";
    toolDirective += "Anda WAJIB memanggil fungsinya dengan format tag resmi berikut tanpa teks pembuka/penutup lainnya:\n";
    toolDirective += '<zerollm_tool_call name="nama_fungsi">{"parameter": "nilai"}</zerollm_tool_call>\n';
    toolDirective += "Contoh:\n";
    toolDirective += '<zerollm_tool_call name="get_current_weather">{"location": "Jakarta"}</zerollm_tool_call>\n\n';
    toolDirective += "[HASIL PEMANGGILAN TOOL - XML FORMAT]:\n";
    toolDirective += "Hasil eksekusi fungsi/tool dari sistem akan dikirimkan kembali dalam format XML terstruktur di dalam tag:\n";
    toolDirective += '<zerollm_tool_result name="nama_fungsi" call_id="...">\n';
    toolDirective += '  <status>success</status>\n';
    toolDirective += '  <output>...</output>\n';
    toolDirective += '</zerollm_tool_result>\n';
    toolDirective += "Pahami dan evaluasi tag-tag XML di dalam hasil tool tersebut secara seksama.\n\n";
    toolDirective += "[EFISIENSI EKSEKUSI PERINTAH SHELL / LINUX]:\n";
    toolDirective += "Jika Anda menggunakan tool yang berhubungan dengan shell/terminal (seperti exec, bash, terminal, dll.):\n";
    toolDirective += "1. Mode Langsung (Chaining '&&'): Gabungkan perintah-perintah Linux yang berurutan atau saling berkaitan ke dalam satu perintah tunggal menggunakan operator '&&' (atau ';' / '|' jika relevan) untuk meminimalkan putaran giliran.\n";
    toolDirective += '   Contoh: <zerollm_tool_call name="exec">{"command": "cd /root/app && git pull && npm test"}</zerollm_tool_call>\n';
    toolDirective += "2. Mode Background / Daemon (Single Shell Environment): Shell dieksekusi secara sekuensial. Jangan biarkan proses jangka panjang (server, watcher, daemon) blocking/hang.\n";
    toolDirective += "   Jika perlu restart atau menjalankan service di background, gunakan pola mandiri POSIX berikut:\n";
    toolDirective += "   - Matikan proses sebelumnya yang serupa agar port tidak konflik: kill -9 <PID_LAMA> 2>/dev/null (atau pkill -f \"<nama_proses>\" 2>/dev/null)\n";
    toolDirective += "   - Beri jeda 1 detik agar port rilis sempurna: sleep 1\n";
    toolDirective += "   - Muat PATH binary environment ($HOME/.bun/bin, dll.) dan cd ke direktori proyek\n";
    toolDirective += "   - Jalankan dengan nohup di background dan segera cetak PID ($!) agar tool langsung mengembalikan status sukses tanpa menunggu proses selesai\n";
    toolDirective += "   Pola Standar: kill -9 <PID_SEBELUMNYA> 2>/dev/null; sleep 1; export PATH=\"$HOME/.bun/bin:$PATH\" && cd <dir_proyek> && nohup <COMMAND> > /dev/null 2>&1 & echo \"<nama_service> started PID: $!\"\n";
    toolDirective += '   Contoh: <zerollm_tool_call name="exec">{"command": "pkill -f \\"node server.js\\" 2>/dev/null; sleep 1; export PATH=\\"$HOME/.bun/bin:$PATH\\" && cd /app && nohup node server.js > /dev/null 2>&1 & echo \\"App started PID: $!\\""}</zerollm_tool_call>\n';
    toolDirective += "3. Multi-Step Chaining: Anda bebas melanjutkan dengan pemanggilan tool berikutnya secara bertahap jika informasi belum lengkap.";

    systemParts.push(toolDirective);
  }

  const codeDirective = [
    "[ATURAN PENULISAN KODE / SNIPPET]",
    "Jika jawaban Anda memuat kode pemrograman, script shell/bash, konfigurasi, atau cuplikan kode (snippet):",
    "Anda WAJIB membungkus seluruh blok kode di dalam tag resmi:",
    "<zerollm_code>",
    "// Tulis kode atau snippet di sini",
    "</zerollm_code>",
    "(Atau dengan atribut bahasa: <zerollm_code lang=\"python\">...</zerollm_code>)",
    "DILARANG KERAS menggunakan format markdown triple backticks (``` atau ```lang) untuk kode. Semua kode WAJIB ditempatkan di dalam tag <zerollm_code>.",
    "Catatan: Tag <zerollm_code> juga dapat digunakan di dalam pemanggilan tool jika relevan."
  ].join("\n");
  systemParts.push(codeDirective);

  const systemInstruction = systemParts.join("\n\n");
  const convo = messages.filter(m => m.role !== "system" && m.role !== "developer");
  const hasToolResultInHistory = convo.some(m => m.role === "tool" || m.role === "toolResult");

  let endGuidance = "\n\n[PANDUAN CARA MENJAWAB UNTUK AI]:\n";
  if (hasTools) {
    endGuidance += "1. Tahap 1 (Pemanggilan Tool): Jika pertanyaan pengguna membutuhkan data eksternal/fungsi di atas, JANGAN meminta maaf atau menolak dengan alasan tidak ada akses. Sistem ZeroLLM yang akan mengeksekusinya untuk Anda!\n";
    endGuidance += "   Anda WAJIB LANGSUNG membalas HANYA dengan tag pemanggilan tool:\n";
    endGuidance += '   <zerollm_tool_call name="nama_fungsi">{"parameter": "nilai"}</zerollm_tool_call>\n';
    endGuidance += "   Untuk perintah shell: Gabungkan langkah terkait menggunakan '&&', atau gunakan 'background': true jika berupa proses daemon.\n";
  }
  if (hasToolResultInHistory) {
    endGuidance += "2. Tahap 2 (Evaluasi Hasil Tool & Multi-Step Execution):\n";
    endGuidance += "   - Evaluasi secara kritis apakah data XML di dalam <zerollm_tool_result> sudah cukup, valid, dan menjawab tuntas permintaan pengguna.\n";
    endGuidance += "   - JIKA data masih kurang lengkap, kosong, error, atau membutuhkan investigasi lanjutan (misal: membaca file lain, mencoba perintah alternatif, atau mencari informasi tambahan): Anda WAJIB MEMANGGIL TOOL BERIKUTNYA dengan tag:\n";
    endGuidance += '     <zerollm_tool_call name="nama_fungsi">{"parameter": "nilai"}</zerollm_tool_call>\n';
    endGuidance += "   - JIKA seluruh data sudah lengkap dan memuaskan: Berikan jawaban akhir secara mendalam, langsung, dan alami kepada pengguna tanpa tag tool apapun.\n";
  }
  if (!hasTools && !hasToolResultInHistory) {
    endGuidance += "Jawablah permintaan pengguna di dalam <zerollm_user> terakhir secara langsung dan alami tanpa menyertakan tag <zerollm_*> apapun.";
  } else {
    endGuidance += "3. Jika pertanyaan pengguna TIDAK membutuhkan tool sama sekali, jawablah langsung secara alami tanpa tag <zerollm_*> apapun.";
  }
  endGuidance += "\n[ATURAN KODE]: Ingat, JANGAN gunakan format markdown ``` untuk kode atau snippet. Gunakan selalu tag <zerollm_code>...</zerollm_code>.";

  if (convo.length === 0) {
    return `<zerollm_system>\n${stripInboundMeta(systemInstruction)}\n</zerollm_system>${endGuidance}`;
  }

  if (convo.length === 1 && convo[0].role === "user") {
    const userPrompt = stripInboundMeta(extractTextContent(convo[0].content));
    let result = "";
    if (systemInstruction) {
      result = `<zerollm_system>\n${stripInboundMeta(systemInstruction)}\n</zerollm_system>\n\n<zerollm_user>\n${userPrompt}\n</zerollm_user>`;
    } else {
      result = `<zerollm_user>\n${userPrompt}\n</zerollm_user>`;
    }
    return (result + endGuidance).trim();
  }

  let promptBuilder = "";
  if (systemInstruction) {
    promptBuilder += `<zerollm_system>\n${stripInboundMeta(systemInstruction)}\n</zerollm_system>\n\n`;
  }

  for (let i = 0; i < convo.length - 1; i++) {
    const msg = convo[i];
    const text = stripInboundMeta(extractTextContent(msg.content));
    if (msg.role === "tool" || msg.role === "toolResult") {
      const toolName = resolveToolName(convo, msg);
      const callId = msg.tool_call_id || msg.id || "";
      const idAttr = callId ? ` call_id="${escapeXmlAttr(callId)}"` : "";
      const xmlBody = formatToolResultToXml(msg.content, toolName, callId);
      promptBuilder += `<zerollm_tool_result name="${escapeXmlAttr(toolName)}"${idAttr}>\n${xmlBody}\n</zerollm_tool_result>\n\n`;
    } else if (msg.role === "assistant") {
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const callsStr = msg.tool_calls.map(tc => `<zerollm_tool_call name="${tc.function?.name || tc.name}">${tc.function?.arguments || JSON.stringify(tc.arguments || {})}</zerollm_tool_call>`).join("\n");
        promptBuilder += `<zerollm_assistant>\n${callsStr}\n</zerollm_assistant>\n\n`;
      } else {
        promptBuilder += `<zerollm_assistant>\n${text}\n</zerollm_assistant>\n\n`;
      }
    } else {
      promptBuilder += `<zerollm_user>\n${text}\n</zerollm_user>\n\n`;
    }
  }

  const lastMsg = convo[convo.length - 1];
  const lastText = stripInboundMeta(extractTextContent(lastMsg.content));
  if (lastMsg.role === "tool" || lastMsg.role === "toolResult") {
    const toolName = resolveToolName(convo, lastMsg);
    const callId = lastMsg.tool_call_id || lastMsg.id || "";
    const idAttr = callId ? ` call_id="${escapeXmlAttr(callId)}"` : "";
    const xmlBody = formatToolResultToXml(lastMsg.content, toolName, callId);
    promptBuilder += `<zerollm_tool_result name="${escapeXmlAttr(toolName)}"${idAttr}>\n${xmlBody}\n</zerollm_tool_result>\n\nEvaluasi hasil tool '${toolName}' di atas: jika informasi sudah lengkap dan memuaskan, berikan jawaban akhir yang tuntas; jika belum memuaskan atau butuh langkah investigasi lanjutan, panggil tool berikutnya yang relevan menggunakan <zerollm_tool_call>.`;
  } else {
    promptBuilder += `<zerollm_user>\n${lastText}\n</zerollm_user>`;
  }

  promptBuilder += endGuidance;
  return promptBuilder.trim();
}

export function stripInboundMeta(text) {
  if (!text) return "";
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

export function stripZeroLlmTags(content) {
  if (!content || typeof content !== "string") return content;
  return content
    .replace(/<zerollm_available_tools>[\s\S]*?<\/zerollm_available_tools>/gi, "")
    .replace(/^<zerollm_assistant>\s*/i, "")
    .replace(/\s*<\/zerollm_assistant>$/i, "")
    .trim();
}

/**
 * Memeriksa apakah terdapat tag pembuka tool call yang belum memiliki tag penutup
 */
export function hasUnclosedToolTag(text) {
  if (!text || typeof text !== "string") return false;

  const toolTagNames = [
    "zerollm_tool_call",
    "zerollm_call",
    "zerollm:call",
    "action",
    "call",
    "tool_call",
    "function",
    "invoke",
    "zerollm_code"
  ];

  for (const name of toolTagNames) {
    const escapedName = name.replace(":", "\\:");
    const openRegex = new RegExp(`<${escapedName}\\b[^>]*>`, "gi");
    const closeRegex = new RegExp(`</${escapedName}>`, "gi");

    const openCount = (text.match(openRegex) || []).length;
    const closeCount = (text.match(closeRegex) || []).length;

    if (openCount > closeCount) {
      return true;
    }
  }

  return false;
}

/**
 * Secara otomatis menutup tag tool call yang belum tertutup (fail-safe penutup tag)
 */
export function autoCloseToolTagsIfNeeded(text) {
  if (!text || typeof text !== "string") return text;

  const toolTagNames = [
    "zerollm_tool_call",
    "zerollm_call",
    "zerollm:call",
    "action",
    "call",
    "tool_call",
    "function",
    "invoke",
    "zerollm_code"
  ];

  let repaired = text;
  for (const name of toolTagNames) {
    const escapedName = name.replace(":", "\\:");
    const openRegex = new RegExp(`<${escapedName}\\b[^>]*>`, "gi");
    const closeRegex = new RegExp(`</${escapedName}>`, "gi");

    const openCount = (repaired.match(openRegex) || []).length;
    const closeCount = (repaired.match(closeRegex) || []).length;

    if (openCount > closeCount) {
      const missing = openCount - closeCount;
      for (let i = 0; i < missing; i++) {
        repaired += `</${name}>`;
      }
    }
  }

  return repaired;
}

