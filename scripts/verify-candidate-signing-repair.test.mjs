import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintFiles, outsidePromotePreflight, outsideSigningContract } from "./verify-candidate-signing-repair.mjs";

const original = `jobs:\n  resolve:\n    runs-on: ubuntu-latest\n  signing-contract:\n    steps:\n      - run: original gate\n  build:\n    runs-on: macos-latest\n  publish:\n    runs-on: ubuntu-latest\n`;

test("a control repair may change the signing gate but not build or publication", () => {
  const repaired = original.replace("original gate", "verified candidate gate");
  assert.equal(outsideSigningContract(original), outsideSigningContract(repaired));
  assert.notEqual(outsideSigningContract(original), outsideSigningContract(repaired.replace("macos-latest", "windows-latest")));
  assert.throws(() => outsideSigningContract("jobs:\n  signing-contract:\n"), /boundaries/);
});

test("a control repair may change promotion preflight but not approval or publication", () => {
  const promote = `jobs:\n  preflight:\n    steps:\n      - run: original check\n  authorize:\n    environment: release\n  cli:\n    runs-on: ubuntu-latest\n`;
  const repaired = promote.replace("original check", "repaired check");
  assert.equal(outsidePromotePreflight(promote), outsidePromotePreflight(repaired));
  assert.notEqual(outsidePromotePreflight(promote), outsidePromotePreflight(repaired.replace("environment: release", "environment: open")));
  assert.notEqual(outsidePromotePreflight(promote), outsidePromotePreflight(repaired.replace("runs-on: ubuntu-latest", "runs-on: self-hosted")));
  assert.throws(() => outsidePromotePreflight("jobs:\n  preflight:\n"), /boundaries/);
});

test("the fingerprint file list must include the Desktop workflow", () => {
  assert.deepEqual(fingerprintFiles("fingerprint_files:\n  - .github/workflows/release-desktop.yml\n  - scripts/sign-certum.ps1\n"),
    [".github/workflows/release-desktop.yml", "scripts/sign-certum.ps1"]);
  assert.throws(() => fingerprintFiles("fingerprint_files:\n  - scripts/sign-certum.ps1\n"), /absent/);
});
