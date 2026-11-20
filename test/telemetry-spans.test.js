// The spans the MCP server and the CLI open, read from an in-memory exporter
// this process registers in place of OTLP's.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { main } from "../src/cli.js";
import { serveImagesMcp } from "../src/mcpServer.js";
import { writeConfig } from "../src/project.js";
import { sessionFile, sessionIds } from "../src/session.js";
import { useSessionIds } from "../src/telemetry.js";
import { installSdk } from "../src/telemetrySdk.js";
import { callsOf, runningImage, useFakePlexus } from "./support/fake-plexus.js";

const exporter = new InMemorySpanExporter();
const provider = await installSdk({
  protocol: "http/protobuf",
  exportTimeoutMillis: 2000,
  version: "0.0.0-test",
  exporter,
});

/** The spans ended since the last call. */
async function finishedSpans() {
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  exporter.reset();
  return spans;
}

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentId}-01`;

// What a span must never hold: the values a test passes and the answers it gets.
const secrets = ["SecretClass", "secret source", "the image's answer", "a pharo failure", "dev", "proj"];

/** @param {import("@opentelemetry/sdk-trace").ReadableSpan} span */
function assertNoValues(span) {
  const recorded = JSON.stringify({ name: span.name, attributes: span.attributes, status: span.status, events: span.events });
  for (const secret of secrets) {
    assert.equal(recorded.includes(JSON.stringify(secret)) || recorded.includes(`${secret} `) || recorded.includes(` ${secret}`), false, `${secret} in ${recorded}`);
  }
  assert.equal(span.status.message, undefined);
  assert.deepEqual(span.events, []);
}

const classGet = {
  name: "class_get",
  description: "Describe a class.",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
};

const images = {
  "proj-dev": runningImage(41001, {
    tools: [classGet],
    answers: [
      { tool: "class_get", contains: "Broken", result: { isError: true, content: [{ type: "text", text: "a pharo failure" }] } },
      { tool: "class_get", result: { content: [{ type: "text", text: "the image's answer" }] } },
    ],
  }),
};

/**
 * A project whose default image `dev` runs and answers class_get.
 *
 * @template T
 * @param {(root: string) => Promise<T>} body
 */
async function inProject(body) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-spans-")));
  const dropStore = useFakePlexus({ images });
  try {
    writeConfig(root, { scope: "proj", defaultImage: "dev", host: "claude" });
    return await body(root);
  } finally {
    dropStore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The server, and a client connected to it as a host would be.
 *
 * @param {string} root
 */
async function connected(root) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = await serveImagesMcp(() => root, undefined, serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  await finishedSpans();
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("a tools/call is a SERVER span, parented on the trace context in its _meta", () => inProject(async (root) => {
  const { client, close } = await connected(root);
  try {
    const result = await client.callTool({
      name: "class_get",
      arguments: { name: "SecretClass" },
      _meta: { traceparent, tracestate: "vendor=value" },
    });
    assert.equal(result.isError, undefined);
  } finally {
    await close();
  }
  const [span, ...others] = await finishedSpans();
  // Active while the call is forwarded, so what PLexus passes on is this span.
  assert.deepEqual(
    callsOf("callTool").map((call) => call.traceparent),
    [`00-${traceId}-${span.spanContext().spanId}-01`],
  );
  assert.deepEqual(others, []);
  assert.equal(span.name, "tools/call class_get");
  assert.equal(span.kind, SpanKind.SERVER);
  assert.equal(span.spanContext().traceId, traceId);
  assert.equal(span.parentSpanContext?.spanId, parentId);
  assert.equal(span.parentSpanContext?.isRemote, true);
  assert.deepEqual(span.attributes, {
    "mcp.method.name": "tools/call",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "class_get",
    "pharo_agent.argument.names": ["name"],
    "network.transport": "pipe",
    "mcp.protocol.version": LATEST_PROTOCOL_VERSION,
    "pharo_agent.client.name": "test",
    "pharo_agent.client.version": "1",
  });
  assert.equal(span.status.code, SpanStatusCode.UNSET);
  assertNoValues(span);
}));

test("a tools/call without trace context starts its own trace", () => inProject(async (root) => {
  const { client, close } = await connected(root);
  try {
    await client.callTool({ name: "class_get", arguments: { name: "SecretClass" } });
  } finally {
    await close();
  }
  const [span] = await finishedSpans();
  assert.equal(span.name, "tools/call class_get");
  assert.equal(span.parentSpanContext, undefined);
}));

test("a tool's error answer and a refused call fail their span, with a type and no description", () => inProject(async (root) => {
  const { client, close } = await connected(root);
  try {
    const answered = await client.callTool({ name: "class_get", arguments: { name: "Broken" }, _meta: { traceparent } });
    assert.equal(answered.isError, true);
    // image_create needs a name and a template: the server throws.
    const refused = await client.callTool({ name: "image_create", arguments: { template: "secret source" } })
      .then((value) => ({ value }), (error) => ({ error }));
    assert.ok("error" in refused || refused.value.isError === true);
  } finally {
    await close();
  }
  const [answered, refused] = await finishedSpans();
  assert.equal(answered.attributes["error.type"], "tool_error");
  assert.equal(answered.status.code, SpanStatusCode.ERROR);
  assertNoValues(answered);
  assert.equal(refused.name, "tools/call image_create");
  assert.deepEqual(refused.attributes["pharo_agent.argument.names"], ["template"]);
  assert.equal(refused.attributes["error.type"], "Error");
  assert.equal(refused.status.code, SpanStatusCode.ERROR);
  assertNoValues(refused);
}));

test("a tool or argument name that is not an identifier is left out", () => inProject(async (root) => {
  const { client, close } = await connected(root);
  try {
    await client.callTool({ name: "../SecretClass dev", arguments: { "secret source": 1, name: "x" } })
      .catch(() => {});
  } finally {
    await close();
  }
  const [span] = await finishedSpans();
  assert.equal(span.name, "tools/call");
  assert.equal("gen_ai.tool.name" in span.attributes, false);
  assert.deepEqual(span.attributes["pharo_agent.argument.names"], ["name"]);
  assertNoValues(span);
}));

/**
 * Runs `main` in the project with TRACEPARENT set, and gives back its exit
 * code and the spans it ended.
 *
 * @param {string} root
 * @param {string[]} args
 */
async function runTraced(root, args) {
  const previous = { cwd: process.cwd(), log: console.log, traceparent: process.env.TRACEPARENT };
  /** @type {string[]} */
  const printed = [];
  process.chdir(root);
  console.log = (text) => printed.push(String(text));
  process.env.TRACEPARENT = traceparent;
  try {
    const exitCode = await main(args);
    return { exitCode, printed, spans: await finishedSpans() };
  } finally {
    console.log = previous.log;
    process.chdir(previous.cwd);
    if (previous.traceparent === undefined) delete process.env.TRACEPARENT;
    else process.env.TRACEPARENT = previous.traceparent;
  }
}

test("a CLI tool command is a tools/call span, parented on TRACEPARENT", () => inProject(async (root) => {
  const { exitCode, printed, spans: [span, ...others] } = await runTraced(root, ["class_get", "SecretClass"]);
  assert.equal(exitCode, 0);
  assert.deepEqual(
    callsOf("callTool").map((call) => call.traceparent),
    [`00-${traceId}-${span.spanContext().spanId}-01`],
  );
  assert.deepEqual(printed, ["the image's answer"]);
  assert.deepEqual(others, []);
  assert.equal(span.name, "tools/call class_get");
  assert.equal(span.kind, SpanKind.INTERNAL);
  assert.equal(span.spanContext().traceId, traceId);
  assert.equal(span.parentSpanContext?.spanId, parentId);
  assert.deepEqual(span.attributes, {
    "mcp.method.name": "tools/call",
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "class_get",
    "pharo_agent.argument.names": ["name"],
  });
  assertNoValues(span);

  const failed = await runTraced(root, ["class_get", "Broken"]);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.spans[0].attributes["error.type"], "tool_error");
  assert.equal(failed.spans[0].status.code, SpanStatusCode.ERROR);
  assertNoValues(failed.spans[0]);
}));

test("a CLI command is a span named for it, never for words it does not know", () => inProject(async (root) => {
  const listed = await runTraced(root, ["image", "list"]);
  assert.equal(listed.spans[0].name, "pharo-agent image list");
  assert.equal(listed.spans[0].parentSpanContext?.spanId, parentId);
  assert.deepEqual(listed.spans[0].attributes, {});

  await assert.rejects(runTraced(root, ["image", "SecretClass"]));
  const [unknown] = await finishedSpans();
  assert.equal(unknown.name, "pharo-agent image");
  assert.equal(unknown.attributes["error.type"], "Error");
  assertNoValues(unknown);
}));

test("a CLI tool command refused for flags the tool lacks names them, and no value", () => inProject(async (root) => {
  await assert.rejects(
    runTraced(root, [
      "class_get", "--clas", "SecretClass", "--with-source", "--format=secret source", "--bad key", "--clas", "dev", "--name", "proj",
    ]),
    /class_get has no argument --clas/,
  );
  const [span, ...others] = await finishedSpans();
  assert.deepEqual(others, []);
  assert.deepEqual(callsOf("callTool"), []);
  assert.equal(span.name, "tools/call class_get");
  assert.deepEqual(span.attributes["pharo_agent.argument.unknown_names"], ["clas", "with-source", "format"]);
  assert.equal("pharo_agent.argument.names" in span.attributes, false);
  assert.equal(span.attributes["error.type"], "Error");
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assertNoValues(span);
}));

test("once sessions are on, the MCP server's and the CLI's spans in a project carry its session.id", () => inProject(async (root) => {
  useSessionIds(sessionIds({ projectRoot: () => root }));
  try {
    const { client, close } = await connected(root);
    try {
      await client.callTool({ name: "class_get", arguments: { name: "SecretClass" } });
    } finally {
      await close();
    }
    const [served] = await finishedSpans();
    const { spans: [ran] } = await runTraced(root, ["class_get", "SecretClass"]);
    const id = fs.readFileSync(sessionFile(root), "utf8").trim();
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(served.attributes["session.id"], id);
    assert.equal(ran.attributes["session.id"], id);
  } finally {
    useSessionIds(undefined);
  }
}));
