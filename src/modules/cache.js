/**
 * ZeroLLM In-Memory Response Cache & Stream Buffering Module
 */

const responseCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 menit TTL
const streamBuffers = new Map();

export function getCacheKey(modelId, query) {
  return `${modelId}:::${(query || "").trim()}`;
}

export function getFromCache(modelId, query) {
  const key = getCacheKey(modelId, query);
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return cached;
}

export function saveToCache(modelId, query, result) {
  if (!query || !result) return;
  const key = getCacheKey(modelId, query);
  responseCache.set(key, {
    content: result.content,
    tool_calls: result.tool_calls,
    finish_reason: result.finish_reason || "stop",
    usage: result.usage,
    timestamp: Date.now()
  });
  if (responseCache.size > 200) {
    const firstKey = responseCache.keys().next().value;
    responseCache.delete(firstKey);
  }
}

const WATCHED_PREFIXES = [
  "zerollm",
  "tool_call",
  "action",
  "call",
  "function",
  "invoke",
  "dsml",
  "|",
  "｜"
];

function isPotentialWatchedTag(tagStr) {
  if (!tagStr || !tagStr.startsWith("<")) return false;
  const namePart = tagStr.replace(/^<\/?/, "").toLowerCase();
  if (!namePart) return true; // just '<' or '</'
  if (/^[|｜\s]*dsml/i.test(namePart) || /^[|｜]/.test(namePart)) return true;
  return WATCHED_PREFIXES.some(p => p.startsWith(namePart) || namePart.startsWith(p));
}

/**
 * Memproses stream delta dengan buffering / pooling cerdas untuk tag <zerollm* dan pemanggilan tool.
 * Jika teks sedang menulis tag pembuka <zerollm*, tag penutup </zerollm*, atau tag tool eksternal yang belum selesai:
 * Tahan (pool) potongan tersebut dan JANGAN distreaming ke klien sampai tag tersebut lengkap dan jelas.
 * - Tag tool call dan metadata (<zerollm_tool_call>...</zerollm_tool_call>, <tool_call>, dll.) ditekan 100% dari stream teks.
 * - Tag penutup stray (seperti </zerollm_tool_call>) dibuang bersih.
 * - Tag <zerollm_code> dinormalisasi menjadi blok kode markdown bersih ```.
 */
export function processStreamDelta(requestId, deltaContent, isToolCallChecker) {
  if (!deltaContent || typeof deltaContent !== "string") return null;

  let buffer = (streamBuffers.get(requestId) || "") + deltaContent;
  let outToStream = "";

  while (buffer.length > 0) {
    // 1. Cari kemunculan tag lengkap yang kita awasi:
    const tagRegex = /<\/?(?:zerollm[_\w:]*|tool_call|action|call|function|invoke|[|｜\s]*dsml[|｜\s]*\w*)\b[^>]*>/i;
    const match = buffer.match(tagRegex);

    if (match) {
      const tagStartIndex = match.index;
      const matchedTag = match[0];

      // Jika ada teks biasa sebelum tag, keluarkan teks tersebut ke stream
      if (tagStartIndex > 0) {
        outToStream += buffer.slice(0, tagStartIndex);
        buffer = buffer.slice(tagStartIndex);
      }

      // buffer sekarang diawali dengan matchedTag:
      // Kasus A: Tag kode <zerollm_code>
      const codeOpen = matchedTag.match(/^<zerollm_code(?:[\s]+lang=["']?([a-zA-Z0-9_-]*)["']?)?[^>]*>/i);
      if (codeOpen) {
        const lang = codeOpen[1] || "";
        buffer = buffer.slice(matchedTag.length);
        outToStream += lang ? `\n\`\`\`${lang}\n` : "\n```\n";
        continue;
      }
      if (/^<\/zerollm_code>/i.test(matchedTag)) {
        buffer = buffer.slice(matchedTag.length);
        outToStream += "\n```\n";
        continue;
      }

      // Kasus B: Tag assistant wrapper <zerollm_assistant> atau </zerollm_assistant>
      if (/^<\/?zerollm_assistant>/i.test(matchedTag)) {
        buffer = buffer.slice(matchedTag.length);
        continue;
      }

      // Kasus C: Tag penutup stray (misal: </zerollm_tool_call>, </tool_call>, </action>, dll.)
      if (/^<\//.test(matchedTag)) {
        buffer = buffer.slice(matchedTag.length);
        console.log(`[ZeroLLM StreamBuffer] 🛡️ Suppressed stray closing tag from stream (${matchedTag})`);
        continue;
      }

      // Kasus D: Tag pembuka blok yang harus ditekan (tool call, available tools, system, thought, dsml, dll.)
      // Cari tag penutup yang cocok untuk mengonsumsi seluruh blok (utamakan tag penutup yang sepadan)
      let closeRegex;
      const rawTagName = matchedTag.replace(/^<\/?/, "").replace(/>$/, "").trim();
      if (/^[|｜\s]*dsml[|｜\s]*calls/i.test(rawTagName)) {
        closeRegex = /<\/[|｜\s]*dsml[|｜\s]*calls>/i;
      } else if (/^[|｜\s]*dsml[|｜\s]*invoke/i.test(rawTagName)) {
        closeRegex = /<\/[|｜\s]*dsml[|｜\s]*invoke>/i;
      } else if (/^zerollm_tool_call/i.test(rawTagName)) {
        closeRegex = /<\/zerollm_tool_call>/i;
      } else if (/^zerollm_available_tools/i.test(rawTagName)) {
        closeRegex = /<\/zerollm_available_tools>/i;
      } else if (/^tool_call/i.test(rawTagName)) {
        closeRegex = /<\/tool_call>/i;
      } else {
        closeRegex = /<\/(?:zerollm[_\w:]*|tool_call|action|call|function|invoke|[|｜\s]*dsml[|｜\s]*\w*)>/i;
      }

      const closeMatch = buffer.match(closeRegex);

      if (!closeMatch) {
        // Tag penutup belum tiba, tahan seluruh blok di pool!
        break;
      }

      const blockEndIndex = closeMatch.index + closeMatch[0].length;
      const completeBlock = buffer.slice(0, blockEndIndex);
      buffer = buffer.slice(blockEndIndex);

      console.log(`[ZeroLLM StreamBuffer] 🛡️ Suppressed complete tool/zerollm tag block (${completeBlock.length} chars)`);
      continue;
    }

    // 2. Jika tidak ada tag lengkap dengan '>', periksa apakah di AKHIR buffer
    // terdapat tag yang belum selesai ditutup (misal: "<zerollm_tool_call name=" atau "</zerollm_tool_call" atau "<" atau "</z")
    const unclosedTagMatch = buffer.match(/<\/?(?:zerollm[_\w:]*|tool_call|action|call|function|invoke|[|｜\s]*dsml[|｜\s]*\w*)\b[^>]*$/i);
    if (unclosedTagMatch) {
      const safeText = buffer.slice(0, unclosedTagMatch.index);
      outToStream += safeText;
      buffer = buffer.slice(unclosedTagMatch.index);
      break;
    }

    const partialPrefixMatch = buffer.match(/<\/?([a-zA-Z0-9_:*|｜-]*)$/);
    if (partialPrefixMatch && isPotentialWatchedTag(partialPrefixMatch[0])) {
      // Ada potongan tag potensial di ujung buffer:
      // Keluarkan teks aman sebelum tanda '<' dan tahan potongan tag di pool (buffer)
      const safeText = buffer.slice(0, partialPrefixMatch.index);
      outToStream += safeText;
      buffer = buffer.slice(partialPrefixMatch.index);
      break;
    }

    // 3. Seluruh buffer aman (tidak ada tag lengkap dan tidak ada partial tag yang dicurigai)
    outToStream += buffer;
    buffer = "";
    break;
  }

  streamBuffers.set(requestId, buffer);
  return outToStream || null;
}

export function deleteStreamBuffer(requestId) {
  streamBuffers.delete(requestId);
}

export function flushStreamBuffer(requestId) {
  const remaining = streamBuffers.get(requestId) || "";
  streamBuffers.delete(requestId);
  if (!remaining) return "";
  // Buang jika berupa tag zerollm atau tool call atau DSML yang belum tertutup
  if (/^<\/?(?:zerollm[_\w:]*|tool_call|action|call|function|invoke|[|｜\s]*dsml)\b/i.test(remaining)) {
    return "";
  }
  return remaining;
}
