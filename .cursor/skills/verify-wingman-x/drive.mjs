#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const currentPath = join(tmpdir(), "wingman-x-verify-current.json");
const daemonPkgPath = join(repoRoot, "packages/daemon/package.json");
const extensionDist = join(repoRoot, "packages/extension/dist");
const fixturePath = join(repoRoot, "test/fixtures/tweet-detail.html");

const popupSeed = {
  id: "cand-verify-9001",
  tweet_id: "9001",
  tweet_url: "https://x.com/wingman_verify/status/9001",
  author_handle: "@wingman_verify",
  tweet_text: "Verification seed: the popup should list this tweet.",
  suggested_reply: "Verified reply from the Wingman-X popup journey.",
  match_reason: "verify-wingman-x popup-list",
  match_category: "selected",
  kb_refs: [],
};

const jackSeed = {
  id: "cand-20",
  tweet_id: "20",
  tweet_url: "https://twitter.com/jack/status/20",
  author_handle: "@jack",
  tweet_text: "Hello, Twitter.",
  suggested_reply: "Hi Jack, great first tweet.",
  match_reason: "verify-wingman-x dock-fill",
  match_category: "selected",
  kb_refs: [],
};

function readRun() {
  if (!existsSync(currentPath)) {
    throw new Error(`no verify run at ${currentPath}; run launch`);
  }
  return JSON.parse(readFileSync(currentPath, "utf8"));
}

function writeRun(run) {
  writeFileSync(currentPath, JSON.stringify(run, null, 2));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ppidOf(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /^PPid:\s+(\d+)/m.exec(status);
  return match ? Number(match[1]) : 0;
}

function isDescendant(ancestor, pid) {
  let current = pid;
  for (let i = 0; i < 12; i += 1) {
    if (current === ancestor) return true;
    const parent = ppidOf(current);
    if (!parent || parent === current) return false;
    current = parent;
  }
  return false;
}

function listeningPids(port) {
  const hex = port.toString(16).toUpperCase();
  const inodes = new Set();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const localPort = parts[1]?.split(":")[1] ?? "";
      if (localPort.toUpperCase() === hex && parts[3] === "0A") {
        inodes.add(parts[9]);
      }
    }
  }
  if (inodes.size === 0) return [];
  const hits = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let fds;
    try {
      fds = readdirSync(`/proc/${name}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${name}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(target);
        if (match && inodes.has(match[1])) hits.push(Number(name));
      } catch {
        // fd vanished
      }
    }
  }
  return hits;
}

function pidsWithArg(arg) {
  const hits = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = readFileSync(`/proc/${name}/cmdline`);
      if (cmd.includes(arg)) hits.push(Number(name));
    } catch {
      // Process exited while we scanned.
    }
  }
  return hits;
}

function environHas(pid, key, value) {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`).toString("utf8");
    return raw.split("\0").includes(`${key}=${value}`);
  } catch {
    return false;
  }
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

async function waitUntilDead(pid) {
  for (let i = 0; i < 25; i += 1) {
    if (!pidAlive(pid)) return;
    await sleep(100);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function waitForListen(logPath, pid) {
  const started = Date.now();
  let buf = "";
  while (Date.now() - started < 20_000) {
    if (existsSync(logPath)) buf = readFileSync(logPath, "utf8");
    const match = /\[daemon\] listening on port (\d+)/.exec(buf);
    if (match) return Number(match[1]);
    if (!pidAlive(pid)) {
      throw new Error(`daemon exited before listen\n${buf}`);
    }
    await sleep(100);
  }
  killGroup(pid);
  throw new Error(`daemon did not emit a listen line in 20s\n${buf}`);
}

function runBuild() {
  return new Promise((resolveBuild, reject) => {
    const child = spawn(
      "npm",
      ["--workspace", "@wingman-x/extension", "run", "build"],
      { cwd: repoRoot, stdio: "inherit" },
    );
    child.once("exit", (code) => {
      if (code === 0) resolveBuild();
      else reject(new Error(`extension build exited ${code}`));
    });
  });
}

async function launch() {
  if (existsSync(currentPath)) {
    const prev = JSON.parse(readFileSync(currentPath, "utf8"));
    if (pidAlive(prev.pid)) {
      throw new Error(
        `refusing to start a second daemon (pid ${prev.pid} on port ${prev.port}). Run cleanup first.`,
      );
    }
  }
  await runBuild();
  const id = `${Date.now()}`;
  const root = join(tmpdir(), `wingman-x-verify-${id}`);
  const stateDir = join(root, "state");
  const evidenceDir = join(root, "evidence");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(root, "daemon.log");
  const logFd = openSync(logPath, "a");
  const child = spawn(
    "npm",
    ["--workspace", "@wingman-x/daemon", "run", "dev", "--silent"],
    {
      cwd: repoRoot,
      env: { ...process.env, WINGMAN_X_STATE_DIR: stateDir },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    },
  );
  child.unref();
  const port = await waitForListen(logPath, child.pid);
  writeRun({
    pid: child.pid,
    port,
    stateDir,
    evidenceDir,
    root,
    logPath,
    chromePids: [],
  });
  console.log(
    `launched pid=${child.pid} port=${port} state=${stateDir} evidence=${evidenceDir}`,
  );
}

async function doctor() {
  const run = readRun();
  if (!pidAlive(run.pid)) {
    throw new Error(`daemon pid ${run.pid} is not running`);
  }
  const listeners = listeningPids(run.port);
  const listener = listeners.find(
    (pid) => pid === run.pid || isDescendant(run.pid, pid),
  );
  if (!listener) {
    throw new Error(
      `port ${run.port} listeners [${listeners.join(", ")}] are not descendants of ${run.pid}`,
    );
  }
  const envOk =
    environHas(listener, "WINGMAN_X_STATE_DIR", run.stateDir) ||
    environHas(run.pid, "WINGMAN_X_STATE_DIR", run.stateDir);
  if (!envOk) {
    throw new Error(
      `listener ${listener} is not using WINGMAN_X_STATE_DIR=${run.stateDir}`,
    );
  }
  const res = await fetch(`http://127.0.0.1:${run.port}/health`);
  const header = res.headers.get("x-twitter-helper-daemon");
  const body = await res.json();
  const pkg = JSON.parse(readFileSync(daemonPkgPath, "utf8"));
  if (
    !res.ok ||
    body.status !== "ok" ||
    body.version !== pkg.version ||
    header !== pkg.version
  ) {
    throw new Error(
      `health mismatch status=${res.status} header=${header} body=${JSON.stringify(body)} expected=${pkg.version}`,
    );
  }
  const manifest = JSON.parse(
    readFileSync(join(extensionDist, "manifest.json"), "utf8"),
  );
  if (manifest.name !== "Wingman-X") {
    throw new Error(`extension dist name is ${manifest.name}`);
  }
  console.log(
    `doctor ok port=${run.port} daemon=${pkg.version} extension=${manifest.version} state=${run.stateDir}`,
  );
}

async function postCandidate(port, candidate) {
  const res = await fetch(`http://127.0.0.1:${port}/candidates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidates: [candidate] }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /candidates ${res.status} ${text}`);
}

async function getCandidates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/candidates`);
  if (!res.ok) throw new Error(`GET /candidates ${res.status}`);
  return res.json();
}

function assertNoConsoleErrors(errors) {
  if (errors.length > 0) {
    throw new Error(`console errors: ${errors.join(" | ")}`);
  }
}

async function withExtension(run, fn) {
  const { chromium } = await import("playwright");
  const userDataDir = join(run.root, "chrome");
  mkdirSync(userDataDir, { recursive: true });
  const args = [
    `--disable-extensions-except=${extensionDist}`,
    `--load-extension=${extensionDist}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=DialMediaRouteProvider",
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    args.push("--no-sandbox", "--disable-dev-shm-usage");
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
  });
  run.chromePids = pidsWithArg(userDataDir);
  writeRun(run);
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
    const match = /^chrome-extension:\/\/([^/]+)\//.exec(worker.url());
    if (!match) throw new Error(`no extension id in ${worker.url()}`);
    await fn(context, match[1]);
  } finally {
    await context.close().catch(() => {});
    for (const pid of pidsWithArg(userDataDir)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    run.chromePids = [];
    writeRun(run);
  }
}

async function openPopup(context, extensionId) {
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return { page, errors };
}

function writeProof(run, name, lines) {
  writeFileSync(join(run.evidenceDir, `${name}.txt`), `${lines.join("\n")}\n`);
}

async function drivePopupList(run) {
  await postCandidate(run.port, popupSeed);
  await withExtension(run, async (context, extensionId) => {
    const { page, errors } = await openPopup(context, extensionId);
    const card = page.locator(
      '[data-testid="twh-popup-card"][data-id="9001"]',
    );
    await card.waitFor({ state: "visible", timeout: 8_000 });
    const text = await card.innerText();
    if (!text.includes("@wingman_verify")) {
      throw new Error(`card missing handle: ${text}`);
    }
    if (!text.includes(popupSeed.suggested_reply)) {
      throw new Error(`card missing reply: ${text}`);
    }
    const footer = page.locator("[data-testid='twh-popup-port-status']");
    const footerText = await footer.innerText();
    if (!footerText.includes(String(run.port))) {
      throw new Error(`footer "${footerText}" does not name port ${run.port}`);
    }
    await page.screenshot({
      path: join(run.evidenceDir, "popup-list.png"),
      fullPage: true,
    });
    writeProof(run, "popup-list", [
      "feature=popup-list",
      `extension=${extensionId}`,
      `url=${page.url()}`,
      `footer=${footerText}`,
      `card=${text.replaceAll("\n", " | ")}`,
      `consoleErrors=${errors.length ? errors.join(" | ") : "none"}`,
    ]);
    assertNoConsoleErrors(errors);
  });
  const listed = await getCandidates(run.port);
  const found = listed.candidates?.find((c) => c.tweet_id === "9001");
  if (!found || found.status !== "pending") {
    throw new Error(`GET /candidates missing pending 9001: ${JSON.stringify(listed)}`);
  }
  const state = JSON.parse(readFileSync(join(run.stateDir, "state.json"), "utf8"));
  if (!state.candidates?.["9001"]) throw new Error("state.json missing 9001");
  writeFileSync(
    join(run.evidenceDir, "candidates.json"),
    JSON.stringify(listed, null, 2),
  );
  console.log(`popup-list ok evidence=${run.evidenceDir}`);
}

async function drivePopupEmpty(run) {
  const listed = await getCandidates(run.port);
  if ((listed.candidates ?? []).length !== 0) {
    throw new Error(
      "popup-empty needs a fresh launch with zero candidates. Run cleanup, then launch.",
    );
  }
  await withExtension(run, async (context, extensionId) => {
    const { page, errors } = await openPopup(context, extensionId);
    const empty = page.getByText("No candidates yet — run your agent.");
    await empty.waitFor({ state: "visible", timeout: 8_000 });
    const footer = page.locator("[data-testid='port-status']");
    const footerText = await footer.innerText();
    if (!/Connected to daemon on port \d+/.test(footerText)) {
      throw new Error(`empty footer unexpected: ${footerText}`);
    }
    if (!footerText.includes(String(run.port))) {
      throw new Error(`footer "${footerText}" does not name port ${run.port}`);
    }
    await page.screenshot({
      path: join(run.evidenceDir, "popup-empty.png"),
      fullPage: true,
    });
    writeProof(run, "popup-empty", [
      "feature=popup-empty",
      `extension=${extensionId}`,
      `footer=${footerText}`,
      `consoleErrors=${errors.length ? errors.join(" | ") : "none"}`,
    ]);
    assertNoConsoleErrors(errors);
  });
  console.log(`popup-empty ok evidence=${run.evidenceDir}`);
}

async function drivePopupDismiss(run) {
  await postCandidate(run.port, popupSeed);
  await withExtension(run, async (context, extensionId) => {
    const { page, errors } = await openPopup(context, extensionId);
    const card = page.locator(
      '[data-testid="twh-popup-card"][data-id="9001"]',
    );
    await card.waitFor({ state: "visible", timeout: 8_000 });
    await card.locator("[data-testid='twh-popup-dismiss']").click();
    await page.getByText("No candidates yet — run your agent.").waitFor({
      state: "visible",
      timeout: 8_000,
    });
    await page.screenshot({
      path: join(run.evidenceDir, "popup-dismiss.png"),
      fullPage: true,
    });
    writeProof(run, "popup-dismiss", [
      "feature=popup-dismiss",
      `extension=${extensionId}`,
      "ui=empty after dismiss",
      `consoleErrors=${errors.length ? errors.join(" | ") : "none"}`,
    ]);
    assertNoConsoleErrors(errors);
  });
  const listed = await getCandidates(run.port);
  const found = listed.candidates?.find((c) => c.tweet_id === "9001");
  if (!found || found.status !== "dismissed") {
    throw new Error(`dismiss did not persist: ${JSON.stringify(listed)}`);
  }
  writeFileSync(
    join(run.evidenceDir, "candidates-dismissed.json"),
    JSON.stringify(listed, null, 2),
  );
  console.log(`popup-dismiss ok evidence=${run.evidenceDir}`);
}

async function driveRequestDiscovery(run) {
  await withExtension(run, async (context, extensionId) => {
    const { page, errors } = await openPopup(context, extensionId);
    const button = page.locator(
      "[data-testid='twh-request-discovery-empty']:visible, [data-testid='twh-request-discovery-list']:visible",
    );
    await button.waitFor({ state: "visible", timeout: 8_000 });
    await button.click();
    const status = page.locator(
      "[data-testid='twh-request-status-empty']:visible, [data-testid='twh-request-status-list']:visible",
    );
    await status.filter({ hasText: "Requested at" }).waitFor({
      state: "visible",
      timeout: 8_000,
    });
    const statusText = await status.innerText();
    await page.screenshot({
      path: join(run.evidenceDir, "request-discovery.png"),
      fullPage: true,
    });
    writeProof(run, "request-discovery", [
      "feature=request-discovery",
      `extension=${extensionId}`,
      `status=${statusText}`,
      `consoleErrors=${errors.length ? errors.join(" | ") : "none"}`,
    ]);
    assertNoConsoleErrors(errors);
  });
  const res = await fetch(
    `http://127.0.0.1:${run.port}/signals?kind=discovery_requested&status=pending`,
  );
  const body = await res.json();
  const pending = (body.signals ?? []).filter(
    (s) => s.kind === "discovery_requested" && s.status === "pending",
  );
  if (pending.length < 1) {
    throw new Error(`no pending discovery signal: ${JSON.stringify(body)}`);
  }
  writeFileSync(
    join(run.evidenceDir, "signals.json"),
    JSON.stringify(body, null, 2),
  );
  console.log(`request-discovery ok evidence=${run.evidenceDir}`);
}

function startFixture() {
  const html = readFileSync(fixturePath, "utf8");
  const server = createServer((req, res) => {
    const urlPath = req.url ?? "/";
    if (/^\/[^/]+\/status\/\d+\/?(\?.*)?$/.test(urlPath)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(204);
    res.end();
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolveServer({
        base: `http://localhost:${addr.port}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function driveDockFill(run) {
  await postCandidate(run.port, jackSeed);
  const fixture = await startFixture();
  try {
    await withExtension(run, async (context, extensionId) => {
      const page = await context.newPage();
      const errors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      page.on("pageerror", (err) => errors.push(err.message));
      await page.goto(`${fixture.base}/jack/status/20`);
      const dock = page.locator("#twh-dock");
      await dock.waitFor({ state: "visible", timeout: 8_000 });
      const composer = page.locator("[data-testid='tweetTextarea_0']");
      const tweetBtn = page.locator("[data-testid='tweetButtonInline']");
      if ((await composer.innerText()) !== "") {
        throw new Error("composer was not empty before fill");
      }
      if (await tweetBtn.isEnabled()) {
        throw new Error("Tweet button was enabled before fill");
      }
      await page.locator("[data-testid='twh-fill']").click();
      await composer.filter({ hasText: jackSeed.suggested_reply }).waitFor({
        state: "visible",
        timeout: 8_000,
      });
      if (!(await tweetBtn.isEnabled())) {
        throw new Error("Tweet button stayed disabled after fill");
      }
      await page.screenshot({
        path: join(run.evidenceDir, "dock-fill.png"),
        fullPage: true,
      });
      writeProof(run, "dock-fill", [
        "feature=dock-fill",
        `extension=${extensionId}`,
        `url=${page.url()}`,
        `composer=${await composer.innerText()}`,
        `tweetEnabled=${await tweetBtn.isEnabled()}`,
        `consoleErrors=${errors.length ? errors.join(" | ") : "none"}`,
      ]);
      assertNoConsoleErrors(errors);
    });
  } finally {
    await fixture.close();
  }
  const listed = await getCandidates(run.port);
  const found = listed.candidates?.find((c) => c.tweet_id === "20");
  if (!found || found.status !== "filled") {
    throw new Error(`fill did not persist: ${JSON.stringify(listed)}`);
  }
  writeFileSync(
    join(run.evidenceDir, "candidates-filled.json"),
    JSON.stringify(listed, null, 2),
  );
  console.log(`dock-fill ok evidence=${run.evidenceDir}`);
}

const drives = {
  "popup-list": drivePopupList,
  "popup-empty": drivePopupEmpty,
  "popup-dismiss": drivePopupDismiss,
  "request-discovery": driveRequestDiscovery,
  "dock-fill": driveDockFill,
};

async function cleanup() {
  if (!existsSync(currentPath)) {
    console.log("no run to clean");
    return;
  }
  const run = readRun();
  const evidenceDir = run.evidenceDir;
  if (pidAlive(run.pid)) {
    killGroup(run.pid);
    await waitUntilDead(run.pid);
  }
  for (const pid of run.chromePids ?? []) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  if (run.root) {
    for (const pid of pidsWithArg(`${run.root}/chrome`)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
  rmSync(run.stateDir, { recursive: true, force: true });
  if (run.root) rmSync(join(run.root, "chrome"), { recursive: true, force: true });
  rmSync(currentPath, { force: true });
  const required = process.argv.includes("--require-popup-list")
    ? ["popup-list.png", "popup-list.txt", "candidates.json"]
    : [];
  const missing = required.filter((name) => !existsSync(join(evidenceDir, name)));
  if (missing.length > 0) {
    throw new Error(
      `evidence missing after cleanup: ${missing.join(", ")} in ${evidenceDir}`,
    );
  }
  const left = existsSync(evidenceDir) ? readdirSync(evidenceDir) : [];
  console.log(`cleaned; evidence remains at ${evidenceDir} (${left.join(", ")})`);
}

const cmd = process.argv[2];
try {
  if (cmd === "launch") await launch();
  else if (cmd === "doctor") await doctor();
  else if (cmd === "drive") {
    const feature = process.argv[3];
    const fn = drives[feature];
    if (!fn) {
      throw new Error(
        `unknown feature ${feature}. Known: ${Object.keys(drives).join(", ")}`,
      );
    }
    await fn(readRun());
  } else if (cmd === "cleanup") await cleanup();
  else if (cmd === "prove") {
    let proved = false;
    try {
      await launch();
      await doctor();
      await drivePopupList(readRun());
      proved = true;
      process.argv.push("--require-popup-list");
    } finally {
      if (existsSync(currentPath)) await cleanup();
    }
    if (!proved) process.exit(1);
  } else {
    console.error(
      "usage: drive.mjs launch|doctor|drive <feature>|cleanup|prove",
    );
    process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
}
