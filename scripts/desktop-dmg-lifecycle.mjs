import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const sleep = ms => new Promise(done => setTimeout(done, ms));
// A failed copy may not have created the app yet; its existing ancestors still
// determine its identity (including macOS /var -> /private/var aliases).
function canonical(path) {
  try { return realpathSync(path); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonical(parent), basename(path));
  }
}
const within = (path, root) => path.startsWith(`${root}${sep}`);

// System daemons can run from directories the runner cannot read (for example
// /private/var/db/com.apple.xpc.roleaccountd.staging). Such a path cannot be
// inside a mount or staging copy we created, so its literal path is enough.
export function processExecutable(path) {
  if (!path.startsWith("/")) return path;
  try { return canonical(path); } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM") return path;
    throw error;
  }
}

function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${file} ${args.join(" ")}: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return result.stdout;
}

export function macOSDriver(hdiutil = "/usr/bin/hdiutil") {
  return {
    images() {
      const plist = command(hdiutil, ["info", "-plist"]);
      const info = JSON.parse(command("plutil", ["-convert", "json", "-o", "-", "-"], { input: plist }));
      if (!Array.isArray(info.images)) throw new Error("hdiutil returned no image inventory");
      return info.images;
    },
    processes() {
      // comm is the executable path, not argv: an unrelated shell mentioning
      // the mount in an argument must never become a termination target.
      const paths = new Map();
      return command("/bin/ps", ["-ww", "-axo", "pid=,comm="]).trim().split("\n").map(line => {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!match) throw new Error(`Cannot parse process inventory: ${line}`);
        const path = match[2];
        if (!paths.has(path)) paths.set(path, processExecutable(path));
        return { pid: Number(match[1]), executable: paths.get(path) };
      });
    },
    signal(pid, signal) {
      try { process.kill(pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
    },
    detach(target) { command(hdiutil, ["detach", target]); },
    canonical,
    sleep,
    now: Date.now,
    log: message => console.error(message),
  };
}

// Includes Electron helpers and orphaned Go services even when PPID is 1.
// Re-scan before every signal to avoid acting on stale/reused process IDs.
export async function stopApps(apps, driver, { termTimeout = 20_000, killTimeout = 5_000 } = {}) {
  const roots = apps.flatMap(path => [resolve(path), driver.canonical(resolve(path))]);
  const remaining = () => driver.processes().filter(p => roots.some(root => within(p.executable, root)));
  let forced = false;
  for (const [signal, timeout] of [["SIGTERM", termTimeout], ["SIGKILL", killTimeout]]) {
    const deadline = driver.now() + timeout;
    const signalled = new Set();
    for (;;) {
      const processes = remaining();
      if (processes.length === 0) return { forced };
      for (const p of processes) {
        const identity = `${p.pid}:${p.executable}`;
        if (signalled.has(identity)) continue;
        driver.log(`${signal} ${p.pid} ${p.executable}`);
        driver.signal(p.pid, signal);
        signalled.add(identity);
        if (signal === "SIGKILL") forced = true;
      }
      if (driver.now() >= deadline) break;
      await driver.sleep(100);
    }
  }
  const processes = remaining();
  if (processes.length) throw new Error(`Refusing DMG detach: processes remain: ${processes.map(p => p.pid).join(", ")}`);
  return { forced };
}

export async function detachImage(target, { appName = "Deepzora", extraApps = [], staging } = {}, driver = macOSDriver()) {
  const images = driver.images();
  const image = images.find(image => image["system-entities"].some(entity =>
    entity["dev-entry"] === target || (entity["mount-point"] &&
      driver.canonical(entity["mount-point"]) === driver.canonical(resolve(target)))));
  if (!image) throw new Error(`Cannot identify mounted DMG: ${target}`);
  if (staging && !within(driver.canonical(image["image-path"]), driver.canonical(staging))) {
    throw new Error(`Refusing to detach an image outside this packaging run: ${image["image-path"]}`);
  }
  const mounts = image["system-entities"].flatMap(entity => entity["mount-point"] ? [entity["mount-point"]] : []);
  const apps = [...mounts.map(mount => join(mount, `${appName}.app`)), ...extraApps];
  if (!apps.length) throw new Error(`Cannot determine application paths for ${target}`);
  const { forced } = await stopApps(apps, driver);
  // No -force fallback. EBUSY may indicate an unrecognised mapping/open file;
  // keep the backing image available and let the caller fail with evidence.
  driver.detach(target);
  if (driver.images().some(current => current["system-entities"].some(entity =>
    mounts.includes(entity["mount-point"]) || entity["dev-entry"] === target))) {
    throw new Error(`DMG still mounted after detach: ${target}`);
  }
  if (forced) throw new Error("DMG detached safely, but app cleanup required SIGKILL; validation failed");
}

export async function cleanupStaging(staging, appName, driver = macOSDriver()) {
  const root = driver.canonical(resolve(staging));
  const owned = () => driver.images().filter(image => within(driver.canonical(image["image-path"]), root));
  for (const image of owned()) {
    const target = image["system-entities"].find(entity => entity["mount-point"])?.["mount-point"];
    if (!target) throw new Error(`Cannot safely clean mounted image: ${image["image-path"]}`);
    await detachImage(target, { appName, staging }, driver);
  }
  if (owned().length) throw new Error(`Mounted images remain in ${staging}`);
}
