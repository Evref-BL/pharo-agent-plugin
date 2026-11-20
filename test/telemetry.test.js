import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applySettingsFile,
  argumentNames,
  configuredExportTimeout,
  errorType,
  exportProtocol,
  isConfigured,
  parseSettings,
  safeName,
  settingsFile,
  shutdownTelemetry,
  startTelemetry,
} from "../src/telemetry.js";
import { osType, telemetryResource } from "../src/telemetrySdk.js";
import { writeConfig } from "../src/project.js";
import { sessionFile } from "../src/session.js";
import { plexusHook } from "./support/fake-plexus.js";

const binary = fileURLToPath(new URL("../bin/pharo-agent.js", import.meta.url));
const recordImports = new URL("./support/record-imports.js", import.meta.url).href;

function temporaryDirectory() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-telemetry-")));
}

/** A settings directory holding `text` as its otel.env. */
function settingsHome(text) {
  const home = temporaryDirectory();
  fs.mkdirSync(path.join(home, "pharo-agent"));
  fs.writeFileSync(path.join(home, "pharo-agent", "otel.env"), text);
  return home;
}

const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" };

test("the settings file is the XDG one, or APPDATA's on Windows", () => {
  assert.equal(
    settingsFile({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me"),
    "/xdg/pharo-agent/otel.env",
  );
  assert.equal(settingsFile({}, "darwin", "/Users/me"), "/Users/me/.config/pharo-agent/otel.env");
  // A relative XDG_CONFIG_HOME is invalid, and ignored.
  assert.equal(settingsFile({ XDG_CONFIG_HOME: "xdg" }, "linux", "/home/me"), "/home/me/.config/pharo-agent/otel.env");
  assert.equal(
    settingsFile({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me"),
    "C:\\Users\\me\\AppData\\Roaming\\pharo-agent\\otel.env",
  );
});

test("the settings file gives its OTEL_* lines and ignores every other key", () => {
  assert.deepEqual(parseSettings([
    "# where traces go",
    "",
    "OTEL_EXPORTER_OTLP_ENDPOINT=https://traces.example.test",
    "  OTEL_EXPORTER_OTLP_HEADERS = Authorization=Bearer abc==  ",
    "export OTEL_RESOURCE_ATTRIBUTES=\"deployment.environment.name=field\"",
    "OTEL_SERVICE_NAME='quoted'",
    "PLEXUS_TELEMETRY=0",
    "PATH=/nowhere",
    "NODE_OPTIONS=--require /tmp/x.js",
    "otel_lowercase=1",
    "not a setting",
  ].join("\r\n")), {
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://traces.example.test",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer abc==",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment.name=field",
    OTEL_SERVICE_NAME: "quoted",
  });
});

test("the settings file is read only when the environment has no OTEL_* at all", () => {
  const home = settingsHome("OTEL_EXPORTER_OTLP_ENDPOINT=http://from-file\nHOME=/elsewhere\n");
  try {
    const bare = { XDG_CONFIG_HOME: home, HOME: "/home/me" };
    assert.deepEqual(applySettingsFile(bare), { OTEL_EXPORTER_OTLP_ENDPOINT: "http://from-file" });
    assert.deepEqual(bare, { XDG_CONFIG_HOME: home, HOME: "/home/me", OTEL_EXPORTER_OTLP_ENDPOINT: "http://from-file" });

    // Any OTEL_* means the environment decides, even one that names no exporter.
    const own = { XDG_CONFIG_HOME: home, OTEL_SDK_DISABLED: "true" };
    assert.deepEqual(applySettingsFile(own), {});
    assert.deepEqual(own, { XDG_CONFIG_HOME: home, OTEL_SDK_DISABLED: "true" });

    const missing = { XDG_CONFIG_HOME: path.join(home, "absent") };
    assert.deepEqual(applySettingsFile(missing), {});
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("traces are configured by an OTLP endpoint, unless disabled or sent elsewhere", () => {
  assert.equal(isConfigured({}), false);
  assert.equal(isConfigured(endpoint), true);
  assert.equal(isConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces" }), true);
  assert.equal(isConfigured({ ...endpoint, OTEL_EXPORTER_OTLP_ENDPOINT: "  " }), false);
  assert.equal(isConfigured({ ...endpoint, OTEL_SDK_DISABLED: "true" }), false);
  assert.equal(isConfigured({ ...endpoint, OTEL_SDK_DISABLED: "TRUE" }), false);
  assert.equal(isConfigured({ ...endpoint, OTEL_SDK_DISABLED: "false" }), true);
  assert.equal(isConfigured({ ...endpoint, OTEL_TRACES_EXPORTER: "none" }), false);
  assert.equal(isConfigured({ ...endpoint, OTEL_TRACES_EXPORTER: "console" }), false);
  assert.equal(isConfigured({ ...endpoint, OTEL_TRACES_EXPORTER: "otlp" }), true);
  assert.equal(isConfigured({ ...endpoint, OTEL_TRACES_EXPORTER: "console, otlp" }), true);
  // gRPC is not spoken here, so it configures nothing rather than send to an endpoint that cannot read it.
  assert.equal(isConfigured({ ...endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }), false);
  assert.equal(isConfigured({ ...endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" }), true);
});

test("the protocol is http/protobuf unless the settings say http/json, the traces' own first", () => {
  assert.equal(exportProtocol({}), "http/protobuf");
  assert.equal(exportProtocol({ OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" }), "http/json");
  assert.equal(
    exportProtocol({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf" }),
    "http/protobuf",
  );
  assert.equal(exportProtocol({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" }), undefined);
});

test("the export timeout is the settings' when they give one", () => {
  assert.equal(configuredExportTimeout({}), undefined);
  assert.equal(configuredExportTimeout({ OTEL_EXPORTER_OTLP_TIMEOUT: "5000" }), 5000);
  assert.equal(configuredExportTimeout({ OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: "700", OTEL_EXPORTER_OTLP_TIMEOUT: "5000" }), 700);
  assert.equal(configuredExportTimeout({ OTEL_EXPORTER_OTLP_TIMEOUT: "soon" }), undefined);
});

/** An SDK stand-in, which says how it was installed. */
function fakeSdk() {
  /** @type {any[]} */
  const installs = [];
  let loads = 0;
  const loadSdk = async () => {
    loads += 1;
    return /** @type {any} */ ({
      installSdk: async (options) => {
        installs.push(options);
        return { shutdown: async () => {} };
      },
    });
  };
  return { loadSdk, installs, loads: () => loads };
}

test("nothing is loaded and PLexus is not enrolled when nothing is configured", async () => {
  const home = temporaryDirectory();
  try {
    const sdk = fakeSdk();
    const env = { XDG_CONFIG_HOME: home };
    assert.equal(await startTelemetry({ env, loadSdk: sdk.loadSdk, agentHost: () => "claude" }), false);
    assert.equal(sdk.loads(), 0);
    assert.equal("PLEXUS_TELEMETRY" in env, false);

    const disabled = { ...endpoint, OTEL_SDK_DISABLED: "true" };
    assert.equal(await startTelemetry({ env: disabled, loadSdk: sdk.loadSdk }), false);
    assert.equal(sdk.loads(), 0);
    assert.equal("PLEXUS_TELEMETRY" in disabled, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("configured settings enroll PLexus and install the SDK with a two-second export timeout", async () => {
  const home = settingsHome("OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318\nOTEL_EXPORTER_OTLP_PROTOCOL=http/json\n");
  try {
    const sdk = fakeSdk();
    /** @type {Record<string, string | undefined>} */
    const env = { XDG_CONFIG_HOME: home };
    assert.equal(await startTelemetry({ env, loadSdk: sdk.loadSdk, agentHost: () => "claude" }), true);
    await shutdownTelemetry();
    assert.equal(env.PLEXUS_TELEMETRY, "1");
    assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, "http://127.0.0.1:4318");
    assert.equal(sdk.installs.length, 1);
    assert.equal(sdk.installs[0].protocol, "http/json");
    assert.equal(sdk.installs[0].timeoutMillis, 2000);
    assert.equal(sdk.installs[0].exportTimeoutMillis, 2000);
    assert.equal(sdk.installs[0].agentHost, "claude");

    // A choice already made about PLexus stands, and so does a timeout the settings name.
    const own = { ...endpoint, PLEXUS_TELEMETRY: "0", OTEL_EXPORTER_OTLP_TIMEOUT: "5000" };
    assert.equal(await startTelemetry({ env: own, loadSdk: sdk.loadSdk, agentHost: () => undefined }), true);
    await shutdownTelemetry();
    assert.equal(own.PLEXUS_TELEMETRY, "0");
    assert.equal(sdk.installs[1].timeoutMillis, undefined);
    assert.equal(sdk.installs[1].exportTimeoutMillis, 5000);
    assert.equal("agentHost" in sdk.installs[1], false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("an SDK that fails to load leaves the tools as they were", async () => {
  const env = { ...endpoint };
  const loadSdk = async () => { throw new Error("no SDK here"); };
  assert.equal(await startTelemetry({ env, loadSdk }), false);
});

test("a name is kept only when it looks like an identifier", () => {
  for (const name of ["class_get", "Class", "_x", "with-dash", "a".repeat(64)]) {
    assert.equal(safeName(name), name);
  }
  for (const name of ["", "1abc", "has space", "/etc/passwd", "a.b", "a".repeat(65), "naïve", 42, undefined]) {
    assert.equal(safeName(name), undefined, String(name));
  }
  assert.deepEqual(argumentNames({ name: "Point", "bad key": 1, "../x": 2, source: "x := 1" }), ["name", "source"]);
  assert.deepEqual(argumentNames(["a"]), []);
  assert.deepEqual(argumentNames(undefined), []);
});

test("an error's type is its JSON-RPC code or its class name, never its message", () => {
  assert.equal(errorType(Object.assign(new Error("MCP error -32602: bad"), { name: "McpError", code: -32602 })), "-32602");
  assert.equal(errorType(new TypeError("secret /Users/me/project")), "TypeError");
  assert.equal(errorType(Object.assign(new Error("x"), { name: "PlexusError", code: "not-running" })), "PlexusError");
  assert.equal(errorType(Object.assign(new Error("x"), { name: "not a name" })), "_OTHER");
  assert.equal(errorType("thrown string"), "_OTHER");
});

test("the resource is the service, its version, the OS family, the host and the configured attributes", () => {
  const previous = process.env.OTEL_RESOURCE_ATTRIBUTES;
  process.env.OTEL_RESOURCE_ATTRIBUTES = "deployment.environment.name=field,service.name=overridden";
  try {
    const { attributes } = telemetryResource({ version: "9.9.9", agentHost: "codex", platform: "win32" });
    assert.deepEqual(attributes, {
      "deployment.environment.name": "field",
      "service.name": "pharo-agent",
      "service.version": "9.9.9",
      "os.type": "windows",
      "pharo_agent.agent_host": "codex",
    });
  } finally {
    if (previous === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = previous;
  }
  assert.equal(osType("darwin"), "darwin");
  assert.equal(osType("linux"), "linux");
});

function hermeticEnv() {
  const { CLAUDE_PROJECT_DIR: _host, ...inherited } = process.env;
  return inherited;
}

/**
 * Runs the CLI as a host would, and answers what it printed and which
 * OpenTelemetry modules it resolved.
 *
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {string} [cwd]
 */
function runCli(args, env, cwd = os.tmpdir()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", plexusHook, "--import", recordImports, binary, ...args], {
      cwd,
      // The host running these tests may name its own project.
      env: { ...hermeticEnv(), ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => {
      const marker = "\nresolved: ";
      const at = stderr.lastIndexOf(marker);
      const resolved = at === -1 ? [] : JSON.parse(stderr.slice(at + marker.length));
      resolve({ status, stdout, stderr: at === -1 ? stderr : stderr.slice(0, at), resolved });
    });
  });
}

test("an unconfigured CLI loads no OpenTelemetry beyond the API", async () => {
  const home = temporaryDirectory();
  try {
    const run = /** @type {any} */ (await runCli(["--help"], { XDG_CONFIG_HOME: home }));
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.resolved.length > 0, "the API is resolved");
    const beyondApi = run.resolved.filter((url) => !url.includes("/@opentelemetry/api/"));
    assert.deepEqual(beyondApi, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/**
 * A stand-in for whatever receives traces, over OTLP/HTTP with JSON bodies.
 *
 * @returns {Promise<{ url: string, bodies: any[], close: () => Promise<void> }>}
 */
async function traceReceiver() {
  /** @type {any[]} */
  const bodies = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.url === "/v1/traces") bodies.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    bodies,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

test("a CLI the settings file configures sends its span, parented on TRACEPARENT, and prints the same", async () => {
  const receiver = await traceReceiver();
  const home = settingsHome(`OTEL_EXPORTER_OTLP_ENDPOINT=${receiver.url}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/json\n`);
  const bare = temporaryDirectory();
  try {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentId = "00f067aa0ba902b7";
    const traced = /** @type {any} */ (await runCli(["--help"], {
      XDG_CONFIG_HOME: home,
      TRACEPARENT: `00-${traceId}-${parentId}-01`,
    }));
    const plain = /** @type {any} */ (await runCli(["--help"], { XDG_CONFIG_HOME: bare }));
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /^Usage:/);
    assert.equal(traced.status, plain.status);
    assert.equal(traced.stdout, plain.stdout);
    assert.equal(traced.stderr, plain.stderr);

    const resourceSpans = receiver.bodies.flatMap((body) => body.resourceSpans);
    const spans = resourceSpans.flatMap((each) => each.scopeSpans.flatMap((scope) => scope.spans));
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "pharo-agent help");
    assert.equal(spans[0].traceId, traceId);
    assert.equal(spans[0].parentSpanId, parentId);
    const resource = Object.fromEntries(resourceSpans[0].resource.attributes.map((each) => [each.key, each.value.stringValue]));
    assert.deepEqual(Object.keys(resource).sort(), ["os.type", "service.name", "service.version"]);
    assert.equal(resource["service.name"], "pharo-agent");
  } finally {
    await receiver.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test("a CLI whose traces have nowhere to go prints the same and exits the same", async () => {
  const receiver = await traceReceiver();
  const nowhere = receiver.url;
  await receiver.close();
  const bare = temporaryDirectory();
  try {
    const started = Date.now();
    const failing = /** @type {any} */ (await runCli(["image", "bogus"], {
      XDG_CONFIG_HOME: bare,
      OTEL_EXPORTER_OTLP_ENDPOINT: nowhere,
    }));
    const elapsed = Date.now() - started;
    const plain = /** @type {any} */ (await runCli(["image", "bogus"], { XDG_CONFIG_HOME: bare }));
    assert.match(plain.stderr, /No \.pharo-agent\/config\.json found/);
    assert.equal(failing.status, plain.status);
    assert.notEqual(failing.status, 0);
    assert.equal(failing.stdout, plain.stdout);
    assert.equal(failing.stderr, plain.stderr);
    assert.ok(elapsed < 10_000, `took ${elapsed} ms`);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

/** @param {any[]} bodies the OTLP/JSON requests a receiver got */
function sentSpans(bodies) {
  return bodies.flatMap((body) => body.resourceSpans)
    .flatMap((each) => each.scopeSpans.flatMap((scope) => scope.spans));
}

/** @param {any} span an OTLP/JSON span */
function sessionIdOf(span) {
  return span.attributes.find((each) => each.key === "session.id")?.value.stringValue;
}

test("a project's session is written only once traces are sent, and its processes share it", async () => {
  const receiver = await traceReceiver();
  const home = settingsHome(`OTEL_EXPORTER_OTLP_ENDPOINT=${receiver.url}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/json\n`);
  const bare = temporaryDirectory();
  const project = temporaryDirectory();
  const outside = temporaryDirectory();
  try {
    writeConfig(project, { scope: "proj" });
    const plain = /** @type {any} */ (await runCli(["--help"], { XDG_CONFIG_HOME: bare }, project));
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(fs.existsSync(path.join(project, ".pharo-agent", "runtime")), false);

    for (let run = 0; run < 2; run += 1) {
      const traced = /** @type {any} */ (await runCli(["--help"], { XDG_CONFIG_HOME: home }, project));
      assert.equal(traced.status, 0, traced.stderr);
    }
    const id = fs.readFileSync(sessionFile(project), "utf8").trim();
    const inProject = sentSpans(receiver.bodies);
    assert.equal(inProject.length, 2);
    assert.deepEqual(inProject.map(sessionIdOf), [id, id]);

    receiver.bodies.length = 0;
    const away = /** @type {any} */ (await runCli(["--help"], { XDG_CONFIG_HOME: home }, outside));
    assert.equal(away.status, 0, away.stderr);
    const [span] = sentSpans(receiver.bodies);
    assert.match(sessionIdOf(span), /^[0-9a-f-]{36}$/);
    assert.notEqual(sessionIdOf(span), id);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    await receiver.close();
    for (const directory of [home, bare, project, outside]) fs.rmSync(directory, { recursive: true, force: true });
  }
});
