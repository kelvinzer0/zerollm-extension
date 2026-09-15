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

/**
 * Memproses stream delta dengan buffering cerdas untuk tag <zerollm* dan pemanggilan tool.
 * Jika teks sedang menulis tag pembuka <zerollm* atau tag tool eksternal yang belum selesai,
 * tahan (buffer) potongan tersebut dan JANGAN distreaming ke klien sampai tag penutupnya tiba.
 */
export function processStreamDelta(requestId, deltaContent, isToolCallChecker) {
  if (!deltaContent || typeof deltaContent !== "string") return null;

  let buffer = (streamBuffers.get(requestId) || "") + deltaContent;
  let outToStream = "";

  while (buffer.length > 0) {
    const tagMatch = buffer.match(/<(?:zerollm[_\w:]*|tool_call|action|call|function|invoke)\b/i);

    if (!tagMatch) {
      const partialTagMatch = buffer.match(/<[a-zA-Z0-9_:*-]*$/);
      const isPotentialToolTag = partialTagMatch && [
        "zerollm",
        "tool_call",
        "action",
        "call",
        "function",
        "invoke"
      ].some(prefix => prefix.startsWith(partialTagMatch[0].slice(1).toLowerCase()));

      if (isPotentialToolTag) {
        const safeText = buffer.slice(0, partialTagMatch.index);
        outToStream += safeText;
        buffer = buffer.slice(partialTagMatch.index);
        break;
      } else {
        outToStream += buffer;
        buffer = "";
        break;
      }
    }

    const tagStartIndex = tagMatch.index;

    if (tagStartIndex > 0) {
      outToStream += buffer.slice(0, tagStartIndex);
      buffer = buffer.slice(tagStartIndex);
    }

    const closeMatch = buffer.match(/<\/(?:zerollm[_\w:]*|tool_call|action|call|function|invoke)>/i);

    if (!closeMatch) {
      break;
    }

    const tagEndIndex = closeMatch.index + closeMatch[0].length;
    const completeTagBlock = buffer.slice(0, tagEndIndex);
    buffer = buffer.slice(tagEndIndex);

    const isToolCallBlock = (typeof isToolCallChecker === "function" && isToolCallChecker(completeTagBlock)) ||
                            /<(?:zerollm_tool_call|zerollm_call|action|call|tool_call)\b/i.test(completeTagBlock) ||
                            /<\/(?:zerollm_tool_call|zerollm_call|action|call|tool_call)>/i.test(completeTagBlock);

    if (isToolCallBlock) {
      console.log(`[ZeroLLM StreamBuffer] 🛡️ Suppressed tool call tag from text stream (${completeTagBlock.length} chars)`);
    } else {
      outToStream += completeTagBlock;
    }
  }

  streamBuffers.set(requestId, buffer);
  return outToStream || null;
}

export function deleteStreamBuffer(requestId) {
  streamBuffers.delete(requestId);
}
