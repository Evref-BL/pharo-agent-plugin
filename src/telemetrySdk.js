// The OpenTelemetry SDK, loaded only once the settings ask for an exporter:
// `telemetry.js` imports this module then and not before, so a process with
// nothing configured loads none of it.
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { guardedExporter } from "./reachability.js";

/**
 * The OS family, as the conventions spell `os.type`.
 *
 * @param {NodeJS.Platform} [platform]
 */
export function osType(platform = process.platform) {
  if (platform === "win32") return "windows";
  if (platform === "sunos") return "solaris";
  return platform;
}

/**
 * What every span of this process is from: this package, its version, the OS
 * family, Node's version, the host the project was set up for, and
 * OTEL_RESOURCE_ATTRIBUTES, which can add to these but not replace them.
 * None of the default detectors, which add the hostname, the command line
 * and the executable's path.
 *
 * @param {{ version: string, agentHost?: string, platform?: NodeJS.Platform }} options
 */
export function telemetryResource({ version, agentHost, platform }) {
  return detectResources({ detectors: [envDetector] }).merge(resourceFromAttributes({
    "service.name": "pharo-agent",
    "service.version": version,
    "os.type": osType(platform),
    "process.runtime.name": "nodejs",
    "process.runtime.version": process.versions.node,
    ...(agentHost ? { "pharo_agent.agent_host": agentHost } : {}),
  }));
}

/**
 * The OTLP exporter for the protocol, which reads its endpoint, headers and
 * compression from the OTEL_* settings; `timeoutMillis`, when given, stands
 * for a timeout the settings do not name.
 *
 * @param {"http/protobuf" | "http/json"} protocol
 * @param {number} [timeoutMillis]
 * @returns {Promise<import("@opentelemetry/sdk-trace").SpanExporter>}
 */
async function otlpExporter(protocol, timeoutMillis) {
  const { OTLPTraceExporter } = protocol === "http/json"
    ? await import("@opentelemetry/exporter-trace-otlp-http")
    : await import("@opentelemetry/exporter-trace-otlp-proto");
  return new OTLPTraceExporter(timeoutMillis === undefined ? {} : { timeoutMillis });
}

/**
 * Registers a tracer provider exporting in batches, the W3C trace-context
 * and baggage propagators, and a context manager that follows async calls.
 *
 * @param {{
 *   protocol: "http/protobuf" | "http/json",
 *   timeoutMillis?: number,
 *   exportTimeoutMillis: number,
 *   version: string,
 *   agentHost?: string,
 *   reachability?: { file: string, endpoint: string, now?: () => number },
 *   exporter?: import("@opentelemetry/sdk-trace").SpanExporter,
 * }} options `reachability` records how each export went, and stops trying
 *   an endpoint that failed until it may be tried again; `exporter` in place
 *   of OTLP's, for a test
 */
export async function installSdk({ protocol, timeoutMillis, exportTimeoutMillis, version, agentHost, reachability, exporter }) {
  const sender = exporter ?? await otlpExporter(protocol, timeoutMillis);
  const provider = new TracerProvider({
    resource: telemetryResource({ version, agentHost }),
    spanProcessors: [
      new BatchSpanProcessor({ exporter: reachability ? guardedExporter(sender, reachability) : sender, exportTimeoutMillis }),
    ],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  }));
  trace.setGlobalTracerProvider(provider);
  return provider;
}
