import test from "node:test";
import assert from "node:assert/strict";
import { wildcardToRegExp } from "../src/modules/tab-manager.js";

test("wildcardToRegExp matches URLs correctly", () => {
  const chatgptRegex = wildcardToRegExp("*://chatgpt.com/*");
  assert.ok(chatgptRegex.test("https://chatgpt.com/"));
  assert.ok(chatgptRegex.test("https://chatgpt.com"));
  assert.ok(chatgptRegex.test("https://chatgpt.com/c/123-abc"));
  assert.ok(!chatgptRegex.test("https://fakechatgpt.com/"));

  const perplexityRegex = wildcardToRegExp("*://*.perplexity.ai/*");
  assert.ok(perplexityRegex.test("https://www.perplexity.ai/"));
  assert.ok(perplexityRegex.test("https://perplexity.ai/search/123"));

  const chatsmithRegex = wildcardToRegExp("*://chatsmith.io/*");
  assert.ok(chatsmithRegex.test("https://chatsmith.io/"));
  assert.ok(chatsmithRegex.test("http://chatsmith.io/conversation"));
});
