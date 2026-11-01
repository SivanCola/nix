import assert from "node:assert/strict";
import test from "node:test";
import { fingerprintFiles, outsideSigningContract, withTrustedRootRepair } from "./verify-candidate-signing-repair.mjs";

const original = `jobs:\n  resolve:\n    runs-on: ubuntu-latest\n  signing-contract:\n    steps:\n      - run: original gate\n  build:\n    runs-on: macos-latest\n  publish:\n    runs-on: ubuntu-latest\n`;

test("a control repair may change the signing gate but not build or publication", () => {
  const repaired = original.replace("original gate", "verified candidate gate");
  assert.equal(outsideSigningContract(original), outsideSigningContract(repaired));
  assert.notEqual(outsideSigningContract(original), outsideSigningContract(repaired.replace("macos-latest", "windows-latest")));
  assert.throws(() => outsideSigningContract("jobs:\n  signing-contract:\n"), /boundaries/);
});

test("the promotion repair is exactly the shared trusted root", () => {
  const sealed = [
    "      - run: |",
    "          # so they run eight at a time and any single failure fails the step.",
    "          find payload -type f -print0 | xargs -0 -P 8 -I{} \\",
    "            --deny-self-hosted-runners >/dev/null",
    "          retention-days: 1",
    "",
  ].join("\n");
  const repaired = [
    "      - run: |",
    "          # so they run eight at a time and any single failure fails the step.",
    "          # Concurrent verifiers race on Sigstore's TUF initialization on hosted",
    "          # runners, so the trusted root is fetched once and each worker reads it.",
    '          gh attestation trusted-root > "$RUNNER_TEMP/trusted_root.jsonl"',
    "          find payload -type f -print0 | xargs -0 -P 8 -I{} \\",
    '            --deny-self-hosted-runners --custom-trusted-root "$RUNNER_TEMP/trusted_root.jsonl" >/dev/null',
    "          retention-days: 1",
    "",
  ].join("\n");
  assert.equal(withTrustedRootRepair(sealed), repaired);
  assert.notEqual(withTrustedRootRepair(sealed), repaired.replace("retention-days: 1", "retention-days: 30"));
  assert.notEqual(withTrustedRootRepair(sealed), repaired.replace("--custom-trusted-root", "--no-verify --custom-trusted-root"));
  assert.throws(() => withTrustedRootRepair(sealed.replace("--deny-self-hosted-runners >/dev/null\n", "")), /anchors/);
  assert.throws(() => withTrustedRootRepair(sealed + sealed), /anchors/);
});

test("the fingerprint file list must include the Desktop workflow", () => {
  assert.deepEqual(fingerprintFiles("fingerprint_files:\n  - .github/workflows/release-desktop.yml\n  - scripts/sign-certum.ps1\n"),
    [".github/workflows/release-desktop.yml", "scripts/sign-certum.ps1"]);
  assert.throws(() => fingerprintFiles("fingerprint_files:\n  - scripts/sign-certum.ps1\n"), /absent/);
});
