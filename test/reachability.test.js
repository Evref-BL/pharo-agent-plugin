import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  firstRetryDelayMs,
  guardedExporter,
  isClosed,
  longestRetryDelayMs,
  reachabilityFile,
  recordFailure,
  recordSuccess,
  retryAt,
  retryDelay,
  tracesEndpoint,
} from "../src/reachability.js";
import { startTelemetry } from "../src/telemetry.js";

const binary = new URL("../bin/pharo-agent.js", import.meta.url).pathname;
const plexusHook = new URL("./support/plexus-hook.js", import.meta.url).href;
const endpoint = "http://collector.test/v1/traces";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-reachability-"));
}

/** A localhost port nothing listens on, so a connection to it is refused at once. */
async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {net.AddressInfo} */ (server.address());
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return port;
}

test("the reachability is kept in the user's cache", () => {
  assert.equal(reachabilityFile({ XDG_CACHE_HOME: "/cache" }, "linux", "/home/ada"), "/cache/pharo-agent/otel-reachability.json");
  assert.equal(reachabilityFile({}, "linux", "/home/ada"), "/home/ada/.cache/pharo-agent/otel-reachability.json");
  assert.equal(reachabilityFile({ XDG_CACHE_HOME: "relative" }, "darwin", "/Users/ada"), "/Users/ada/.cache/pharo-agent/otel-reachability.json");
  assert.equal(
    reachabilityFile({ LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" }, "win32", "C:\\Users\\Ada"),
    "C:\\Users\\Ada\\AppData\\Local\\pharo-agent\\otel-reachability.json",
  );
});

test("the endpoint is the one the OTLP exporter sends traces to", () => {
  assert.equal(tracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.test/" }), "https://c.test/v1/traces");
  assert.equal(
    tracesEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://c.test", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://t.test/x" }),
    "https://t.test/x",
  );
  assert.equal(tracesEndpoint({}), undefined);
});

test("each failure in a row doubles the wait, up to six hours", () => {
  assert.equal(retryDelay(1), firstRetryDelayMs);
  assert.equal(retryDelay(2), 2 * firstRetryDelayMs);
  assert.equal(retryDelay(3), 4 * firstRetryDelayMs);
  assert.equal(retryDelay(50), longestRetryDelayMs);
});

test("a failure closes the endpoint until its time, and a success opens it", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "nested", "otel-reachability.json");
  try {
    assert.equal(isClosed(file, endpoint, 0), false);
    assert.equal(recordFailure(file, endpoint, 1_000), 1_000 + firstRetryDelayMs);
    assert.equal(isClosed(file, endpoint, 1_000 + firstRetryDelayMs - 1), true);
    assert.equal(isClosed(file, endpoint, 1_000 + firstRetryDelayMs), false);
    assert.equal(isClosed(file, "http://other.test/v1/traces", 1_000), false);
    assert.equal(recordFailure(file, endpoint, 2_000), 2_000 + 2 * firstRetryDelayMs);
    recordSuccess(file, endpoint);
    assert.equal(retryAt(file, endpoint), undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a damaged or unwritable state is read as no state, and nothing throws", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "otel-reachability.json");
  try {
    fs.writeFileSync(file, "not json");
    assert.equal(isClosed(file, endpoint, 0), false);
    assert.equal(recordFailure(file, endpoint, 0), firstRetryDelayMs);
    assert.equal(isClosed(file, endpoint, 0), true);
    const blocked = path.join(directory, "a-file", "otel-reachability.json");
    fs.writeFileSync(path.join(directory, "a-file"), "");
    assert.doesNotThrow(() => recordFailure(blocked, endpoint, 0));
    assert.equal(isClosed(blocked, endpoint, 0), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an exporter that failed is not tried again until its time, then is", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "otel-reachability.json");
  let clock = 0;
  /** @type {number[]} */
  const answers = [1, 0];
  let calls = 0;
  const inner = /** @type {any} */ ({
    export(_spans, done) { calls += 1; done({ code: answers.shift() }); },
    shutdown: async () => {},
  });
  const exporter = guardedExporter(inner, { file, endpoint, now: () => clock });
  /** @type {number[]} */
  const codes = [];
  const send = () => exporter.export([], (result) => codes.push(result.code));
  try {
    send();
    assert.equal(isClosed(file, endpoint, clock), true);
    clock = firstRetryDelayMs - 1;
    send();
    assert.equal(calls, 1, "a closed endpoint is not tried");
    clock = firstRetryDelayMs;
    send();
    assert.equal(calls, 2);
    assert.deepEqual(codes, [1, 1, 0]);
    assert.equal(retryAt(file, endpoint), undefined, "a success opens the endpoint again");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an exporter that throws counts as a failure, and the throw goes no further", () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "otel-reachability.json");
  const inner = /** @type {any} */ ({ export() { throw new Error("boom"); }, shutdown: async () => {} });
  try {
    /** @type {number[]} */
    const codes = [];
    guardedExporter(inner, { file, endpoint, now: () => 0 }).export([], (result) => codes.push(result.code));
    assert.deepEqual(codes, [1]);
    assert.equal(isClosed(file, endpoint, 0), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("while the collector is closed, no SDK is loaded", async () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, "otel-reachability.json");
  try {
    recordFailure(file, endpoint, 0);
    let loaded = false;
    const started = await startTelemetry({
      env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint, PLEXUS_TELEMETRY: "0" },
      agentHost: () => undefined,
      loadSdk: async () => { loaded = true; throw new Error("loaded"); },
      reachability: file,
      now: () => 1,
    });
    assert.equal(started, false);
    assert.equal(loaded, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const { CLAUDE_PROJECT_DIR: _host, ...inherited } = process.env;
    const child = spawn(process.execPath, ["--import", plexusHook, binary, ...args], { cwd: os.tmpdir(), env: { ...inherited, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("a CLI whose collector refuses records it, prints nothing more, and the next one does not try", async () => {
  const cache = temporaryDirectory();
  const settings = temporaryDirectory();
  try {
    const collector = `http://127.0.0.1:${await closedPort()}`;
    const env = { XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: settings, OTEL_EXPORTER_OTLP_ENDPOINT: collector, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" };
    const plain = /** @type {any} */ (await runCli(["--help"], { XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: settings }));
    const first = /** @type {any} */ (await runCli(["--help"], env));
    assert.equal(first.status, plain.status);
    assert.equal(first.stdout, plain.stdout);
    assert.equal(first.stderr, plain.stderr);
    const file = reachabilityFile({ XDG_CACHE_HOME: cache });
    const closedUntil = retryAt(file, `${collector}/v1/traces`);
    assert.ok(closedUntil !== undefined && closedUntil > Date.now(), "the refusal is recorded");

    const second = /** @type {any} */ (await runCli(["--help"], env));
    assert.equal(second.stdout, plain.stdout);
    assert.equal(retryAt(file, `${collector}/v1/traces`), closedUntil, "a closed collector is not tried, so nothing changes");
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
    fs.rmSync(settings, { recursive: true, force: true });
  }
});
