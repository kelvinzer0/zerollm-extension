import test from "node:test";
import assert from "node:assert/strict";
import { extractDomainFromPattern } from "../src/modules/media-blocker.js";

test("extractDomainFromPattern correctly extracts domain from wildcards", () => {
  assert.equal(extractDomainFromPattern("*://chatgpt.com/*"), "chatgpt.com");
  assert.equal(extractDomainFromPattern("*://*.qwen.ai/*"), "qwen.ai");
  assert.equal(extractDomainFromPattern("https://claude.ai/chat"), "claude.ai");
  assert.equal(extractDomainFromPattern("*://*.deepseek.com/*"), "deepseek.com");
  assert.equal(extractDomainFromPattern(""), null);
});
