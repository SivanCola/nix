import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { desktopAssets, desktopName } from "./desktop-downloads.mjs";
import { buildMirrorPlan, checkExistingObject, indexShouldAdvance, stableVersion } from "./release-r2-mirror.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const repo = "https://github.com/SivanCola/deepzora/releases/download/";
function fixture() {
  const version = "0.0.2", tag = `desktop-v${version}`;
  const payloads = {};
  const desktop = { tag_name: tag, draft: false, prerelease: false, assets: [] };
  const cli = { tag_name: `v${version}`, draft: false, prerelease: false, assets: [] };
  const manifest = { version: `v${version}`, artifact_naming: "versioned-v1", platforms: {}, native_packages: {}, downloads: {} };
  function asset(release, name, content) {
    payloads[`${release.tag_name}/${name}`] = content;
    const item = { name, size: Buffer.byteLength(content), digest: `sha256:${hash(content)}`, browser_download_url: `${repo}${release.tag_name}/${name}` };
    release.assets.push(item);
    return item;
  }
  for (const spec of desktopAssets) {
    const name = desktopName(version, spec), content = `signed installer bytes: ${name}`;
    const item = asset(desktop, name, content);
    asset(desktop, `${name}.minisig`, `signature: ${name}`);
    const value = { url: item.browser_download_url, sig: `${item.browser_download_url}.minisig`, size: item.size, sha256: hash(content) };
    manifest.downloads[name] = value;
    if (spec.channel) manifest[spec.channel][spec.platform] = value;
  }
  asset(desktop, "latest.json", JSON.stringify(manifest));
  const cliNames = ["darwin-amd64.tar.gz", "darwin-arm64.tar.gz", "linux-amd64.tar.gz", "linux-arm64.tar.gz", "windows-amd64.zip", "windows-arm64.zip"].map(name => `deepzora-${name}`);
  const checksums = cliNames.map(name => { const content = `cli bytes: ${name}`; asset(cli, name, content); return `${hash(content)}  ${name}\n`; }).join("");
  asset(cli, "SHA256SUMS", checksums);
  return { version, desktop, cli, manifest, checksums, payloads };
}

test("only complete public stable releases with matching official URLs and checksums can be mirrored", () => {
  const f = fixture();
  const plan = buildMirrorPlan(f.version, f.desktop, f.cli, f.manifest, f.checksums);
  assert.equal(plan.files.length, desktopAssets.length * 2 + 8);
  assert.match(plan.files[0].key, /^desktop\/desktop-v0\.0\.2\//);
  assert.ok(plan.files.every(file => file.url.startsWith("https://downloads.deepzora.app/")));
  for (const mutate of [
    value => { value.desktop.draft = true; },
    value => { value.cli.prerelease = true; },
    value => { value.desktop.assets.pop(); },
    value => { value.desktop.assets[0].digest = ""; },
    value => { value.desktop.assets[0].browser_download_url = "https://example.com/evil"; },
    value => { value.desktop.assets.push(value.desktop.assets[0]); },
    value => { value.desktop.assets[0].name = "../outside"; },
    value => { value.manifest.version = "v0.0.3"; },
    value => { value.manifest.downloads[value.desktop.assets[0].name].sha256 = "a".repeat(64); },
    value => { value.checksums = value.checksums.replace(/^[a-f0-9]{64}/, "a".repeat(64)); },
  ]) {
    const copy = structuredClone(f); mutate(copy);
    assert.throws(() => buildMirrorPlan(copy.version, copy.desktop, copy.cli, copy.manifest, copy.checksums));
  }
  for (const bad of [undefined, "0.0.2-rc.1", "../../bad", "01.0.0"]) assert.throws(() => stableVersion(bad));
});

test("immutable conflicts fail and an older recovery cannot roll back the download index", () => {
  const file = { key: "desktop/test", size: 10, sha256: "a".repeat(64) };
  checkExistingObject({ ContentLength: 10, Metadata: { sha256: file.sha256 } }, file);
  assert.throws(() => checkExistingObject({ ContentLength: 9, Metadata: { sha256: file.sha256 } }, file), /will not overwrite/);
  assert.throws(() => checkExistingObject({ ContentLength: 10, Metadata: {} }, file), /will not overwrite/);
  assert.equal(indexShouldAdvance("0.0.10", "0.0.2"), false);
  assert.equal(indexShouldAdvance("0.0.2", "0.0.10"), true);
  assert.equal(indexShouldAdvance("0.0.2", "0.0.2"), true);
});

test("automation mirrors only after public postflight, with no signing or GitHub publication credentials", () => {
  const promote = readFileSync(new URL("../.github/workflows/release-promote.yml", import.meta.url), "utf8");
  const mirror = readFileSync(new URL("../.github/workflows/release-mirror.yml", import.meta.url), "utf8");
  const job = promote.split("\n  mirror:\n")[1].split("\n  metrics:")[0];
  assert.match(job, /needs: \[preflight, postflight\]/);
  assert.match(job, /uses: \.\/\.github\/workflows\/release-mirror.yml/);
  assert.doesNotMatch(job, /secrets: inherit/);
  assert.match(mirror, /github.ref == 'refs\/heads\/main' && github.ref_protected/);
  assert.match(mirror, /contents: read/);
  assert.doesNotMatch(mirror, /contents: write|pull_request|RELEASE_TAG_TOKEN|MINISIGN_PRIVATE_KEY|HOMEBREW_TAP_TOKEN/);
  assert.match(mirror, /node scripts\/release-r2-mirror.mjs "\$RELEASE_VERSION"/);
});

// External-process fixtures exercise the real entry point, filesystem hashes,
// conditional S3 writes and public readback, without uploading test packages.
const fakeClient = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const f = JSON.parse(fs.readFileSync(process.env.MIRROR_FIXTURE));
const args = process.argv.slice(2), tool = path.basename(process.argv[1]);
const stateFile = process.env.MIRROR_STATE;
const readState = () => JSON.parse(fs.readFileSync(stateFile));
const option = name => args[args.indexOf(name) + 1];
function fail(message) { console.error(message); process.exit(1); }
if (tool === 'gh') {
  const route = args.at(-1);
  if (route.includes('/git/ref/')) console.log(JSON.stringify({object:{type:'commit',sha:'a'.repeat(40)}}));
  else console.log(JSON.stringify(route.endsWith('/desktop-v0.0.2') ? f.desktop : f.cli));
} else if (tool === 'curl') {
  const url = new URL(args.at(-1));
  let content;
  if (url.hostname === 'github.com') content = f.payloads[url.pathname.split('/releases/download/')[1]];
  else content = readState().objects[url.pathname.slice(1)]?.body;
  if (content == null) fail('curl: missing fixture');
  if (process.env.MIRROR_CORRUPT === 'source' && url.hostname === 'github.com' && url.pathname.endsWith('.dmg')) content += 'bad';
  if (process.env.MIRROR_CORRUPT === 'public' && url.hostname !== 'github.com') content += 'bad';
  fs.writeFileSync(option('--output'), content);
} else if (tool === 'aws') {
  for (;;) {
    try { fs.mkdirSync(stateFile + '.lock'); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5); }
  }
  process.on('exit', () => fs.rmdirSync(stateFile + '.lock'));
  const state = readState(), key = option('--key'), existing = state.objects[key];
  if (args.includes('head-object')) {
    if (!existing) fail('An error occurred (404) when calling HeadObject');
    console.log(JSON.stringify({ContentLength:Buffer.byteLength(existing.body),Metadata:existing.metadata,ETag:existing.etag}));
  } else {
    if (args.includes('--if-none-match') && existing) fail('An error occurred (PreconditionFailed)');
    if (args.includes('--if-match') && option('--if-match') !== existing?.etag) fail('An error occurred (PreconditionFailed)');
    const metadata = Object.fromEntries(option('--metadata').split(',').map(value => value.split('=')));
    state.objects[key] = {body:fs.readFileSync(option('--body'),'utf8'),metadata,etag:'"' + metadata.sha256 + '"'};
    state.writes.push(key);
    fs.writeFileSync(stateFile + '.next',JSON.stringify(state));
    fs.renameSync(stateFile + '.next',stateFile);
    console.log('{}');
  }
}
`;

test("sync verifies every object, retries without immutable overwrites, and preserves a newer index", () => {
  const work = mkdtempSync(path.join(tmpdir(), "deepzora-r2-test-"));
  try {
    const bin = path.join(work, "bin"); mkdirSync(bin);
    for (const name of ["aws", "gh", "curl"]) { const file = path.join(bin, name); writeFileSync(file, fakeClient); chmodSync(file, 0o755); }
    const f = fixture(); writeFileSync(path.join(work, "fixture.json"), JSON.stringify(f));
    const stateFile = path.join(work, "state.json");
    const reset = () => writeFileSync(stateFile, JSON.stringify({ objects: {}, writes: [] })); reset();
    const run = (extra = {}) => spawnSync(process.execPath, ["scripts/release-r2-mirror.mjs", f.version], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_ACTIONS: "false", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", R2_ACCOUNT_ID: "a".repeat(32), R2_BUCKET: "deepzora-releases", R2_PUBLIC_BASE: "https://downloads.deepzora.app", R2_MIRROR_WORKDIR: path.join(work, "downloads"), MIRROR_FIXTURE: path.join(work, "fixture.json"), MIRROR_STATE: stateFile, ...extra },
    });
    let result = run(); assert.equal(result.status, 0, result.stderr);
    let state = JSON.parse(readFileSync(stateFile));
    const count = desktopAssets.length * 2 + 8 + 3;
    assert.equal(Object.keys(state.objects).length, count + 1);
    assert.match(state.objects["index.html"].body, /Deepzora 0.0.2/);
    result = run(); assert.equal(result.status, 0, result.stderr);
    state = JSON.parse(readFileSync(stateFile));
    assert.equal(state.writes.length, count + 2, "only the mutable index is written again");
    state.objects["index.html"].metadata.version = "0.0.10";
    writeFileSync(stateFile, JSON.stringify(state));
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Preserved newer/);
    assert.equal(JSON.parse(readFileSync(stateFile)).objects["index.html"].metadata.version, "0.0.10");
    const firstKey = `desktop/desktop-v${f.version}/${desktopName(f.version, desktopAssets[0])}`;
    state.objects[firstKey].metadata.sha256 = "f".repeat(64);
    writeFileSync(stateFile, JSON.stringify(state));
    result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /will not overwrite/);
    reset();
    result = run({ MIRROR_CORRUPT: "public" }); assert.notEqual(result.status, 0); assert.match(result.stderr, /Public mirror integrity mismatch/);
    assert.equal(JSON.parse(readFileSync(stateFile)).objects["index.html"], undefined);
    reset(); rmSync(path.join(work, "downloads"), { recursive: true });
    result = run({ MIRROR_CORRUPT: "source" }); assert.notEqual(result.status, 0); assert.match(result.stderr, /GitHub artifact integrity mismatch/);
    assert.deepEqual(JSON.parse(readFileSync(stateFile)).writes, [], "invalid sources cause no R2 writes");
  } finally { rmSync(work, { recursive: true, force: true }); }
});
