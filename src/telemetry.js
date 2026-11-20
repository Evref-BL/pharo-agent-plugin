// Traces in standard OpenTelemetry, sent only where the standard OTEL_*
// settings say. This module is the library half: it uses the API alone,
// which is a no-op until an SDK is registered, so the spans it opens cost
// nothing when nothing is configured. `startTelemetry`, called by the entry
// point, is the application half: it reads the settings, and only when they
// name an exporter does it load and register the SDK, from `telemetrySdk.js`.
//
// A span carries names, never values: the tool's and the arguments' names,
// kept only when they look like identifiers, the kind of a failure, and the
// random id of the working session. No argument value, result, message,
// stack, path, image or project name.
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { hostNamed } from "./hosts.js";
import { findProjectRoot, readConfig } from "./project.js";
import { isClosed, reachabilityFile, tracesEndpoint } from "./reachability.js";
import { sessionIds } from "./session.js";

// Read here rather than from the gateway, which loads PLexus: the entry
// point starts telemetry before PLexus is loaded, so that PLexus reads the
// settings this puts in the environment.
const { version } = createRequire(import.meta.url)("../package.json");

/**
 * Where the settings live when the environment has none: agent hosts do not
 * pass OTEL_* to the processes they start, so a variable set in a shell
 * never reaches a server the host starts.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {string} [home]
 */
export function settingsFile(env = process.env, platform = process.platform, home = os.homedir()) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && paths.isAbsolute(xdg)) return paths.join(xdg, "pharo-agent", "otel.env");
  if (platform === "win32" && env.APPDATA) return paths.join(env.APPDATA, "pharo-agent", "otel.env");
  return paths.join(home, ".config", "pharo-agent", "otel.env");
}

const settingName = /^OTEL_[A-Z0-9_]+$/;

/**
 * The OTEL_* settings a file's `KEY=value` lines give. Blank lines and `#`
 * comments are skipped, as are a leading `export` and quotes around a
 * value; any other key is not ours to set, and is ignored.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseSettings(text) {
  /** @type {Record<string, string>} */
  const settings = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    if (!settingName.test(key)) continue;
    let value = line.slice(equals + 1).trim();
    const quoted = value.match(/^(["'])(.*)\1$/s);
    if (quoted) value = quoted[2];
    settings[key] = value;
  }
  return settings;
}

/**
 * Puts the settings file's OTEL_* into the environment, unless it already
 * has an OTEL_* of its own: whoever set one there meant the environment to
 * decide. Into this process's environment, so that PLexus, in this process,
 * and the Pharo VMs it starts read the same settings.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [file]
 * @returns {Record<string, string>} what it set
 */
export function applySettingsFile(env = process.env, file = settingsFile(env)) {
  if (Object.keys(env).some((key) => key.startsWith("OTEL_"))) return {};
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const settings = parseSettings(text);
  Object.assign(env, settings);
  return settings;
}

/**
 * The OTLP protocol traces are exported with, or undefined for one this
 * package does not send: gRPC.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {"http/protobuf" | "http/json" | undefined}
 */
export function exportProtocol(env) {
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL || env.OTEL_EXPORTER_OTLP_PROTOCOL || "http/protobuf")
    .trim().toLowerCase();
  return protocol === "http/protobuf" || protocol === "http/json" ? protocol : undefined;
}

/**
 * Whether the settings ask for traces to be exported over OTLP: the SDK is
 * not disabled, the traces exporter is OTLP (the default), an endpoint is
 * named, and its protocol is one this package speaks.
 *
 * @param {Record<string, string | undefined>} env
 */
export function isConfigured(env) {
  if ((env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase() === "true") return false;
  const exporters = (env.OTEL_TRACES_EXPORTER ?? "").split(",")
    .map((each) => each.trim().toLowerCase()).filter(Boolean);
  if (exporters.length > 0 && !exporters.includes("otlp")) return false;
  if (!env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim() && !env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()) return false;
  return exportProtocol(env) !== undefined;
}

/** How long one export may take unless the settings say: a tool must not wait on it. */
export const defaultExportTimeoutMs = 2_000;

/** The longest a process waits for its last spans as it ends. */
export const exitFlushBoundMs = 1_000;

/**
 * The export timeout the settings give, or undefined when they give none.
 *
 * @param {Record<string, string | undefined>} env
 */
export function configuredExportTimeout(env) {
  for (const key of ["OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "OTEL_EXPORTER_OTLP_TIMEOUT"]) {
    const value = Number(env[key]?.trim() || Number.NaN);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** The host the project was set up for, when its config says one this package knows. */
function projectAgentHost() {
  try {
    const { host } = readConfig(findProjectRoot());
    return typeof host === "string" && hostNamed(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

/** The project a command or a call works in, or undefined outside one. */
function projectRootOrNone() {
  try {
    return findProjectRoot();
  } catch {
    return undefined;
  }
}

/** @type {(() => string) | undefined} */
let sessionId;

/**
 * Where the spans opened from now on take their `session.id`, or nothing to
 * leave it out. Set once the SDK is registered, so a process that sends no
 * traces never reads or writes the session file.
 *
 * @param {(() => string) | undefined} ids
 */
export function useSessionIds(ids) {
  sessionId = ids;
}

/** @returns {Record<string, string>} */
function sessionAttributes() {
  if (!sessionId) return {};
  try {
    return { "session.id": sessionId() };
  } catch {
    return {};
  }
}

/** @type {{ shutdown: () => Promise<void> } | undefined} */
let installed;
let flushBound = exitFlushBoundMs;

/**
 * Reads the settings and, when they name an exporter, enrolls the images
 * PLexus handles and registers the SDK. Never throws: telemetry that cannot
 * start leaves the tools as they were.
 *
 * While the last exports found the collector unreachable, it loads nothing
 * and sends nothing, until the time to try again.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   agentHost?: () => string | undefined,
 *   loadSdk?: () => Promise<typeof import("./telemetrySdk.js")>,
 *   reachability?: string,
 *   now?: () => number,
 * }} [options] `reachability` is the file that says which collectors were unreachable
 * @returns {Promise<boolean>} whether the SDK was registered
 */
export async function startTelemetry(options = {}) {
  const {
    env = process.env,
    agentHost = projectAgentHost,
    loadSdk = () => import("./telemetrySdk.js"),
    reachability = reachabilityFile(env),
    now = Date.now,
  } = options;
  try {
    applySettingsFile(env);
    if (installed || !isConfigured(env)) return false;
    // PLexus reads this as the default of its telemetry option: the images
    // it makes and starts send their traces where these do.
    if (env.PLEXUS_TELEMETRY === undefined) env.PLEXUS_TELEMETRY = "1";
    const endpoint = tracesEndpoint(env);
    if (!endpoint || isClosed(reachability, endpoint, now())) return false;
    const sdk = await loadSdk();
    const timeout = configuredExportTimeout(env);
    flushBound = Math.min(timeout ?? exitFlushBoundMs, exitFlushBoundMs);
    const host = agentHost();
    installed = await sdk.installSdk({
      protocol: exportProtocol(env) ?? "http/protobuf",
      timeoutMillis: timeout === undefined ? defaultExportTimeoutMs : undefined,
      exportTimeoutMillis: timeout ?? defaultExportTimeoutMs,
      version,
      reachability: { file: reachability, endpoint, now },
      ...(host ? { agentHost: host } : {}),
    });
    useSessionIds(sessionIds({ projectRoot: projectRootOrNone, now }));
    // Once the process has nothing left to do: the end of a command, or a
    // server whose host closed its input. A process killed outright loses
    // what it had not sent, which is better than a process that will not die.
    process.once("beforeExit", () => { shutdownTelemetry(); });
    return true;
  } catch {
    return false;
  }
}

/** Sends what is left, within a second at most, and never throws. */
export async function shutdownTelemetry() {
  const provider = installed;
  installed = undefined;
  useSessionIds(undefined);
  if (!provider) return;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    await Promise.race([
      provider.shutdown(),
      new Promise((resolve) => { timer = setTimeout(resolve, flushBound); timer.unref(); }),
    ]);
  } catch {
    // Nothing a caller can do about a span that was not sent.
  } finally {
    clearTimeout(timer);
  }
}

const identifier = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

/**
 * A name as a span may carry it: one that looks like an identifier, or
 * nothing. A tool or argument name is the caller's to choose, and a caller
 * may put anything there.
 *
 * @param {unknown} name
 */
export function safeName(name) {
  return typeof name === "string" && identifier.test(name) ? name : undefined;
}

/**
 * The names of the arguments a call gives, each kept only when it looks
 * like an identifier. Never their values.
 *
 * @param {unknown} argumentsValue
 * @returns {string[]}
 */
export function argumentNames(argumentsValue) {
  if (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return [];
  return Object.keys(argumentsValue).filter((name) => safeName(name) !== undefined);
}

/**
 * The attributes of a tool call, after the GenAI MCP conventions.
 *
 * @param {unknown} tool
 * @param {unknown} [argumentsValue]
 */
function toolAttributes(tool, argumentsValue) {
  const name = safeName(tool);
  const names = argumentNames(argumentsValue);
  return {
    "mcp.method.name": "tools/call",
    "gen_ai.operation.name": "execute_tool",
    ...(name ? { "gen_ai.tool.name": name } : {}),
    ...(names.length > 0 ? { "pharo_agent.argument.names": names } : {}),
  };
}

/** @param {unknown} tool */
function toolSpanName(tool) {
  const name = safeName(tool);
  return name ? `tools/call ${name}` : "tools/call";
}

/**
 * What kind of failure an exception is: the JSON-RPC code of a protocol
 * error, or the error's class name, never its message.
 *
 * @param {any} error
 */
export function errorType(error) {
  if (Number.isInteger(error?.code)) return String(error.code);
  return safeName(error?.name) ?? "_OTHER";
}

/** @param {any} result */
function toolResultFailure(result) {
  return result?.isError === true ? "tool_error" : undefined;
}

/**
 * The W3C context a carrier holds: only these keys are read, and only
 * strings, so nothing else in it reaches the propagator.
 *
 * @param {Record<string, unknown> | undefined} carrier
 * @param {Record<string, string>} keys propagator key by carrier key
 */
function parentFrom(carrier, keys) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const [from, to] of Object.entries(keys)) {
    const value = carrier?.[from];
    if (typeof value === "string" && value !== "") fields[to] = value;
  }
  return propagation.extract(ROOT_CONTEXT, fields);
}

/**
 * @param {import("@opentelemetry/api").Span} span
 * @param {string} type
 */
function fail(span, type) {
  // No description: the conventions would put the error's message there,
  // which is a value.
  span.setAttribute("error.type", type);
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/**
 * Runs `run` inside a span that is active while it runs, so the spans of
 * what it calls nest under it. A span that cannot be opened leaves `run` to
 * run alone: telemetry never decides an answer.
 *
 * @template T
 * @param {string} name
 * @param {import("@opentelemetry/api").SpanOptions} options
 * @param {import("@opentelemetry/api").Context} parent
 * @param {() => Promise<T>} run
 * @param {(result: T) => string | undefined} failure
 * @returns {Promise<T>}
 */
async function inSpan(name, options, parent, run, failure) {
  let span;
  try {
    const attributes = { ...options.attributes, ...sessionAttributes() };
    span = trace.getTracer("pharo-agent", version).startSpan(name, { ...options, attributes }, parent);
  } catch {
    return run();
  }
  try {
    const result = await context.with(trace.setSpan(parent, span), run);
    const type = failure(result);
    if (type) fail(span, type);
    return result;
  } catch (error) {
    fail(span, errorType(error));
    throw error;
  } finally {
    span.end();
  }
}

// MCP names its protocol versions by date.
const protocolVersionPattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A tools/call this package's MCP server answers: a SERVER span, its parent
 * the trace context the request's `_meta` carries (SEP-414), if any.
 *
 * @template T
 * @param {{
 *   tool: unknown,
 *   argumentsValue?: unknown,
 *   meta?: Record<string, unknown>,
 *   protocolVersion?: string,
 * }} call
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export function serveToolCall({ tool, argumentsValue, meta, protocolVersion }, run) {
  const parent = parentFrom(meta, { traceparent: "traceparent", tracestate: "tracestate", baggage: "baggage" });
  const attributes = {
    ...toolAttributes(tool, argumentsValue),
    "network.transport": "pipe",
    ...(typeof protocolVersion === "string" && protocolVersionPattern.test(protocolVersion)
      ? { "mcp.protocol.version": protocolVersion } : {}),
  };
  return inSpan(
    toolSpanName(tool),
    { kind: SpanKind.SERVER, attributes },
    parent,
    run,
    /** @type {(result: T) => string | undefined} */ (toolResultFailure),
  );
}

/**
 * One CLI invocation: an INTERNAL span, its parent the context the
 * environment carries (TRACEPARENT, TRACESTATE, BAGGAGE), if any. A tool
 * command is named and described as the tool call it is, and fails as one
 * when it exits non-zero.
 *
 * @template T
 * @param {{ command?: string, tool?: string }} invocation
 * @param {() => Promise<T>} run
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<T>}
 */
export function runCommand(invocation, run, env = process.env) {
  const parent = parentFrom(env, { TRACEPARENT: "traceparent", TRACESTATE: "tracestate", BAGGAGE: "baggage" });
  if (invocation.tool !== undefined) {
    return inSpan(
      toolSpanName(invocation.tool),
      { kind: SpanKind.INTERNAL, attributes: toolAttributes(invocation.tool) },
      parent,
      run,
      (exitCode) => (exitCode ? "tool_error" : undefined),
    );
  }
  const name = invocation.command ? `pharo-agent ${invocation.command}` : "pharo-agent";
  return inSpan(name, { kind: SpanKind.INTERNAL }, parent, run, () => undefined);
}

/**
 * Adds the names of the arguments a call was given to the span running it,
 * once they are known.
 *
 * @param {unknown} argumentsValue
 */
export function recordArgumentNames(argumentsValue) {
  const names = argumentNames(argumentsValue);
  if (names.length > 0) trace.getActiveSpan()?.setAttribute("pharo_agent.argument.names", names);
}

/**
 * Adds to the span running a call the names of the flags it was refused
 * for, which the tool does not declare: the image never sees that call, so
 * only this span can say what the caller expected. Each name once, and only
 * when it looks like an identifier.
 *
 * @param {string[]} names
 */
export function recordUnknownArgumentNames(names) {
  const kept = [...new Set(names.filter((name) => safeName(name) !== undefined))];
  if (kept.length > 0) trace.getActiveSpan()?.setAttribute("pharo_agent.argument.unknown_names", kept);
}
