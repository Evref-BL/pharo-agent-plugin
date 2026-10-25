import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { toolFailureMessage, toolResult, withImageSelector } from "../src/gateway.js";
import {
  describeLifecycleFailure,
  imageCreationPlan,
  pharoMcpWarning,
  fetchPifsRelease,
  pifsRelease,
  pifsSelectors,
  pifsStartCode,
  pifsStopCode,
  resultPrintString,
  runLifecycle,
} from "../src/live.js";
import { classSideSelectors, missingSelectors } from "../scripts/check-pifs-selectors.mjs";
import {
  activePath,
  readOpenImage,
  readOpenImages,
  selectRunningImage,
  smalltalkString,
  unappliedPharoMcpPin,
  writeOpenImages,
} from "../src/runtime.js";

test("selectRunningImage requires one routed image", () => {
  const selected = selectRunningImage({
    images: [
      { id: "stopped", status: "stopped" },
      {
        id: "work",
        status: "running",
        mcpServers: [{ id: "pharo-work" }],
      },
    ],
  });

  assert.equal(selected.image.id, "work");
  assert.equal(selected.mcpServerId, "pharo-work");
  assert.throws(() => selectRunningImage({ images: [] }), /exactly one/);
});

test("selectRunningImage can require the configured image", () => {
  const state = {
    images: [
      { id: "other", status: "running", mcpServers: [{ id: "pharo-other" }] },
      { id: "work", status: "running", mcpServers: [{ id: "pharo-work" }] },
    ],
  };
  assert.equal(selectRunningImage(state, "work").image.id, "work");
  assert.throws(() => selectRunningImage(state), /exactly one/);
});

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

test("selectRunningImage picks the named image out of several", () => {
  const state = {
    images: [
      { id: "dev", status: "running", mcpServers: [{ id: "pharo-dev" }] },
      { id: "ci", status: "running", mcpServers: [{ id: "pharo-ci" }] },
      { id: "idle", status: "stopped" },
    ],
  };

  assert.equal(selectRunningImage(state, "ci").mcpServerId, "pharo-ci");
  assert.throws(() => selectRunningImage(state, "idle"), /0 running images with id idle/);
  assert.throws(() => selectRunningImage(state), /exactly one running image/);
});

test("open images are recorded per image and read back", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-runtime-"));
  try {
    assert.deepEqual(readOpenImages(root), {});

    writeOpenImages(root, {
      dev: { imageId: "dev", mcpServerId: "pharo-dev", projectionPort: 1 },
      ci: { imageId: "ci", mcpServerId: "pharo-ci", projectionPort: 2 },
    });
    assert.deepEqual(Object.keys(readOpenImages(root)), ["dev", "ci"]);

    writeOpenImages(root, {});
    assert.deepEqual(readOpenImages(root), {});
    assert.equal(fs.existsSync(activePath(root)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a single-image record written by an earlier release is still readable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-runtime-"));
  try {
    fs.mkdirSync(path.dirname(activePath(root)), { recursive: true });
    fs.writeFileSync(
      activePath(root),
      `${JSON.stringify({ imageId: "dev", mcpServerId: "pharo-dev", projectionPort: 7 })}\n`,
    );

    assert.deepEqual(readOpenImages(root), {
      dev: { imageId: "dev", mcpServerId: "pharo-dev", projectionPort: 7 },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the MCP tool schema takes an image selector instead of an mcpServerId", () => {
  const tool = withImageSelector(
    {
      name: "image_evaluate",
      inputSchema: {
        type: "object",
        properties: { mcpServerId: { type: "string" }, code: { type: "string" } },
        required: ["mcpServerId", "code"],
      },
    },
    "dev",
  );

  assert.equal(tool.inputSchema.properties.mcpServerId, undefined);
  assert.equal(tool.inputSchema.properties.image.type, "string");
  assert.match(tool.inputSchema.properties.image.description, /Defaults to dev/);
  assert.deepEqual(tool.inputSchema.required, ["code"]);
});

test("an image tool result that is already an MCP result is passed through", () => {
  const imageResult = { content: [{ type: "text", text: "42" }], isError: false };
  assert.equal(toolResult(imageResult), imageResult);

  const plain = toolResult({ resultPrintString: "42" });
  assert.equal(plain.content[0].type, "text");
  assert.match(plain.content[0].text, /resultPrintString/);
});

test("an image PLexus has no runtime state for needs creating", () => {
  const listed = {
    images: [
      { imageId: "fresh", status: "declared" },
      { imageId: "broken", status: "failed" },
      { imageId: "stopped", status: "stopped" },
      { imageId: "live", status: "running" },
    ],
  };

  assert.equal(imageCreationPlan(listed, "fresh"), "create");
  assert.equal(imageCreationPlan(listed, "stopped"), "none");
  assert.equal(imageCreationPlan(listed, "live"), "none");
  assert.throws(() => imageCreationPlan(listed, "other"), /does not know image other/);
});

test("a creation that failed is reset rather than stranding the image id", () => {
  // PLexus refuses to create over runtime state and refuses to launch an image
  // that was never created, so a failed image is unusable until it is reset.
  const listed = { images: [{ imageId: "broken", status: "failed" }] };

  assert.equal(imageCreationPlan(listed, "broken"), "reset");
});

test("a lifecycle failure reports the image, the remedy, and the launcher output", () => {
  const described = describeLifecycleFailure({
    imageId: "dev",
    message: "pharo-launcher-mcp tool failed: pharo_launcher_image_launch",
    diagnostic: "Profile-scoped image launch could not prepare the image.",
    action: "Inspect image info before retrying the launch.",
    launcherResult: { raw: { stderr: "  NotFound: Local image 'MyProject-dev' not found.\n" } },
  });

  assert.match(described, /^dev: pharo-launcher-mcp tool failed/);
  assert.match(described, /Profile-scoped image launch could not prepare the image\./);
  assert.match(described, /Inspect image info before retrying the launch\./);
  assert.match(described, /launcher: NotFound: Local image 'MyProject-dev' not found\./);
});

test("a lifecycle failure without extra detail still names the image", () => {
  assert.equal(
    describeLifecycleFailure({ imageId: "dev", message: "boom" }),
    "dev: boom",
  );
});

test("a thrown lifecycle error is reported with its failures", async () => {
  const thrown = Object.assign(new Error("One or more project images failed to open"), {
    result: {
      failures: [
        { imageId: "dev", message: "launch failed", action: "Inspect image info." },
      ],
    },
  });

  await assert.rejects(
    () => runLifecycle(() => Promise.reject(thrown), "PLexus could not open image dev."),
    (error) => {
      assert.match(error.message, /PLexus could not open image dev\./);
      assert.match(error.message, /dev: launch failed/);
      assert.match(error.message, /Inspect image info\./);
      return true;
    },
  );
});

test("an unrelated lifecycle error is left alone", async () => {
  const thrown = new Error("socket hang up");
  await assert.rejects(() => runLifecycle(() => Promise.reject(thrown), "fallback"), thrown);
  assert.deepEqual(await runLifecycle(() => Promise.resolve("ok"), "fallback"), "ok");
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

test("a shared clone missing the pinned release is fetched, once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-clone-"));
  const origin = path.join(root, "origin");
  const clone = path.join(root, "clone");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
  try {
    fs.mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch=main");
    git(origin, "config", "user.email", "test@example.com");
    git(origin, "config", "user.name", "test");
    fs.writeFileSync(path.join(origin, "README.md"), "x\n");
    git(origin, "add", ".");
    git(origin, "commit", "--quiet", "-m", "first");
    git(origin, "tag", "v0.1.0");

    execFileSync("git", ["clone", "--quiet", origin, clone], { stdio: "ignore" });
    // The release happens after the clone, exactly as it does in practice.
    git(origin, "tag", "v0.2.0");

    assert.equal(fetchPifsRelease(clone, "v0.1.0"), false, "already present, no fetch");
    assert.equal(fetchPifsRelease(clone, "v0.2.0"), true, "missing, so fetched");
    assert.equal(fetchPifsRelease(clone, "v0.2.0"), false, "present now, no second fetch");
    assert.equal(fetchPifsRelease(path.join(root, "absent"), "v0.2.0"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unsupported Pharo version is explained, not just counted", () => {
  const state = {
    images: [
      {
        id: "dev",
        status: "running",
        pharoMcpContract: {
          status: "unsupported",
          reason: "Pharo 11 is outside the supported Pharo MCP range (12, 13, 14, 15).",
        },
      },
    ],
  };

  assert.throws(
    () => selectRunningImage(state, "dev"),
    /needs exactly one MCP endpoint; PLexus reported 0\. Pharo 11 is outside the supported Pharo MCP range/,
  );
});

test("a supported image missing its endpoint still reports the count alone", () => {
  const state = {
    images: [
      { id: "dev", status: "running", pharoMcpContract: { status: "matching" } },
    ],
  };

  assert.throws(() => selectRunningImage(state, "dev"), /reported 0\.$/);
});

test("an image outside the MCP contract is opened without tools, and says so", () => {
  const warning = pharoMcpWarning({
    id: "old",
    pharoMcpContract: {
      status: "unsupported",
      reason: "Pharo 10 is outside the supported Pharo MCP range (12, 13, 14, 15).",
    },
  });

  assert.match(warning, /Pharo 10 is outside the supported Pharo MCP range/);
  assert.match(warning, /open without MCP tools or a source projection/);
});

test("a tool call against an image opened without MCP is refused with the reason", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-nomcp-"));
  try {
    fs.mkdirSync(path.join(root, ".pharo-agent"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "plexus.json"),
      JSON.stringify({ id: "p", name: "p", images: [{ id: "old" }] }),
    );
    fs.writeFileSync(
      path.join(root, ".pharo-agent", "config.json"),
      JSON.stringify({ defaultImage: "old" }),
    );
    writeOpenImages(root, { old: { imageId: "old", mcp: false } });

    assert.throws(() => readOpenImage(root, "old"), /offers no Pharo tools/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an image that kept its own Pharo MCP says the pin was not applied", () => {
  const warning = unappliedPharoMcpPin({
    id: "p13",
    pharoMcpLoad: { state: "provided", loadPolicy: "ifMissing" },
  });

  assert.match(warning, /^Image p13 opened with the Pharo MCP it already had/);
  assert.match(warning, /mcp\.loadPolicy to always/);
});

test("an image that loaded the pinned Pharo MCP says nothing", () => {
  assert.equal(
    unappliedPharoMcpPin({ id: "p14", pharoMcpLoad: { state: "loaded" } }),
    undefined,
  );
  assert.equal(unappliedPharoMcpPin({ id: "p14" }), undefined);
  assert.equal(unappliedPharoMcpPin(undefined), undefined);
});

test("a tool the image says it does not have names the unapplied pin", () => {
  const message = toolFailureMessage(
    "MCP error -32601: The method does not exist / is not available.",
    { id: "p13", pharoMcpLoad: { state: "provided" } },
  );

  assert.match(message, /-32601/);
  assert.match(message, /opened with the Pharo MCP it already had/);
});

test("an unrelated failure is reported as it is", () => {
  assert.equal(
    toolFailureMessage("ZeroDivide", { id: "p13", pharoMcpLoad: { state: "provided" } }),
    "ZeroDivide",
  );
  assert.equal(
    toolFailureMessage("MCP error -32601: nope.", { id: "p14", pharoMcpLoad: { state: "loaded" } }),
    "MCP error -32601: nope.",
  );
});
