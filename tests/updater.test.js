import test from "node:test";
import assert from "node:assert";
import { compareVersions } from "../src/modules/updater.js";

test("compareVersions accurately compares semver strings", () => {
  assert.strictEqual(compareVersions("1.40.2", "1.40.1"), 1);
  assert.strictEqual(compareVersions("v1.40.2", "1.40.1"), 1);
  assert.strictEqual(compareVersions("1.41.0", "1.40.9"), 1);
  assert.strictEqual(compareVersions("2.0.0", "1.99.99"), 1);
  assert.strictEqual(compareVersions("1.40.1", "1.40.1"), 0);
  assert.strictEqual(compareVersions("v1.40.1", "v1.40.1"), 0);
  assert.strictEqual(compareVersions("1.40.0", "1.40.1"), -1);
  assert.strictEqual(compareVersions("1.39.9", "1.40.0"), -1);
  assert.strictEqual(compareVersions("", "1.0.0"), -1);
  assert.strictEqual(compareVersions("1.0.0", ""), 1);
});
