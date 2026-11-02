#!/usr/bin/env node
// Copy verified, already-public release bytes. Never rewrite updater URLs or
// overwrite immutable objects, including when two recovery runs overlap.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { desktopAssets, desktopName, verifyNamedDownloads } from "./desktop-downloads.mjs";

const repository = "SivanCola/deepzora";
const publicBase = "https://downloads.deepzora.app";
const immutableCache = "public, max-age=31536000, immutable";
const cliNames = ["darwin-amd64.tar.gz", "darwin-arm64.tar.gz", "linux-amd64.tar.gz", "linux-arm64.tar.gz", "windows-amd64.zip", "windows-arm64.zip"].map(name => `deepzora-${name}`);

export function stableVersion(value) {
  if (typeof value !== "string" || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error("A stable release version is required");
  return value.replace(/^v/, "");
}

function releaseAssets(release, tag) {
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) throw new Error(`Not a public stable release: ${tag}`);
  const assets = new Map();
  for (const asset of release.assets) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name) || assets.has(asset.name)) throw new Error(`Unsafe or duplicate asset in ${tag}`);
    assets.set(asset.name, asset);
  }
  return assets;
}

export function buildMirrorPlan(value, desktopRelease, cliRelease, manifest, checksums) {
  const version = stableVersion(value);
  const desktopTag = `desktop-v${version}`;
  const cliTag = `v${version}`;
  const desktop = releaseAssets(desktopRelease, desktopTag);
  const cli = releaseAssets(cliRelease, cliTag);
  if (manifest.version !== cliTag) throw new Error("Desktop manifest version mismatch");
  verifyNamedDownloads(manifest);
  const result = [];
  function add(assets, tag, name, expected) {
    const asset = assets.get(name);
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 5 * 1024 ** 3) throw new Error(`Missing asset, digest, or supported size: ${name}`);
    const sha256 = asset.digest.slice(7);
    const source = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    if (asset.browser_download_url !== source) throw new Error(`Unexpected source URL: ${name}`);
    if (expected && (expected.sha256 !== sha256 || expected.size !== asset.size || expected.url !== source || expected.sig !== `${source}.minisig`)) throw new Error(`Manifest integrity mismatch: ${name}`);
    const key = `${tag.startsWith("desktop-") ? "desktop" : "cli"}/${tag}/${name}`;
    result.push({ name, tag, key, source, url: `${publicBase}/${key}`, size: asset.size, sha256 });
  }
  for (const spec of desktopAssets) {
    const name = desktopName(version, spec);
    add(desktop, desktopTag, name, manifest.downloads[name]);
    add(desktop, desktopTag, `${name}.minisig`);
  }
  add(desktop, desktopTag, "latest.json");
  const sums = new Map();
  for (const line of checksums.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}(deepzora-[A-Za-z0-9.-]+)$/.exec(line);
    if (!match || sums.has(match[2])) throw new Error("Invalid or duplicate CLI checksum");
    sums.set(match[2], match[1]);
  }
  if (sums.size !== cliNames.length) throw new Error("Unexpected CLI checksum matrix");
  for (const name of cliNames) {
    add(cli, cliTag, name);
    if (sums.get(name) !== result.at(-1).sha256) throw new Error(`CLI checksum mismatch: ${name}`);
  }
  add(cli, cliTag, "SHA256SUMS");
  return { schema: 1, version, repository, publicBase, files: result };
}

export function indexShouldAdvance(current, requested) {
  if (current == null) return true;
  const a = stableVersion(current).split(".").map(BigInt);
  const b = stableVersion(requested).split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return true;
}

export function checkExistingObject(head, file) {
  if (head.ContentLength !== file.size || head.Metadata?.sha256 !== file.sha256) throw new Error(`R2 object conflicts with official release (will not overwrite): ${file.key}`);
}

export function renderIndex(plan) {
  const rows = desktopAssets.filter(spec => !spec.updaterOnly).map(spec => {
    const name = desktopName(plan.version, spec);
    const file = plan.files.find(item => item.name === name);
    return `<tr><td>${spec.labelZh}<br><small>${spec.labelEn}</small></td><td>${spec.purposeZh}</td><td><a href="${file.url}">加速下载 / Download</a> · <a href="${file.source}">GitHub</a><br><small>${(file.size / 1024 ** 2).toFixed(1)} MiB</small></td></tr>`;
  }).join("\n");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deepzora ${plan.version} Downloads</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:1040px;margin:48px auto;padding:0 24px;color:#242424;background:#faf9f6}h1{line-height:1.2}a{color:#a44612}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:16px 12px;border-bottom:1px solid #ddd}small{color:#666}footer{margin-top:32px}@media(max-width:600px){body{margin:24px auto;padding:0 12px}td,th{padding:12px 6px;font-size:14px}}</style>
<h1>Deepzora ${plan.version}</h1><p>桌面版下载 · Desktop downloads</p><p>Mac M 系列选择 Apple Silicon；常见 Intel / AMD Windows 电脑选择 x64。<br>Choose Apple Silicon for M-series Macs; x64 for most Intel / AMD Windows PCs.</p>
<table><thead><tr><th>系统 / System</th><th>用途 / Package</th><th>下载 / Download</th></tr></thead><tbody>${rows}</tbody></table>
<footer><a href="${publicBase}/desktop/desktop-v${plan.version}/SHA256SUMS">SHA-256 checksums</a> · <a href="https://github.com/${repository}/releases/tag/desktop-v${plan.version}">发布说明 / Release notes</a><p>Mac 常规安装请选择 DMG。签名状态和安装说明以正式发布说明为准。</p><p>CLI: ${cliNames.map(name => `<a href="${publicBase}/cli/v${plan.version}/${name}">${name}</a>`).join(" · ")}</p></footer></html>\n`;
}

async function command(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-8192); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout) : reject(Object.assign(new Error(`${program} failed (${code}): ${stderr}`), { code, stderr })));
  });
}

async function hashes(file) {
  const sha = createHash("sha256"), md5 = createHash("md5");
  for await (const chunk of createReadStream(file)) { sha.update(chunk); md5.update(chunk); }
  return { sha256: sha.digest("hex"), md5: md5.digest("base64"), size: (await stat(file)).size };
}

async function mapLimit(items, action, limit = 3) {
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await action(items[next++]);
  }));
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
}

export async function mirrorRelease(value, env = process.env) {
  const version = stableVersion(value);
  if (env.R2_PUBLIC_BASE !== publicBase || !/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID || "") || env.R2_BUCKET !== "deepzora-releases") throw new Error("Configure the official R2_PUBLIC_BASE, R2_ACCOUNT_ID, and R2_BUCKET");
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error("R2 S3 credentials are required");
  if (env.GITHUB_ACTIONS === "true" && (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_REF_PROTECTED !== "true")) throw new Error("R2 publication requires protected main");
  const directory = env.R2_MIRROR_WORKDIR ? path.resolve(env.R2_MIRROR_WORKDIR) : await mkdtemp(path.join(tmpdir(), "deepzora-r2-mirror-"));
  await mkdir(directory, { recursive: true });
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const aws = (...args) => command("aws", ["--endpoint-url", endpoint, "--region", "auto", "--cli-connect-timeout", "30", "--cli-read-timeout", "900", "s3api", ...args]);
  const github = async tag => JSON.parse(await command("gh", ["api", `repos/${repository}/releases/tags/${tag}`]));
  async function download(url, destination) {
    await command("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--retry", "3", "--retry-all-errors", "--connect-timeout", "30", "--max-time", "900", "--output", destination, url]);
  }
  async function head(key) {
    try { return JSON.parse(await aws("head-object", "--bucket", env.R2_BUCKET, "--key", key)); }
    catch (error) { if (/\(404\)|\(NoSuchKey\)|\(NotFound\)/.test(error.stderr || "")) return null; throw error; }
  }
  async function put(file, local, condition, cache) {
    const digest = await hashes(local);
    await aws("put-object", "--bucket", env.R2_BUCKET, "--key", file.key, "--body", local,
      "--content-type", file.name.endsWith(".html") ? "text/html; charset=utf-8" : file.name.endsWith(".json") ? "application/json" : "application/octet-stream",
      "--cache-control", cache, "--content-md5", digest.md5,
      "--metadata", `sha256=${digest.sha256},version=${version}`, ...condition);
  }
  async function verifyPublic(file) {
    const downloaded = path.join(directory, `${file.tag}-${file.name}.readback`);
    await download(file.url, downloaded);
    const observed = await hashes(downloaded);
    await rm(downloaded);
    if (observed.sha256 !== file.sha256 || observed.size !== file.size) throw new Error(`Public mirror integrity mismatch: ${file.key}`);
  }
  try {
    const [desktop, cli] = await Promise.all([github(`desktop-v${version}`), github(`v${version}`)]);
    // Require the immutable CLI and Desktop tags to name the same source commit.
    const refs = await Promise.all([`desktop-v${version}`, `v${version}`].map(async tag => JSON.parse(await command("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`])).object));
    if (refs.some(ref => ref.type !== "commit" || !/^[a-f0-9]{40}$/.test(ref.sha)) || refs[0].sha !== refs[1].sha) throw new Error("CLI and Desktop release tags do not identify one immutable source commit");
    for (const [release, tag, name] of [[desktop, `desktop-v${version}`, "latest.json"], [cli, `v${version}`, "SHA256SUMS"]]) {
      const asset = releaseAssets(release, tag).get(name);
      if (!asset || asset.size > 1024 * 1024) throw new Error(`Missing or oversized ${name}`);
      const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
      if (asset.browser_download_url !== url) throw new Error(`Unexpected metadata source: ${name}`);
      const local = path.join(directory, name);
      await download(url, local);
      const digest = await hashes(local);
      if (asset.digest !== `sha256:${digest.sha256}` || asset.size !== digest.size) throw new Error(`Release metadata digest mismatch: ${name}`);
    }
    const plan = buildMirrorPlan(version, desktop, cli, JSON.parse(await readFile(path.join(directory, "latest.json"), "utf8")), await readFile(path.join(directory, "SHA256SUMS"), "utf8"));
    plan.sourceSHA = refs[0].sha;
    console.log(`Verified release ${version}: ${plan.files.length} files, source ${plan.sourceSHA}`);
    // Verify all source files before making any R2 writes. Valid cached local
    // files allow interrupted backfills to resume without another GitHub fetch.
    await mapLimit(plan.files, async file => {
      const local = path.join(directory, `${file.tag}-${file.name}`);
      let observed;
      try { observed = await hashes(local); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (observed?.sha256 !== file.sha256 || observed?.size !== file.size) { await download(file.source, local); observed = await hashes(local); }
      if (observed.sha256 !== file.sha256 || observed.size !== file.size) throw new Error(`GitHub artifact integrity mismatch: ${file.name}`);
      console.log(`Source verified: ${file.name}`);
    });
    // Publish deterministic checksums and a versioned landing page only after
    // the complete official matrix has been verified.
    const extra = [
      ["SHA256SUMS", plan.files.filter(file => file.tag === `desktop-v${version}`).map(file => `${file.sha256}  ${file.name}\n`).join("")],
      ["mirror.json", `${JSON.stringify(plan, null, 2)}\n`],
      ["index.html", renderIndex(plan)],
    ];
    const files = [...plan.files];
    for (const [name, content] of extra) {
      const tag = `desktop-v${version}`, key = `desktop/${tag}/${name}`;
      const local = path.join(directory, `${tag}-${name}`);
      await writeFile(local, content);
      files.push({ name, tag, key, url: `${publicBase}/${key}`, ...(await hashes(local)) });
    }
    await mapLimit(files, async file => {
      const existing = await head(file.key);
      if (existing) checkExistingObject(existing, file);
      else {
        try { await put(file, path.join(directory, `${file.tag}-${file.name}`), ["--if-none-match", "*"], file.name === "latest.json" ? "no-cache" : immutableCache); }
        catch (error) {
          if (!/\(PreconditionFailed\)|\(412\)/.test(error.stderr || "")) throw error;
          checkExistingObject(await head(file.key), file);
        }
      }
      await verifyPublic(file);
      console.log(`Mirror verified: ${file.key}`);
    });
    const indexFile = files.find(file => file.name === "index.html");
    const current = await head("index.html");
    if (current && (!current.Metadata?.version || !current.ETag)) throw new Error("Cannot identify current download index; refusing to overwrite");
    if (indexShouldAdvance(current?.Metadata.version, version)) {
      const root = { ...indexFile, key: "index.html", url: `${publicBase}/index.html` };
      const local = path.join(directory, `${root.tag}-${root.name}`);
      // Conditional writes also protect the mutable index from concurrent
      // recovery of older releases. Conflicts fail and can be safely retried.
      await put(root, local, current ? ["--if-match", current.ETag] : ["--if-none-match", "*"], "public, max-age=60, must-revalidate");
      // Browser caches may retain the prior index for 60 seconds. This unique
      // verification query checks the newly committed bytes immediately.
      await verifyPublic({ ...root, url: `${root.url}?verify=${indexFile.sha256}` });
    } else console.log(`Preserved newer download index ${current.Metadata.version}`);
    const report = { schema: 1, version, sourceSHA: plan.sourceSHA, publicBase, verifiedAt: new Date().toISOString(), files: files.map(({ key, size, sha256, url }) => ({ key, size, sha256, url })) };
    if (env.R2_MIRROR_REPORT) await writeFile(env.R2_MIRROR_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    if (env.GITHUB_STEP_SUMMARY) await writeFile(env.GITHUB_STEP_SUMMARY, `\n### R2 download mirror\n\n- Version: ${version}\n- Verified objects: ${files.length}\n- Downloads: ${publicBase}/\n- Immutable version: ${publicBase}/desktop/desktop-v${version}/index.html\n`, { flag: "a" });
    console.log(`R2 mirror complete: version=${version} objects=${files.length} downloads=${publicBase}/`);
    return report;
  } finally {
    if (!env.R2_MIRROR_WORKDIR) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  mirrorRelease(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
