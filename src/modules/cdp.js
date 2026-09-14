/**
 * ZeroLLM Native Hardware Input Injection via Chrome DevTools Protocol (CDP)
 * 
 * Bypasses virtual DOM / React Lexical / ProseMirror synthetic barriers
 * by dispatching hardware-level keyboard events.
 */

export async function nativeTypeAndSend(tabId, text, modelConfig) {
  const debuggee = { tabId };
  let attached = false;

  try {
    // 1. Minta content script fokus ke input box DAN langsung ketik teks via enterPrompt
    const focusRes = await chrome.tabs.sendMessage(tabId, {
      type: "focusInput",
      modelConfig,
      query: text
    }).catch(() => null);

    // Jika content.js sudah mengetik langsung DAN submit berhasil diklik, skip CDP
    if (focusRes?.directTyped && focusRes?.submitted) {
      console.log(`[ZeroLLM CDP] Text typed and submitted directly by content.js on tab #${tabId}`);
      return {
        success: true,
        initialCount: focusRes?.initialCount || 0,
        initialText: focusRes?.initialText || ""
      };
    }

    await new Promise(r => setTimeout(r, 60));

    // 2. Fallback: Attach Chrome Debugger untuk mengetik via CDP
    await chrome.debugger.attach(debuggee, "1.3");
    attached = true;

    // 3. Ketikkan teks menggunakan Input.insertText
    await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text });
    
    // Jeda 120ms agar React Lexical / ProseMirror selesai memproses state internal
    await new Promise(r => setTimeout(r, 120));

    // 4. Tekan tombol Enter menggunakan Input.dispatchKeyEvent standar keyboard hardware
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      macCharCode: 13,
      text: "\r",
      unmodifiedText: "\r"
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    });

    await new Promise(r => setTimeout(r, 80));

    // Pastikan tombol Kirim/Submit terklik jika Enter hardware tidak otomatis men-submit
    await chrome.tabs.sendMessage(tabId, {
      type: "clickSubmitIfActive",
      modelConfig
    }).catch(() => {});

    console.log(`[ZeroLLM CDP] Successfully typed and pressed Enter via Chrome Debugger on tab #${tabId}`);
    return {
      success: true,
      initialCount: focusRes?.initialCount || 0,
      initialText: focusRes?.initialText || ""
    };
  } catch (err) {
    console.warn("[ZeroLLM CDP] nativeTypeAndSend fallback to DOM:", err.message);
    return { success: false };
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach(debuggee);
      } catch (e) {}
    }
  }
}
