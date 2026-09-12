/**
 * Default preset model configurations for popular AI chatbots
 * 
 * Verified live using browser-automation:
 * 1. ChatGPT:
 *    - Input: #prompt-textarea, textarea[id='prompt-textarea'], div[id='prompt-textarea'], textarea[placeholder*='Message']
 *    - Submit/Done: button[data-testid='send-button'], button[aria-label*='Kirim'], button[aria-label*='Send']
 *    - Stream: button[data-testid='stop-button'], button[aria-label*='Berhenti'], button[aria-label*='Stop']
 *    - Response container: [data-message-author-role='assistant'], article [data-message-author-role='assistant'] .markdown, .agent-turn
 * 
 * 2. ChatSmith (chatsmith.io):
 *    - Input: [contenteditable='true'], div.ProseMirror, textarea, [placeholder*='Talk with Chat Smith']
 *    - Submit/Done: button:has(svg), .send-btn, button[type='submit']
 *    - Stream: button.stop, .streaming, [aria-label*='Stop']
 *    - Response container: .message-ai, .chat-bubble-bot, .response-content
 */

export const DEFAULT_PRESETS = [
  {
    id: "chatgpt",
    name: "ChatGPT (Web)",
    enabled: true,
    urlPattern: "*://chatgpt.com/*",
    newChatSelector: "a[href='/'], [data-testid='new-chat-button'], [aria-label*='Obrolan baru'], [aria-label*='New chat']",
    startChatSelector: "#prompt-textarea, textarea[id='prompt-textarea'], div#prompt-textarea, [data-testid='prompt-textarea'], #mobile-composer-prompt, textarea[id*='composer'], textarea[placeholder], textarea, [contenteditable='true']",
    continueChatSelector: "#prompt-textarea, textarea[id='prompt-textarea'], div#prompt-textarea, [data-testid='prompt-textarea'], #mobile-composer-prompt, textarea[id*='composer'], textarea[placeholder], textarea, [contenteditable='true']",
    streamSelector: "button[data-testid='stop-button'], button[aria-label*='Berhenti'], button[aria-label*='Stop'], button.bg-black .icon-lg, [data-testid='fruitjuice-send-button']:has(svg path[d*='M2 12'])",
    doneSelector: "button[data-testid='send-button']:not([disabled]), button.wm-composer-submitButton:not([disabled]), button[aria-label*='Kirim']:not([disabled]), button[aria-label*='Send']:not([disabled])",
    resultContainerSelector: "div[data-message-author-role='assistant'], .agent-turn [data-message-author-role='assistant'], [data-message-author-role='assistant'] .markdown, [class*='assistantMessage'] [class*='messageCopy'], [class*='assistantMessage'], [class*='agent-turn']",
    description: "Official OpenAI ChatGPT Web Interface (Desktop & Mobile DOM Verified Live)"
  },
  {
    id: "chatsmith",
    name: "ChatSmith AI",
    enabled: true,
    urlPattern: "*://chatsmith.io/*",
    newChatSelector: "[aria-label*='New chat'], .new-chat-btn, a[href='/conversation'], button:has(svg path[d*='M12 4'])",
    startChatSelector: "[contenteditable='true'], div.ProseMirror, textarea, [aria-label*='Chat Smith'], [placeholder*='Talk with Chat Smith']",
    continueChatSelector: "[contenteditable='true'], div.ProseMirror, textarea, [aria-label*='Chat Smith'], [placeholder*='Talk with Chat Smith']",
    streamSelector: "button[aria-label*='Stop'], button.stop-button, .streaming, .typing-indicator, [class*='stop'], button:has([class*='stop'])",
    doneSelector: "button[aria-label*='Send']:not([disabled]), form button[type='submit']:not([disabled]), .send-button:not([disabled]), button.send-btn:not([disabled])",
    resultContainerSelector: ".message-ai .content, .chat-bubble-bot .text, .assistant-message, .message-content, [class*='bot-message'], [class*='ai-message'], .markdown",
    description: "ChatSmith Web AI Interface (Verified Live)"
  },
  {
    id: "claude",
    name: "Claude AI (Anthropic)",
    enabled: true,
    urlPattern: "*://claude.ai/*",
    newChatSelector: "a[href='/new'], button[aria-label*='New chat']",
    startChatSelector: "div[contenteditable='true'], fieldset div[contenteditable='true'], [aria-label*='Write your prompt']",
    continueChatSelector: "div[contenteditable='true'], fieldset div[contenteditable='true'], [aria-label*='Write your prompt']",
    streamSelector: "button[aria-label*='Stop response'], button[aria-label*='Stop'], .stop-button",
    doneSelector: "button[aria-label*='Send Message'], button[aria-label*='Send'], .font-claude-message",
    resultContainerSelector: ".font-claude-message, [data-is-streaming='false'], .standard-markdown",
    description: "Anthropic Claude Web Interface"
  },
  {
    id: "gemini",
    name: "Google Gemini",
    enabled: true,
    urlPattern: "*://gemini.google.com/*",
    newChatSelector: "[aria-label*='New chat'], [aria-label*='Percakapan baru'], a[href='/app']",
    startChatSelector: ".ql-editor, div[contenteditable='true'], textarea[aria-label*='prompt']",
    continueChatSelector: ".ql-editor, div[contenteditable='true'], textarea[aria-label*='prompt']",
    streamSelector: "button[aria-label*='Stop'], button[aria-label*='Berhenti'], .sparkle-animation",
    doneSelector: "button[aria-label*='Send message'], button[aria-label*='Kirim pesan'], message-content",
    resultContainerSelector: "message-content, .model-response-text, .response-container-content",
    description: "Google Gemini Web Interface"
  },
  {
    id: "generic-ai",
    name: "Generic AI Chatbot",
    enabled: true,
    urlPattern: "*://*/*",
    startChatSelector: "textarea, input[type='text'], [contenteditable='true']",
    continueChatSelector: "textarea, input[type='text'], [contenteditable='true']",
    streamSelector: "button[aria-label*='Stop'], .streaming, .typing, [data-state='streaming']",
    doneSelector: "button[type='submit'], button[aria-label*='Send'], .message-assistant, .bot-response",
    resultContainerSelector: ".message-assistant, .bot-response, .markdown, article",
    description: "Generic AI Chatbot Pattern"
  }
];
