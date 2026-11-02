import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cliPointer, repository, shouldAdvance, validatePointer } from "./publish-github-update-pointer.mjs";

test("recovery preserves newer updates and rejects ambiguous identities", () => {
  assert.equal(shouldAdvance("1.2.3", null), true);
  assert.equal(shouldAdvance("1.2.3", "v1.2.3"), true);
  assert.equal(shouldAdvance("1.2.3", "v1.2.4"), false);
  assert.equal(shouldAdvance("2.0.0", "desktop-v1.9.9"), true);
  assert.throws(() => shouldAdvance("1.2.3", "npm-v1.2.3"));
  assert.throws(() => shouldAdvance("1.2.3-rc.1", "v1.2.2"));
});

test("update publication rejects upstream assets and mismatched signatures", () => {
  const make = () => ({
    version: "v1.2.3", download_page: `https://github.com/${repository}/releases`,
    platforms: Object.fromEntries(["darwin-arm64", "darwin-amd64", "linux-amd64", "windows-amd64", "windows-arm64"].map(platform => {
      const url = `https://github.com/${repository}/releases/download/desktop-v1.2.3/Deepzora-${platform}.zip`;
      return [platform, { url, sig: `${url}.minisig`, size: 100, sha256: "a".repeat(64) }];
    })),
  });
  validatePointer(make(), "1.2.3");
  const upstream = make();
  upstream.platforms["darwin-arm64"].url = "https://github.com/esengine/DeepSeek-Reasonix/releases/download/desktop-v1.2.3/Reasonix-darwin-arm64.zip";
  assert.throws(() => validatePointer(upstream, "1.2.3"));
  const bad = make();
  bad.platforms["darwin-arm64"].sig += ".evil";
  assert.throws(() => validatePointer(bad, "1.2.3"));
  assert.throws(() => validatePointer(make(), "1.2.4"));
});

test("CLI pointer remains immutable across downloads and later release records", () => {
  const release = { tag_name: "v1.2.3", prerelease: false, assets:
    ["SHA256SUMS", ...["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64", "windows-amd64", "windows-arm64"]
      .map(target => `deepzora-${target}.${target.startsWith("windows") ? "zip" : "tar.gz"}`)]
      .map(name => ({ name, size: 100, download_count: 0,
        browser_download_url: `https://github.com/${repository}/releases/download/v1.2.3/${name}` })) };
  const before = cliPointer(release, "1.2.3");
  release.assets.reverse().forEach(asset => { asset.download_count = 99; });
  release.assets.push({ name: "release-event.json" });
  assert.deepEqual(cliPointer(release, "1.2.3"), before);
  release.assets[0].browser_download_url = "https://github.com/esengine/DeepSeek-Reasonix/releases/download/v1.2.3/SHA256SUMS";
  assert.throws(() => cliPointer(release, "1.2.3"));
});

function publicationFixture(t, latest = "v1.2.3") {
  const root = mkdtempSync(path.join(tmpdir(), "deepzora-latest-contract-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "bin"));
  mkdirSync(path.join(root, "scripts"));
  // Manifest schema validation is covered separately; exercise the real
  // publication code with an isolated GitHub service and no network writes.
  writeFileSync(path.join(root, "scripts/validate-desktop-release-manifest.sh"), "exit 0\n");
  const url = `https://github.com/${repository}/releases/download/desktop-v1.2.3/Deepzora.zip`;
  const manifest = { version: "v1.2.3", download_page: `https://github.com/${repository}/releases`,
    platforms: Object.fromEntries(["darwin-arm64", "darwin-amd64", "linux-amd64", "windows-amd64", "windows-arm64"]
      .map(platform => [platform, { url, sig: `${url}.minisig`, size: 100, sha256: "a".repeat(64) }])) };
  const names = ["SHA256SUMS", ...["darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64", "windows-amd64", "windows-arm64"]
    .map(target => `deepzora-${target}.${target.startsWith("windows") ? "zip" : "tar.gz"}`)];
  const state = { latest, releases: {}, files: {} };
  for (const tag of ["v1.2.3", "desktop-v1.2.3"]) {
    state.files[tag] = tag.startsWith("desktop") ? { "latest.json": JSON.stringify(manifest) }
      : Object.fromEntries(names.map(name => [name, "fixture"]));
    state.releases[tag] = { tag_name: tag, draft: false, prerelease: false,
      name: tag.startsWith("desktop") ? "Deepzora Desktop v1.2.3" : "Deepzora CLI v1.2.3", body: "notes\n" };
  }
  const statePath = path.join(root, "state.json");
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  save();
  writeFileSync(path.join(root, "bin/gh"), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), file = process.env.FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(file + '.calls', JSON.stringify(args) + '\\n');
const value = flag => args[args.indexOf(flag) + 1];
const release = tag => ({ ...state.releases[tag], tag_name: tag,
  assets: Object.entries(state.files[tag] || {}).map(([name, content]) => ({ name, size: Buffer.byteLength(content),
    browser_download_url: 'https://github.com/SivanCola/deepzora/releases/download/' + tag + '/' + name })) });
if (args[0] === 'api') {
  const endpoint = args[1];
  if (endpoint.includes('/git/ref/tags/')) console.log(JSON.stringify({object:{type:'commit',sha:'a'.repeat(40)}}));
  else if (endpoint.endsWith('/releases/latest')) console.log(JSON.stringify(release(state.latest)));
  else if (endpoint.includes('/releases/tags/')) console.log(JSON.stringify(release(endpoint.split('/').at(-1))));
  else process.exit(90);
} else if (args[0] === 'release' && args[1] === 'download') {
  const files = state.files[args[2]];
  const names = args.includes('--pattern') ? [value('--pattern')] : Object.keys(files);
  for (const name of names) {
    if (!(name in files)) process.exit(91);
    const output = args.includes('--output') ? value('--output') : path.join(value('--dir'), name);
    if (fs.existsSync(output)) process.exit(94);
    fs.writeFileSync(output, files[name]);
  }
} else if (args[0] === 'release' && args[1] === 'upload') {
  if (process.env.FAIL_DESKTOP_UPLOAD === 'true' && args[2].startsWith('desktop')) process.exit(92);
  state.files[args[2]][path.basename(args[3])] = fs.readFileSync(args[3], 'utf8');
  fs.writeFileSync(file, JSON.stringify(state));
} else if (args[0] === 'release' && args[1] === 'edit' && args.includes('--latest')) {
  state.latest = args[2];
  fs.writeFileSync(file, JSON.stringify(state));
} else process.exit(93);
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE_STATE: statePath,
    GITHUB_REPOSITORY: repository, RELEASE_VERSION: "1.2.3", RELEASE_EXPECTED_SHA: "a".repeat(40) };
  return { root, state, save, env,
    read: () => JSON.parse(readFileSync(statePath, "utf8")),
    calls: () => readFileSync(`${statePath}.calls`, "utf8"),
    run: extra => spawnSync(process.execPath, [new URL("./publish-github-update-pointer.mjs", import.meta.url).pathname],
      { cwd: root, env: { ...env, ...extra }, encoding: "utf8" }),
  };
}

test("Desktop becomes Latest only after both updater documents are available, including on retry", t => {
  const f = publicationFixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const state = f.read();
    assert.equal(state.latest, "desktop-v1.2.3");
    const desktop = state.files[state.latest], cli = state.files["v1.2.3"];
    assert.equal(desktop["latest.json"], cli["latest.json"]);
    assert.equal(desktop["cli-latest.json"], cli["cli-latest.json"]);
    assert.equal(JSON.parse(desktop["cli-latest.json"]).tag_name, "v1.2.3");
    assert.equal(JSON.parse(desktop["cli-latest.json"]).assets.length, 7);
  }
});

test("incomplete or conflicting CLI metadata cannot move Latest", t => {
  for (const conflict of [false, true]) {
    const f = publicationFixture(t);
    if (conflict) {
      f.state.files["desktop-v1.2.3"]["cli-latest.json"] = "conflict";
      f.save();
    }
    const result = f.run({ FAIL_DESKTOP_UPLOAD: String(!conflict) });
    assert.notEqual(result.status, 0);
    assert.equal(f.read().latest, "v1.2.3");
    assert.doesNotMatch(f.calls(), /"edit"/);
  }
});

test("recovering an older release preserves the newer public entry", t => {
  const f = publicationFixture(t, "desktop-v1.2.4");
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read().latest, "desktop-v1.2.4");
  assert.doesNotMatch(f.calls(), /"edit"/);
});

test("Desktop package recovery accepts promotion metadata while rejecting unexpected artifacts", t => {
  const f = publicationFixture(t);
  const candidate = path.join(f.root, "candidate");
  mkdirSync(candidate);
  writeFileSync(path.join(candidate, "Deepzora.zip"), "package");
  const notes = path.join(f.root, "notes.md");
  writeFileSync(notes, "notes\n");
  f.state.files["desktop-v1.2.3"] = { "Deepzora.zip": "package", "cli-latest.json": "pointer" };
  f.save();
  const run = () => spawnSync("bash", [new URL("./publish-desktop-github-release.sh", import.meta.url).pathname,
    "desktop-v1.2.3", "v1.2.3", "false", notes, candidate], { env: f.env, encoding: "utf8" });
  const recovered = run();
  assert.equal(recovered.status, 0, recovered.stderr);
  f.state.files["desktop-v1.2.3"]["unexpected.zip"] = "unknown";
  f.save();
  const rejected = run();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unexpected asset: unexpected.zip/);
});
