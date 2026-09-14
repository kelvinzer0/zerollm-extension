import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("manifest.json is valid Manifest V3 and referenced files exist", () => {
  const content = fs.readFileSync("manifest.json", "utf8");
  const manifest = JSON.parse(content);

  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.name);
  assert.ok(manifest.version);
  assert.equal(manifest.background.service_worker, "src/background.js");
  assert.equal(manifest.background.type, "module");

  // Verify referenced background worker exists
  assert.ok(fs.existsSync(manifest.background.service_worker));

  // Verify content scripts exist
  for (const cs of manifest.content_scripts) {
    for (const jsFile of cs.js) {
      assert.ok(fs.existsSync(jsFile), `Missing content script: ${jsFile}`);
    }
  }

  // Verify popup exists
  assert.ok(fs.existsSync(manifest.action.default_popup));

  // Verify icons exist
  for (const iconPath of Object.values(manifest.icons)) {
    assert.ok(fs.existsSync(iconPath), `Missing icon: ${iconPath}`);
  }
});
