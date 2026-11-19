// Whether the collector the settings name can be reached, as the last
// exports found it. An export that fails closes the way to that endpoint for
// a while, longer at each failure, and one that succeeds opens it again; while
// it is closed, a process loads no SDK and sends nothing, so a collector that
// is down costs a command nothing. Nothing here throws or prints: telemetry
// that cannot be sent is dropped.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The first wait after a failure; each further failure doubles it. */
export const firstRetryDelayMs = 5 * 60_000;
/** The longest wait. */
export const longestRetryDelayMs = 6 * 60 * 60_000;

/** OTLP's export result codes, as `@opentelemetry/core` numbers them. */
const succeeded = 0;
const failed = 1;

/**
 * Where the reachability of each endpoint is kept: the user's cache, since it
 * is worth nothing once lost.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {string} [home]
 */
export function reachabilityFile(env = process.env, platform = process.platform, home = os.homedir()) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const xdg = env.XDG_CACHE_HOME;
  if (xdg && paths.isAbsolute(xdg)) return paths.join(xdg, "pharo-agent", "otel-reachability.json");
  if (platform === "win32" && env.LOCALAPPDATA) return paths.join(env.LOCALAPPDATA, "pharo-agent", "otel-reachability.json");
  return paths.join(home, ".cache", "pharo-agent", "otel-reachability.json");
}

/**
 * The URL traces are sent to, as the OTLP exporter resolves it from the
 * settings, or undefined when they name none.
 *
 * @param {Record<string, string | undefined>} env
 */
export function tracesEndpoint(env) {
  const signal = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (signal) return signal;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? `${base.replace(/\/+$/, "")}/v1/traces` : undefined;
}

/** How long to wait before trying again after this many failures in a row. */
export function retryDelay(failures) {
  return Math.min(firstRetryDelayMs * 2 ** Math.max(failures - 1, 0), longestRetryDelayMs);
}

/**
 * @typedef {{ failures: number, retryAt: number }} Unreachable
 * @param {string} file
 * @returns {Record<string, Unreachable>}
 */
function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

/**
 * Written under another name and renamed, so a process reading it never sees
 * half of what another wrote.
 *
 * @param {string} file
 * @param {Record<string, Unreachable>} state
 */
function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, file);
  } catch {
    // A cache that cannot be written only means the next process tries again.
  }
}

/**
 * When the endpoint may be tried again, or undefined when nothing says it is
 * unreachable.
 *
 * @param {string} file
 * @param {string} endpoint
 */
export function retryAt(file, endpoint) {
  const entry = readState(file)[endpoint];
  return Number.isFinite(entry?.retryAt) ? entry.retryAt : undefined;
}

/**
 * Whether the endpoint is closed at `now`.
 *
 * @param {string} file
 * @param {string} endpoint
 * @param {number} [now]
 */
export function isClosed(file, endpoint, now = Date.now()) {
  const at = retryAt(file, endpoint);
  return at !== undefined && at > now;
}

/**
 * Closes the endpoint for longer than the last time, and answers until when.
 *
 * @param {string} file
 * @param {string} endpoint
 * @param {number} [now]
 */
export function recordFailure(file, endpoint, now = Date.now()) {
  const state = readState(file);
  const failures = (Number.isFinite(state[endpoint]?.failures) ? state[endpoint].failures : 0) + 1;
  const at = now + retryDelay(failures);
  state[endpoint] = { failures, retryAt: at };
  writeState(file, state);
  return at;
}

/**
 * Opens the endpoint again, writing only when something had closed it.
 *
 * @param {string} file
 * @param {string} endpoint
 */
export function recordSuccess(file, endpoint) {
  const state = readState(file);
  if (!(endpoint in state)) return;
  delete state[endpoint];
  writeState(file, state);
}

/**
 * An exporter that records how each export went, and while the endpoint is
 * closed answers failure at once instead of trying it: a long-lived process
 * stops sending to a collector that is down until it may try again.
 *
 * @param {import("@opentelemetry/sdk-trace").SpanExporter} exporter
 * @param {{ file: string, endpoint: string, now?: () => number }} options
 * @returns {import("@opentelemetry/sdk-trace").SpanExporter}
 */
export function guardedExporter(exporter, { file, endpoint, now = Date.now }) {
  let closedUntil = retryAt(file, endpoint) ?? 0;
  return {
    export(spans, done) {
      if (closedUntil > now()) {
        done({ code: failed });
        return;
      }
      try {
        exporter.export(spans, (result) => {
          if (result.code === succeeded) {
            if (closedUntil) recordSuccess(file, endpoint);
            closedUntil = 0;
          } else {
            closedUntil = recordFailure(file, endpoint, now());
          }
          done(result);
        });
      } catch (error) {
        closedUntil = recordFailure(file, endpoint, now());
        done({ code: failed, error: /** @type {Error} */ (error) });
      }
    },
    shutdown: () => exporter.shutdown(),
    ...(exporter.forceFlush ? { forceFlush: () => /** @type {any} */ (exporter).forceFlush() } : {}),
  };
}
