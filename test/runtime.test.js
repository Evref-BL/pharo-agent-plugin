import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { toolFailureMessage, toolResult, withImageSelector } from "../src/gateway.js";
import {
  projectionAvailability,
  projectionStartOutcome,
  projectionUnavailableWarning,
  pifsRelease,
  pifsSelectors,
  pifsStartCode,
  pifsStopCode,
  resultPrintString,
} from "../src/live.js";
import { classSideSelectors, missingSelectors } from "../scripts/check-pifs-selectors.mjs";
import {
  forgetProjection,
  liveProjection,
  projectionPath,
  readProjection,
  recordProjection,
  smalltalkString,
} from "../src/runtime.js";

test("escapes project-controlled values for PIFS evaluation", () => {
  assert.equal(smalltalkString("O'Reilly"), "'O''Reilly'");
});

test("reads the MCP evaluation preview through its result envelope", () => {
  assert.equal(
    resultPrintString({ content: [{ data: { resultPrintString: "9013" } }] }),
    "9013",
  );
});

test("loads the released PIFS version and lets the image allocate the port", () => {
  const source = pifsStartCode("/project/.pharo-agent/mounts/dev", "Project-dev");
  // Follow the pin rather than repeating it, so an automated bump stays green.
  assert.match(pifsRelease, /^v\d+\.\d+\.\d+$/);
  assert.ok(source.includes(`pharo-image-fs:${pifsRelease}/src`));
  // The baseline load runs after this code compiles, so the class cannot be named directly.
  assert.match(source, /\(Smalltalk globals at: #PIFSServer\)/);
  assert.doesNotMatch(source, /^\(PIFSServer/m);
  assert.match(source, /startMountedAt: '\/project\/\.pharo-agent\/mounts\/dev' asFileReference/);
  assert.match(source, /named: 'Project-dev'/);
});

test("the declared PIFS selectors are the ones the generated sources send", () => {
  const sources = [pifsStartCode("/mounts/dev", "dev"), pifsStopCode(9013)].join("\n");
  for (const selector of pifsSelectors) {
    for (const keyword of selector.match(/[A-Za-z0-9_]+:/g) ?? [selector]) {
      assert.ok(
        sources.includes(keyword),
        `${selector} is declared but ${keyword} is never sent`,
      );
    }
  }
});

test("a removed selector is reported against a released PIFSServer", () => {
  const released = [
    "PIFSServer class >> start [",
    "PIFSServer class >> startMountedAt: aPath named: aString [",
    "PIFSServer class >> stopOn: portNumber [",
  ].join("\n");
  assert.deepEqual(missingSelectors(released), []);
  assert.deepEqual(missingSelectors(released, ["startOn:mountAt:named:"]), [
    "startOn:mountAt:named:",
  ]);
  assert.deepEqual(
    [...classSideSelectors(released)].sort(),
    ["start", "startMountedAt:named:", "stopOn:"],
  );
});

const evaluate = {
  name: "image_evaluate",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
  },
};

test("an image tool's schema gains the image selector, and keeps the rest", () => {
  const tool = withImageSelector(evaluate, ["dev", "p13"], "dev");

  assert.equal(tool.inputSchema.properties.image.type, "string");
  assert.equal(
    tool.inputSchema.properties.image.description,
    "Image to call, one of dev, p13. A call that names none goes to dev, the default image.",
  );
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["code", "image"]);
  assert.deepEqual(tool.inputSchema.required, ["code"]);
});

test("the image selector is required where the default image does not list the tool", () => {
  const unlisted = withImageSelector(evaluate, ["p13"], "dev");
  const stopped = withImageSelector(evaluate, ["p13"], "dev", "is not running");
  const none = withImageSelector(evaluate, ["p13"], undefined);

  assert.equal(unlisted.inputSchema.properties.image.description, "Image to call, one of p13. The default image, dev, does not list this tool.");
  assert.deepEqual(unlisted.inputSchema.required, ["code", "image"]);
  assert.equal(stopped.inputSchema.properties.image.description, "Image to call, one of p13. The default image, dev, is not running.");
  assert.deepEqual(stopped.inputSchema.required, ["code", "image"]);
  assert.equal(none.inputSchema.properties.image.description, "Image to call, one of p13.");
  assert.deepEqual(none.inputSchema.required, ["code", "image"]);
  assert.deepEqual(evaluate.inputSchema.required, ["code"], "the image's own schema is left as it was");
});

// One file per image: two sessions starting different images each write
// their own, and neither can lose the other's record.
test("projections are recorded one file per image, and forgotten one by one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-runtime-"));
  try {
    const dev = { mountPath: "/m/dev", projectionPort: 1, pifsRelease, pids: [11] };
    assert.equal(readProjection(root, "dev"), undefined);

    recordProjection(root, "dev", dev);
    recordProjection(root, "ci", { mountPath: "/m/ci", projectionPort: 2, pifsRelease, pids: [12] });
    assert.deepEqual(readProjection(root, "dev"), dev);
    assert.notEqual(projectionPath(root, "dev"), projectionPath(root, "ci"));
    assert.deepEqual(fs.readdirSync(path.dirname(projectionPath(root, "dev"))).sort(), ["ci.json", "dev.json"]);

    forgetProjection(root, "dev");
    forgetProjection(root, "absent");
    assert.equal(readProjection(root, "dev"), undefined);
    assert.equal(readProjection(root, "ci")?.mountPath, "/m/ci");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a record that is not one this package writes reads as none", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-runtime-"));
  try {
    recordProjection(root, "dev", { mountPath: "/m/dev", projectionPort: 1, pifsRelease, pids: [11] });
    for (const content of ["", "{", "[]", '{"mountPath":"/m/dev","projectionPort":1,"pifsRelease":"v1"}']) {
      fs.writeFileSync(projectionPath(root, "dev"), content);
      assert.equal(readProjection(root, "dev"), undefined, content);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a record holds only while a VM it was made with runs the image", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-runtime-"));
  try {
    const dev = { mountPath: "/m/dev", projectionPort: 1, pifsRelease, pids: [11] };
    recordProjection(root, "dev", dev);
    assert.deepEqual(liveProjection(root, { name: "dev", pids: [11] }), dev);
    assert.equal(liveProjection(root, { name: "dev", pids: [] }), undefined);
    assert.equal(liveProjection(root, { name: "dev", pids: [12] }), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a tool the image says it does not have names an image made with another pin", () => {
  const old = { name: "p13", mcp: /** @type {const} */ ({ source: "pin", version: "0.0.1" }) };
  const message = toolFailureMessage("MCP error -32601: The method does not exist / is not available.", old);

  assert.match(message, /-32601/);
  assert.match(message, /Image p13 holds Pharo MCP 0\.0\.1/);
  assert.equal(toolFailureMessage("ZeroDivide", old), "ZeroDivide");
  assert.equal(toolFailureMessage("MCP error -32601: nope.", undefined), "MCP error -32601: nope.");
});

test("an image tool result that is already an MCP result is passed through", () => {
  const imageResult = { content: [{ type: "text", text: "42" }], isError: false };
  assert.equal(toolResult(imageResult), imageResult);

  const plain = toolResult({ resultPrintString: "42" });
  assert.equal(plain.content[0].type, "text");
  assert.match(plain.content[0].text, /resultPrintString/);
});

test("reads the evaluation result out of an MCP text content part", () => {
  const envelope = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "ok",
          data: { resultPrintString: "60974", resultClassName: "SmallInteger" },
        }),
      },
    ],
  };

  assert.equal(resultPrintString(envelope), "60974");
  assert.equal(resultPrintString({ content: [] }), undefined);
});

test("reads the evaluation result out of a content-only text part", () => {
  // Every MCP server defaults to content-only responses, where the text part
  // holds the print string itself rather than an envelope naming it.
  assert.equal(resultPrintString({ content: [{ type: "text", text: "60341" }] }), "60341");
  assert.equal(resultPrintString({ content: [{ type: "text", text: " 60341 " }] }), "60341");
  assert.equal(resultPrintString({ content: [{ type: "text", text: "nil" }] }), "nil");
});

// Whether a machine can mount is the daemon's to say, and a failed mount keeps
// the image, so the plugin asks wherever PIFS releases a daemon. Before, it
// required macOS and fuse-t, which the NFS daemon no longer needs, and shut
// Linux out.
test("a source projection is asked for wherever PIFS has a daemon", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(projectionAvailability({ env: {}, platform }), { available: true }, platform);
  }

  const onWindows = projectionAvailability({ env: {}, platform: "win32" });
  assert.equal(onWindows.available, false);
  assert.ok(onWindows.reason);
  assert.match(onWindows.reason, /macOS and Linux/);
  assert.match(onWindows.reason, /win32/);
});

// A machine that could mount may still be one that must not, such as a
// developer's Mac running an eval harness's agents. The variable answers
// before the platform is asked.
test("PHARO_AGENT_PROJECTION=off turns the projection off where it could be mounted", () => {
  const off = projectionAvailability({ env: { PHARO_AGENT_PROJECTION: "off" }, platform: "darwin" });
  assert.equal(off.available, false);
  assert.ok(off.reason);
  assert.match(off.reason, /PHARO_AGENT_PROJECTION=off/);

  const offOnLinux = projectionAvailability({ env: { PHARO_AGENT_PROJECTION: "off" }, platform: "linux" });
  assert.equal(offOnLinux.reason, off.reason);
});

// An opt-out that ignored a value it does not take would mount on the very
// machine that asked not to be mounted on.
test("a PHARO_AGENT_PROJECTION other than off turns the projection off too, and says why", () => {
  for (const value of ["0", "false", "OFF", "on"]) {
    const answer = projectionAvailability({ env: { PHARO_AGENT_PROJECTION: value }, platform: "darwin" });
    assert.equal(answer.available, false, value);
    assert.ok(answer.reason);
    assert.match(answer.reason, /PHARO_AGENT_PROJECTION takes only off/);
    assert.ok(answer.reason.includes(JSON.stringify(value)), answer.reason);
  }
});

test("an unset or empty PHARO_AGENT_PROJECTION leaves the platform to decide", () => {
  for (const env of [{}, { PHARO_AGENT_PROJECTION: "" }]) {
    assert.deepEqual(projectionAvailability({ env, platform: "darwin" }), { available: true });
  }
});

test("a missing projection says the image and its tools are still there", () => {
  const unavailable = projectionAvailability({ env: {}, platform: "win32" });
  assert.ok(unavailable.reason);
  const warning = projectionUnavailableWarning("dev", unavailable.reason);

  assert.match(warning, /Image dev is running with its Pharo tools/);
  assert.match(warning, /no source projection/);
});

// A mount that fails is not an evaluation that fails: the start code answers
// PIFS's reason as a string, after PIFS stopped what it had started, and the
// image keeps running with that reason as its warning. An answer that is
// neither says nothing of what PIFS did, so the image is stopped instead.
test("a projection start answers its port, why it has none, or nothing readable", () => {
  assert.deepEqual(projectionStartOutcome("60341"), { port: 60341 });

  const optOut = " Set PHARO_AGENT_PROJECTION=off to start images without trying to mount.";
  const missingFuse = "'pharo-image-fs daemon exited before mounting /p/dev. The daemon logged: FUSE needs fusermount3, which the fuse3 package installs'";
  assert.deepEqual(projectionStartOutcome(missingFuse), {
    reason: "pharo-image-fs daemon exited before mounting /p/dev. The daemon logged: FUSE needs fusermount3, which the fuse3 package installs." + optOut,
  });
  assert.deepEqual(projectionStartOutcome("'can''t mount.'"), { reason: "can't mount." + optOut });
  // A long answer is cut short of its closing quote.
  assert.deepEqual(projectionStartOutcome("'cut short...'"), { reason: "cut short..." + optOut });
  assert.deepEqual(projectionStartOutcome("'cut short..."), { reason: "cut short..." + optOut });

  for (const neither of [undefined, "", "nil", "0", "-1", "3.5", "a Dictionary()"]) {
    assert.equal(projectionStartOutcome(neither), undefined, String(neither));
  }
});

// MCP's text puts the value first, then a line per warning, the Transcript,
// and a mark when the value was cut short; a Monticello load warns as often
// as not.
test("a projection start reads its value, not what MCP appends after it", () => {
  const optOut = " Set PHARO_AGENT_PROJECTION=off to start images without trying to mount.";
  assert.deepEqual(projectionStartOutcome("60341\nWarning: Package PharoImageFS depends on Foo"), { port: 60341 });
  assert.deepEqual(
    projectionStartOutcome("'key #PIFSServer not found'\nWarning: Package PharoImageFS depends on Foo\nTranscript:\nloading"),
    { reason: "key #PIFSServer not found." + optOut },
  );
  assert.deepEqual(
    projectionStartOutcome("'it''s cut short...\n[truncated]\nWarning: later"),
    { reason: "it's cut short..." + optOut },
  );
});

test("the start code answers a failure's reason instead of failing", () => {
  const source = pifsStartCode("/p/dev", "dev");
  assert.match(source, /^\[ Metacello new/);
  assert.match(source, /\) port \]\s+on: Error\s+do: \[ :error \| error messageText asString \]$/);
});
