import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupStaging, detachImage, processExecutable } from "./desktop-dmg-lifecycle.mjs";

const mount = "/Volumes/dmg.test with spaces";
const bundle = `${mount}/Deepzora.app`;
const shell = `${bundle}/Contents/MacOS/Deepzora`;
const service = `${bundle}/Contents/Resources/service/deepzora-desktop`;
const copy = "/tmp/copied app/Deepzora.app";

function fixture({ processes = [], ignoresTerm = [], survivesKill = [], busy = false, stillMounted = false } = {}) {
  const events = [];
  let time = 0;
  let mounted = true;
  let live = processes;
  const image = { "image-path": "/build/staging/rw.candidate.dmg", "system-entities": [
    { "dev-entry": "/dev/disk99" }, { "dev-entry": "/dev/disk99s1", "mount-point": mount },
  ] };
  const driver = {
    images: () => mounted ? [image] : [],
    processes: () => live,
    canonical: path => path,
    now: () => time,
    sleep: async ms => { time += ms; },
    log: () => {},
    signal(pid, signal) {
      events.push([signal, pid]);
      if ((signal === "SIGTERM" && ignoresTerm.includes(pid)) || survivesKill.includes(pid)) return;
      live = live.filter(p => p.pid !== pid);
    },
    detach(target) {
      events.push(["detach", target]);
      assert.ok(!live.some(p => p.executable.startsWith(`${bundle}/`) || p.executable.startsWith(`${copy}/`)), "detach must follow process exit");
      if (busy) throw new Error("Resource busy");
      if (!stillMounted) mounted = false;
    },
  };
  return { driver, events, live: () => live, image };
}

test("waits for shell, helpers, orphaned backend and validation copy; leaves other installs alone", async () => {
  const f = fixture({ processes: [
    { pid: 10, executable: shell },
    { pid: 11, executable: `${bundle}/Contents/Frameworks/Deepzora Helper.app/Contents/MacOS/Deepzora Helper` },
    { pid: 12, executable: service, ppid: 1 },
    { pid: 13, executable: `${copy}/Contents/Resources/service/deepzora-desktop` },
    { pid: 20, executable: "/Applications/Deepzora.app/Contents/MacOS/Deepzora" },
    { pid: 21, executable: `${bundle}.backup/Contents/MacOS/Deepzora` },
    { pid: 22, executable: "/bin/bash", args: shell },
  ] });
  await detachImage(mount, { extraApps: [copy] }, f.driver);
  assert.deepEqual(f.events, [["SIGTERM", 10], ["SIGTERM", 11], ["SIGTERM", 12], ["SIGTERM", 13], ["detach", mount]]);
  assert.deepEqual(f.live().map(p => p.pid), [20, 21, 22]);
});

test("SIGTERM timeout escalates only remaining service; safe forced cleanup still fails validation", async () => {
  const f = fixture({ processes: [{ pid: 10, executable: shell }, { pid: 12, executable: service }], ignoresTerm: [12] });
  await assert.rejects(detachImage("/dev/disk99", {}, f.driver), /required SIGKILL/);
  assert.deepEqual(f.events, [["SIGTERM", 10], ["SIGTERM", 12], ["SIGKILL", 12], ["detach", "/dev/disk99"]]);
  assert.ok(f.driver.now() >= 20_000);
});

test("unconfirmed process exit prevents detach entirely", async () => {
  const f = fixture({ processes: [{ pid: 12, executable: service }], survivesKill: [12] });
  await assert.rejects(detachImage(mount, {}, f.driver), /processes remain: 12/);
  assert.ok(!f.events.some(([event]) => event === "detach"));
});

test("busy disk never retries with force", async () => {
  const f = fixture({ busy: true });
  await assert.rejects(detachImage(mount, {}, f.driver), /Resource busy/);
  assert.deepEqual(f.events, [["detach", mount]]);
  assert.equal(f.driver.images().length, 1);
});

test("successful hdiutil exit is not enough when the mount remains", async () => {
  const f = fixture({ stillMounted: true });
  await assert.rejects(detachImage(mount, {}, f.driver), /still mounted/);
});

test("unknown target and foreign image fail without signalling any processes", async () => {
  const f = fixture({ processes: [{ pid: 10, executable: shell }] });
  await assert.rejects(detachImage("/dev/disk1", {}, f.driver), /Cannot identify/);
  await assert.rejects(detachImage(mount, { staging: "/other/build" }, f.driver), /outside this packaging run/);
  assert.deepEqual(f.events, []);
});

test("mount identity accepts macOS temporary-directory aliases", async () => {
  const f = fixture();
  f.driver.canonical = path => path === "/var/test/mounted" ? mount : path;
  await detachImage("/var/test/mounted", {}, f.driver);
  assert.deepEqual(f.events, [["detach", "/var/test/mounted"]]);
});

test("failure cleanup finds interstitial images by staging path and is idempotent", async () => {
  const f = fixture({ processes: [{ pid: 12, executable: service }] });
  await cleanupStaging("/build/staging", "Deepzora", f.driver);
  await cleanupStaging("/build/staging", "Deepzora", f.driver);
  assert.deepEqual(f.events, [["SIGTERM", 12], ["detach", mount]]);
});

test("cleanup never detaches unrelated images or prefix collisions", async () => {
  const f = fixture();
  await cleanupStaging("/build/stag", "Deepzora", f.driver);
  assert.deepEqual(f.events, []);
});

test("inventory errors fail closed", async () => {
  const f = fixture();
  f.driver.processes = () => { throw new Error("ps failed"); };
  await assert.rejects(detachImage(mount, {}, f.driver), /ps failed/);
  assert.deepEqual(f.events, []);
});

test("rescans catch a backend started while its shell is exiting", async () => {
  const f = fixture({ processes: [{ pid: 10, executable: shell }] });
  const scan = f.driver.processes;
  let calls = 0;
  let backendLive = true;
  f.driver.processes = () => ++calls > 1 && backendLive ? [{ pid: 12, executable: service }] : scan();
  const signal = f.driver.signal;
  f.driver.signal = (pid, sig) => { signal(pid, sig); if (pid === 12) backendLive = false; };
  await detachImage(mount, {}, f.driver);
  assert.deepEqual(f.events, [["SIGTERM", 10], ["SIGTERM", 12], ["detach", mount]]);
});

test("process inventory keeps unreadable system executables instead of failing", t => {
  if (process.getuid?.() === 0) return t.skip("root can read every directory");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "deepzora-dmg-proc-")));
  const locked = join(root, "staging");
  mkdirSync(locked);
  writeFileSync(join(locked, "exec"), "");
  chmodSync(locked, 0o000);
  t.after(() => { chmodSync(locked, 0o700); rmSync(root, { recursive: true, force: true }); });
  assert.equal(processExecutable(join(locked, "exec")), join(locked, "exec"));
  assert.equal(processExecutable(join(root, "missing", "exec")), join(root, "missing", "exec"));
  assert.equal(processExecutable("launchd"), "launchd");
});
