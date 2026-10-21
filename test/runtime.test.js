import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { toolResult, withImageSelector } from "../src/gateway.js";
import {
  describeLifecycleFailure,
  needsImageCreation,
  pifsRelease,
  pifsStartCode,
  resultPrintString,
  runLifecycle,
} from "../src/live.js";
import {
  activePath,
  readOpenImages,
  selectRunningImage,
  smalltalkString,
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

test("loads the released PIFS version and requests a dynamic projection port", () => {
  const source = pifsStartCode("/project/.pharo-agent/mounts/dev", "Project-dev");
  assert.equal(pifsRelease, "v0.4.0");
  assert.match(source, /pharo-image-fs:v0\.4\.0\/src/);
  assert.match(source, /startOn: 0/);
  assert.match(source, /mountAt: '\/project\/\.pharo-agent\/mounts\/dev' asFileReference/);
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
      { imageId: "stopped", status: "stopped" },
      { imageId: "live", status: "running" },
    ],
  };

  assert.equal(needsImageCreation(listed, "fresh"), true);
  assert.equal(needsImageCreation(listed, "stopped"), false);
  assert.equal(needsImageCreation(listed, "live"), false);
  assert.throws(() => needsImageCreation(listed, "other"), /does not know image other/);
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
