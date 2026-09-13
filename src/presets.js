/**
 * Default preset model configurations for popular AI chatbots
 * 
 * Comprehensive preset catalog covering:
 * 1. ChatGPT (OpenAI)
 * 2. ChatSmith (ChatSmith AI)
 * 3. Claude (Anthropic)
 * 4. Google Gemini
 * 5. DeepSeek (DeepSeek AI - V3 & R1)
 * 6. Grok (xAI)
 * 7. Perplexity (Perplexity AI Search)
 * 8. Kimi (Moonshot AI)
 * 9. Qwen (Alibaba Tongyi Qianwen)
 * 10. Doubao (ByteDance)
 * 11. GLM / Zhipu (ChatGLM / Z.AI)
 * 12. Microsoft Copilot
 * 13. Mistral Le Chat (Mistral AI)
 * 14. Poe (Quora)
 * 15. Xiaomi MiMo Studio
 * 16. HuggingChat (Hugging Face)
 * 17. DuckDuckGo AI Chat
 * 18. Generic AI Chatbot (Universal Fallback)
 */

export const DEFAULT_PRESETS = [
  {
    id: "chatgpt",
    name: "ChatGPT (OpenAI)",
    enabled: true,
    defaultUrl: "https://chatgpt.com",
    urlPattern: "*://chatgpt.com/*",
    responseScope: "main, [role='main'], div[class*='react-scroll-to-bottom'], div[class*='conversation-turn'], div[class*='thread']",
    newChatSelector: "a[href='/'], [data-testid='new-chat-button'], [aria-label*='Obrolan baru'], [aria-label*='New chat'], [aria-label*='新聊天']",
    startChatSelector: "#prompt-textarea, textarea[id='prompt-textarea'], div#prompt-textarea, [data-testid='prompt-textarea'], #mobile-composer-prompt, textarea[id*='composer'], textarea[placeholder], textarea, [contenteditable='true']",
    continueChatSelector: "#prompt-textarea, textarea[id='prompt-textarea'], div#prompt-textarea, [data-testid='prompt-textarea'], #mobile-composer-prompt, textarea[id*='composer'], textarea[placeholder], textarea, [contenteditable='true']",
    streamSelector: "button[data-testid='stop-button'], button[aria-label*='Berhenti'], button[aria-label*='Stop'], button.bg-black .icon-lg, [data-testid='fruitjuice-send-button']:has(svg path[d*='M2 12'])",
    doneSelector: "button[data-testid='send-button']:not([disabled]), button.wm-composer-submitButton:not([disabled]), button[aria-label*='Kirim']:not([disabled]), button[aria-label*='Send']:not([disabled])",
    resultContainerSelector: "div[data-message-author-role='assistant'] .markdown, div[data-message-author-role='assistant']",
    description: "Official OpenAI ChatGPT Web Interface (GPT-4o, o1, o3-mini)"
  },
  {
    id: "chatsmith",
    name: "ChatSmith AI",
    enabled: true,
    defaultUrl: "https://chatsmith.io",
    urlPattern: "*://chatsmith.io/*",
    responseScope: "main, [class*='content-layout'], [class*='chat-area'], [class*='message-list'], [class*='conversation'], [class*='chat-body']",
    newChatSelector: "[aria-label*='New chat'], .new-chat-btn, a[href='/conversation'], button:has(svg path[d*='M12 4'])",
    startChatSelector: "[contenteditable='true'], div.ProseMirror, textarea, [aria-label*='Chat Smith'], [placeholder*='Talk with Chat Smith']",
    continueChatSelector: "[contenteditable='true'], div.ProseMirror, textarea, [aria-label*='Chat Smith'], [placeholder*='Talk with Chat Smith']",
    streamSelector: "button[aria-label*='Stop'], button.stop-button, .streaming, .typing-indicator, [class*='stop'], button:has([class*='stop'])",
    doneSelector: "button[aria-label*='Send']:not([disabled]), form button[type='submit']:not([disabled]), .send-button:not([disabled]), button.send-btn:not([disabled])",
    resultContainerSelector: "div.prose, .prose, [class*='styles_tableMarkdown'], .message-ai .content, .chat-bubble-bot .text, .assistant-message, .message-content, [class*='bot-message'], [class*='ai-message'], .markdown",
    description: "ChatSmith Web AI Interface (Verified Live)"
  },
  {
    id: "claude",
    name: "Claude AI (Anthropic)",
    enabled: true,
    defaultUrl: "https://claude.ai/new",
    urlPattern: "*://claude.ai/*",
    responseScope: "main, [class*='conversation'], [class*='chat-content'], [class*='messages'], [role='main']",
    newChatSelector: "a[href='/new'], button[aria-label*='New chat'], [aria-label*='Start new chat'], [aria-label*='Obrolan baru']",
    startChatSelector: "div[contenteditable='true'], fieldset div[contenteditable='true'], [aria-label*='Write your prompt'], div.ProseMirror, textarea",
    continueChatSelector: "div[contenteditable='true'], fieldset div[contenteditable='true'], [aria-label*='Write your prompt'], div.ProseMirror, textarea",
    streamSelector: "button[aria-label*='Stop response'], button[aria-label*='Stop'], button[aria-label*='Berhenti'], .stop-button, button[aria-label*='Stop generating'], [data-is-streaming='true']",
    doneSelector: "button[aria-label*='Send Message']:not([disabled]), button[aria-label*='Send']:not([disabled]), button[aria-label*='Kirim']:not([disabled]), button:has(svg path[d*='M2 12']):not([disabled])",
    resultContainerSelector: "div.font-claude-message, [class*='font-claude'], div[data-message-author-role='assistant'], div[data-testid='chat-message']:not([data-testid='user-message']) .grid, div[data-testid='chat-message']:not([data-testid='user-message']), article:has(button[aria-label*='Salin'], button[aria-label*='Copy'])",
    description: "Anthropic Claude Web Interface (Claude 3.5 Sonnet & Haiku)"
  },
  {
    id: "gemini",
    name: "Google Gemini",
    enabled: true,
    defaultUrl: "https://gemini.google.com/app",
    urlPattern: "*://gemini.google.com/*",
    responseScope: "main, [class*='conversation-container'], [class*='chat-history'], [role='main']",
    newChatSelector: "[aria-label*='New chat'], [aria-label*='Percakapan baru'], [aria-label*='发起新对话'], a[href='/app']",
    startChatSelector: ".ql-editor, div[contenteditable='true'], textarea[aria-label*='prompt'], rich-textarea textarea, textarea[placeholder*='Gemini']",
    continueChatSelector: ".ql-editor, div[contenteditable='true'], textarea[aria-label*='prompt'], rich-textarea textarea, textarea[placeholder*='Gemini']",
    streamSelector: "button[aria-label*='Stop'], button[aria-label*='Berhenti'], button[aria-label*='停止'], .sparkle-animation, [aria-label*='Stop generating']",
    doneSelector: "button[aria-label*='Send message']:not([disabled]), button[aria-label*='Kirim pesan']:not([disabled]), button[aria-label*='发送消息']:not([disabled]), message-content",
    resultContainerSelector: "message-content, .model-response-text, .response-container-content, model-response, .response-paragraph",
    description: "Google Gemini Web Interface (Gemini 1.5 Pro & Flash)"
  },
  {
    id: "deepseek",
    name: "DeepSeek AI",
    enabled: true,
    defaultUrl: "https://chat.deepseek.com",
    urlPattern: "*://chat.deepseek.com/*",
    responseScope: "main, [class*='chat-message-list'], [class*='conversation'], [role='main'], [class*='chat-container'], [class*='chat'], #root",
    newChatSelector: "div[role='button']:has-text('New chat'), div[role='button']:has-text('开启新对话'), a[href='/'], div[class*='new-chat']",
    startChatSelector: "textarea#chat-input, textarea.ds-scroll-area, textarea[placeholder*='DeepSeek'], textarea[placeholder*='Pesan DeepSeek'], textarea[placeholder*='Send DeepSeek'], textarea",
    continueChatSelector: "textarea#chat-input, textarea.ds-scroll-area, textarea[placeholder*='DeepSeek'], textarea[placeholder*='Pesan DeepSeek'], textarea[placeholder*='Send DeepSeek'], textarea",
    streamSelector: "button[aria-label*='Stop'], div[class*='stop'], .ds-icon-button:has(svg rect), [aria-label*='停止生成']",
    doneSelector: "div[role='button'].ds-button--primary:not([aria-disabled='true']), .ds-button--primary:not([aria-disabled='true']), .ds-button--circle:not([aria-disabled='true']), button[aria-label*='Send']:not([disabled]), div[class*='send-button']:not([aria-disabled='true'])",
    resultContainerSelector: ".ds-markdown, .ds-markdown--block, [class*='message-content'], [data-role='assistant'], div.chat-message-bubble",
    description: "DeepSeek Web AI Interface (DeepSeek-V3 & DeepSeek-R1)"
  },
  {
    id: "grok",
    name: "Grok AI (xAI)",
    enabled: true,
    defaultUrl: "https://grok.com",
    urlPattern: "*://grok.com/*",
    responseScope: "main, [role='main'], [class*='chat'], [class*='conversation']",
    newChatSelector: "a[href='/'], button[aria-label*='New chat'], [aria-label*='Start new chat']",
    startChatSelector: "textarea[placeholder*='Ask Grok'], textarea[placeholder*='Ask anything'], textarea, [contenteditable='true'], div[role='textbox']",
    continueChatSelector: "textarea[placeholder*='Ask Grok'], textarea[placeholder*='Ask anything'], textarea, [contenteditable='true'], div[role='textbox']",
    streamSelector: "button[aria-label*='Stop'], button[aria-label*='stop'], [aria-label*='Stop generating']",
    doneSelector: "button[aria-label*='Ask']:not([disabled]), button[type='submit']:not([disabled]), button:has(svg path[d*='M2 12']):not([disabled])",
    resultContainerSelector: "[data-role='assistant'], [class*='assistant'], [class*='response'], article, .prose, [class*='markdown']",
    description: "xAI Grok Web Interface (Grok 2 & Grok 3)"
  },
  {
    id: "perplexity",
    name: "Perplexity AI",
    enabled: true,
    defaultUrl: "https://www.perplexity.ai",
    urlPattern: "*://*.perplexity.ai/*",
    responseScope: "main, [role='main'], [class*='thread'], [class*='conversation']",
    newChatSelector: "button:has-text('New Thread'), button:has-text('新建问题'), a[href='/']",
    startChatSelector: "textarea[placeholder*='Ask'], div[contenteditable='true'], [role='textbox'], textarea",
    continueChatSelector: "textarea[placeholder*='Ask'], div[contenteditable='true'], [role='textbox'], textarea",
    streamSelector: "button[aria-label*='Stop'], button[aria-label*='stop'], [aria-label*='Stop generating']",
    doneSelector: "button[aria-label*='Submit']:not([disabled]), button[aria-label*='Search']:not([disabled]), button:has(svg):not([disabled])",
    resultContainerSelector: "[class*='prose'], [class*='break-words'][class*='font-sans'], [class*='markdown'], [class*='threadContent']",
    description: "Perplexity AI Search & Chat Engine"
  },
  {
    id: "kimi",
    name: "Kimi AI (Moonshot)",
    enabled: true,
    defaultUrl: "https://kimi.moonshot.cn",
    urlPattern: "*://*.moonshot.cn/*",
    responseScope: "main, [role='main'], [class*='chat-session'], [class*='conversation']",
    newChatSelector: "[aria-label*='新对话'], [aria-label*='New chat'], button:has-text('新对话')",
    startChatSelector: "[contenteditable='true'], div.chat-input-editor, textarea[placeholder], textarea",
    continueChatSelector: "[contenteditable='true'], div.chat-input-editor, textarea[placeholder], textarea",
    streamSelector: "button[class*='stop'], [aria-label*='Stop'], [class*='stopGenerating']",
    doneSelector: "button[class*='send']:not([disabled]), button[type='submit']:not([disabled]), div[class*='sendBtn']:not([disabled])",
    resultContainerSelector: ".segment-assistant, .chat-content-item-assistant, [class*='assistantMessage'], [class*='markdownContent'], .markdown",
    description: "Moonshot Kimi AI Web Interface (Kimi K1 / K2)"
  },
  {
    id: "qwen",
    name: "Qwen AI (Tongyi Qianwen)",
    enabled: true,
    defaultUrl: "https://chat.qwen.ai",
    urlPattern: "*://*.qwen.ai/*",
    responseScope: "main, [role='main'], [class*='chat-messages-container'], [class*='chat-messages'], [class*='chat-container'], [class*='conversation'], [class*='message-list']",
    newChatSelector: "[aria-label*='新建对话'], [aria-label*='New chat'], button:has-text('新建对话'), button:has-text('New chat')",
    startChatSelector: "textarea.message-input-textarea, textarea[placeholder*='问问'], textarea[placeholder*='Ask'], textarea, [contenteditable='true']",
    continueChatSelector: "textarea.message-input-textarea, textarea[placeholder*='问问'], textarea[placeholder*='Ask'], textarea, [contenteditable='true']",
    streamSelector: "button[class*='stop'], button:has([class*='stop']), [aria-label*='停止生成'], button[aria-label*='Stop'], button[aria-label*='Berhenti']",
    doneSelector: "button.send-button:not([disabled]), button[class*='send']:not([disabled]), button[type='submit']:not([disabled]), button[aria-label*='Send']:not([disabled])",
    resultContainerSelector: ".qwen-chat-message-assistant .qwen-markdown, .qwen-chat-message-assistant, .qwen-markdown, [class*='qwen-markdown'], div[class*='contentBlock']:not([class*='user']), div[class*='chat-message']:not([class*='user']) .markdown",
    description: "Alibaba Tongyi Qwen AI Web Interface (Qwen 2.5 / Max)"
  },
  {
    id: "doubao",
    name: "Doubao AI (ByteDance)",
    enabled: true,
    defaultUrl: "https://www.doubao.com/chat",
    urlPattern: "*://*.doubao.com/*",
    responseScope: "main, [role='main'], [class*='chat-list'], [class*='conversation']",
    newChatSelector: "[data-testid='new_chat_button'], button:has-text('开启新对话'), a[href='/chat/']",
    startChatSelector: "textarea[placeholder*='问豆包'], textarea[placeholder], textarea, [contenteditable='true']",
    continueChatSelector: "textarea[placeholder*='问豆包'], textarea[placeholder], textarea, [contenteditable='true']",
    streamSelector: "button[class*='stopBtn'], [aria-label*='停止'], button[aria-label*='Stop']",
    doneSelector: "button[id*='flow-end-msg-send']:not([disabled]), button[class*='sendBtn']:not([disabled]), button[type='submit']:not([disabled])",
    resultContainerSelector: "[data-testid='chat_response_content'], [class*='message-container--assistant'], [class*='answer-content'], .markdown",
    description: "ByteDance Doubao AI Web Interface"
  },
  {
    id: "glm",
    name: "GLM / Zhipu AI",
    enabled: true,
    defaultUrl: "https://chatglm.cn",
    urlPattern: "*://chatglm.cn/*",
    responseScope: "main, [role='main'], [class*='chat'], [class*='conversation']",
    newChatSelector: "[aria-label*='新建对话'], [aria-label*='New chat'], button:has-text('新建')",
    startChatSelector: "textarea[placeholder], textarea, [contenteditable='true'], div[role='textbox']",
    continueChatSelector: "textarea[placeholder], textarea, [contenteditable='true'], div[role='textbox']",
    streamSelector: "button[class*='stop'], [class*='stop-btn'], button[aria-label*='Stop']",
    doneSelector: "button[class*='send']:not([disabled]), button[type='submit']:not([disabled]), button:has(svg):not([disabled])",
    resultContainerSelector: ".chat-assistant, [class*='assistant'], .markdown, [class*='answer-text']",
    description: "Zhipu BigModel / GLM-4 Web Interface (chatglm.cn / chat.z.ai)"
  },
  {
    id: "copilot",
    name: "Microsoft Copilot",
    enabled: true,
    defaultUrl: "https://copilot.microsoft.com",
    urlPattern: "*://copilot.microsoft.com/*",
    responseScope: "main, [role='main'], [class*='chat-turn'], [class*='conversation'], cib-chat-turn",
    newChatSelector: "[aria-label*='New topic'], [aria-label*='Percakapan baru'], button[aria-label*='New chat']",
    startChatSelector: "textarea[id='userInput'], textarea[placeholder*='Ask'], textarea, div[contenteditable='true']",
    continueChatSelector: "textarea[id='userInput'], textarea[placeholder*='Ask'], textarea, div[contenteditable='true']",
    streamSelector: "button[aria-label*='Stop responding'], button[aria-label*='Stop'], button[title*='Stop']",
    doneSelector: "button[aria-label*='Submit']:not([disabled]), button[title*='Submit']:not([disabled]), button:has(svg):not([disabled])",
    resultContainerSelector: "cib-message-group[source='bot'], div[class*='response'], .prose, div[data-content='ai-message'], .markdown",
    description: "Microsoft Copilot Web Interface (copilot.microsoft.com)"
  },
  {
    id: "mistral",
    name: "Mistral Le Chat",
    enabled: true,
    defaultUrl: "https://chat.mistral.ai/chat",
    urlPattern: "*://chat.mistral.ai/*",
    responseScope: "main, [role='main'], [class*='chat'], [class*='conversation']",
    newChatSelector: "a[href='/chat'], button[aria-label*='New chat'], [aria-label*='New conversation']",
    startChatSelector: "textarea[placeholder], textarea[aria-label*='Prompt'], textarea, div[contenteditable='true']",
    continueChatSelector: "textarea[placeholder], textarea[aria-label*='Prompt'], textarea, div[contenteditable='true']",
    streamSelector: "button[aria-label*='Stop'], button:has(svg rect), [data-testid='stop-button']",
    doneSelector: "button[type='submit']:not([disabled]), button[aria-label*='Send']:not([disabled]), button:has(svg path):not([disabled])",
    resultContainerSelector: "[data-message-author-role='assistant'], article [class*='prose'], div[class*='prose'], .markdown",
    description: "Mistral AI Le Chat Interface (Mistral Large & Pixtral)"
  },
  {
    id: "poe",
    name: "Poe AI (Quora)",
    enabled: true,
    defaultUrl: "https://poe.com",
    urlPattern: "*://poe.com/*",
    responseScope: "main, [role='main'], [class*='ChatMessages'], [class*='conversation']",
    newChatSelector: "[class*='ChatHeader_clearButton'], [aria-label*='Clear context'], button[aria-label*='New chat']",
    startChatSelector: "textarea[class*='ChatMessageInput'], textarea[placeholder*='Talk'], textarea, [contenteditable='true']",
    continueChatSelector: "textarea[class*='ChatMessageInput'], textarea[placeholder*='Talk'], textarea, [contenteditable='true']",
    streamSelector: "button[class*='ChatMessageStopButton'], button[aria-label*='Stop']",
    doneSelector: "button[class*='ChatMessageSendButton']:not([disabled]), button[type='submit']:not([disabled])",
    resultContainerSelector: "[class*='Message_botMessage'], [class*='Message_messageRow'] [class*='Markdown'], .markdown",
    description: "Quora Poe AI Multi-Bot Interface (poe.com)"
  },
  {
    id: "xiaomimo",
    name: "Xiaomi MiMo Studio",
    enabled: true,
    defaultUrl: "https://aistudio.xiaomimimo.com",
    urlPattern: "*://aistudio.xiaomimimo.com/*",
    responseScope: "main, [role='main'], div[class*='chat'], [class*='message-list'], #app, #root",
    newChatSelector: "button[aria-label*='New conversation'], [aria-label*='新建对话'], button:has-text('新建对话'), button:has-text('New chat')",
    startChatSelector: "textarea[placeholder], textarea, [contenteditable='true']",
    continueChatSelector: "textarea[placeholder], textarea, [contenteditable='true']",
    streamSelector: "button[data-track-id='home_send_btn']:has(svg.size-3), svg.size-3, .animate-pulse, [class*='animate-pulse'], button:has(svg path[d*='M19 2H5a3 3 0 0 0-3 3v14']), svg:has(path[d*='M19 2H5a3 3 0 0 0-3 3v14']), svg path[d*='M19 2H5a3 3 0 0 0-3 3v14'], button[class*='stop'], [aria-label*='Stop'], button[aria-label*='停止'], button[aria-label*='Berhenti']",
    doneSelector: "button:has(svg path[d*='M.244']), button:has(svg path[d*='18.202']), button[class*='send']:not([disabled]), button[type='submit']:not([disabled]), button[aria-label*='Send']:not([disabled])",
    resultContainerSelector: ".markdown-prose, [class*='markdown-prose'], [class*='Markdown_markdown'], div[class*='message-item']:not([class*='user']), div[class*='chat-item']:not([class*='user']), [class*='message-content'], .markdown",
    description: "Xiaomi MiMo AI Studio Web Interface (aistudio.xiaomimimo.com)"
  },
  {
    id: "huggingchat",
    name: "HuggingChat (Hugging Face)",
    enabled: true,
    defaultUrl: "https://huggingface.co/chat",
    urlPattern: "*://huggingface.co/chat*",
    responseScope: "main, [role='main'], [class*='chat-container'], [class*='conversation']",
    newChatSelector: "a[href='/chat/'], button:has-text('New chat')",
    startChatSelector: "textarea[placeholder*='Ask'], textarea[placeholder], textarea, [contenteditable='true']",
    continueChatSelector: "textarea[placeholder*='Ask'], textarea[placeholder], textarea, [contenteditable='true']",
    streamSelector: "button[aria-label*='Stop'], form button:has(svg rect)",
    doneSelector: "button[type='submit']:not([disabled]), button[aria-label*='Submit']:not([disabled])",
    resultContainerSelector: "div[class*='message-assistant'], div.prose, [class*='chatbot-message']",
    description: "Hugging Face HuggingChat Open Source Models (huggingface.co/chat)"
  },
  {
    id: "duckduckgo",
    name: "DuckDuckGo AI Chat",
    enabled: true,
    defaultUrl: "https://duckduckgo.com/chat",
    urlPattern: "*://duckduckgo.com/chat*",
    responseScope: "main, [role='main'], [class*='chat'], [class*='conversation']",
    newChatSelector: "button:has-text('New Chat'), button[aria-label*='New Chat']",
    startChatSelector: "textarea[placeholder*='Ask'], textarea[placeholder], textarea",
    continueChatSelector: "textarea[placeholder*='Ask'], textarea[placeholder], textarea",
    streamSelector: "button[aria-label*='Stop'], button:has(svg rect)",
    doneSelector: "button[type='submit']:not([disabled]), button[aria-label*='Send']:not([disabled])",
    resultContainerSelector: "div[data-role='assistant'], div[class*='chat-message'], .markdown",
    description: "DuckDuckGo Anonymous AI Chat (duckduckgo.com/chat)"
  },
  {
    id: "generic-ai",
    name: "Generic AI Chatbot",
    enabled: true,
    defaultUrl: "https://chat.openai.com",
    urlPattern: "*://*/*",
    responseScope: "main, [role='main'], [class*='chat'], [class*='conversation'], [class*='message-list'], article",
    newChatSelector: "[aria-label*='New chat'], [aria-label*='Obrolan baru'], [aria-label*='New topic'], button:has-text('New chat')",
    startChatSelector: "textarea, input[type='text'], [contenteditable='true'], div[role='textbox']",
    continueChatSelector: "textarea, input[type='text'], [contenteditable='true'], div[role='textbox']",
    streamSelector: "button[aria-label*='Stop'], .streaming, .typing, [data-state='streaming'], button:has(svg rect)",
    doneSelector: "button[type='submit']:not([disabled]), button[aria-label*='Send']:not([disabled]), button[aria-label*='Kirim']:not([disabled]), .message-assistant, .bot-response",
    resultContainerSelector: ".message-assistant, .bot-response, [data-role='assistant'], [data-message-author-role='assistant'], .markdown, article",
    description: "Universal fallback pattern for any web-based AI chatbot"
  }
];
