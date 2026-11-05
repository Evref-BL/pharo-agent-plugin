import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { imageGateway, toolFailureMessage, toolResult, withImageSelector } from "../src/gateway.js";
import {
  describeLifecycleFailure,
  fuseLibraryPath,
  imageCreationPlan,
  isMountedAt,
  pharoMcpWarning,
  releaseProjectionMount,
  projectionAvailability,
  projectionUnavailableWarning,
  fetchPifsRelease,
  pifsRelease,
  pifsSelectors,
  pifsStartCode,
  pifsStopCode,
  resultPrintString,
  runLifecycle,
} from "../src/live.js";
import { createProjectConfigFile, declareProjectImage } from "@evref-bl/plexus";
import { classSideSelectors, missingSelectors } from "../scripts/check-pifs-selectors.mjs";
import {
  runningImagesPath,
  readRunningImage,
  readRunningImages,
  imageProcessIsAlive,
  recordedImageIsRunning,
  selectRunningImage,
  smalltalkString,
  unappliedPharoMcpPin,
  writeRunningImages,
} from "../src/runtime.js";

// The gateway is built from PLexus's published API, which moves under this
// package by an automated pin bump. Calling a verb PLexus has retired fails
// here and nowhere else, because every Pharo tool call goes through it.
test("imageGateway builds a gateway over the project's route source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-gateway-"));
  const statePath = path.join(root, "state.json");
  fs.writeFileSync(statePath, JSON.stringify({
    projectId: "project",
    workspaceId: "workspace",
    images: [{
      id: "work",
      status: "running",
      pid: process.pid,
      mcpServers: [{ id: "pharo-work" }],
    }],
  }));

  const { gateway, mcpServerId, image } = imageGateway(root, {
    statePath,
    imageId: "work",
    mcpServerId: "pharo-work",
  });

  assert.equal(mcpServerId, "pharo-work");
  assert.equal(image.id, "work");
  assert.equal(typeof gateway.routeToImage, "function");
});

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

test("running images are recorded per image and read back", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-runtime-"));
  try {
    assert.deepEqual(readRunningImages(root), {});

    writeRunningImages(root, {
      dev: { imageId: "dev", mcpServerId: "pharo-dev", projectionPort: 1 },
      ci: { imageId: "ci", mcpServerId: "pharo-ci", projectionPort: 2 },
    });
    assert.deepEqual(Object.keys(readRunningImages(root)), ["dev", "ci"]);

    writeRunningImages(root, {});
    assert.deepEqual(readRunningImages(root), {});
    assert.equal(fs.existsSync(runningImagesPath(root)), false);
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

// The statuses are PLexus's own four. An earlier version of this test used
// "declared" and "failed", which PLexus has never reported, so it passed while
// every real image fell through to "none" and was launched without existing.
test("an image with no file on disk needs creating", () => {
  const listed = {
    images: [
      { imageId: "fresh", status: /** @type {const} */ ("absent") },
      { imageId: "stopped", status: /** @type {const} */ ("stopped") },
      { imageId: "starting", status: /** @type {const} */ ("starting") },
      { imageId: "live", status: /** @type {const} */ ("running") },
    ],
  };

  assert.equal(imageCreationPlan(listed, "fresh"), "create");
  assert.equal(imageCreationPlan(listed, "stopped"), "none");
  assert.equal(imageCreationPlan(listed, "starting"), "none");
  assert.equal(imageCreationPlan(listed, "live"), "none");
  assert.throws(() => imageCreationPlan(listed, "other"), /does not know image other/);
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
  const thrown = Object.assign(new Error("launch failed"), {
    result: {
      failures: [
        { imageId: "dev", message: "launch failed", action: "Inspect image info." },
      ],
    },
  });

  await assert.rejects(
    () => runLifecycle(() => Promise.reject(thrown), "PLexus could not start image dev."),
    (/** @type {Error} */ error) => {
      assert.match(error.message, /PLexus could not start image dev\./);
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
  assert.match(warning, /running without MCP tools or a source projection/);
});

test("a tool call against an image started without MCP is refused with the reason", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-nomcp-"));
  try {
    fs.mkdirSync(path.join(root, ".pharo-agent"), { recursive: true });
    // Declared the way a real project declares one, so the fixture cannot
    // describe a config PLexus would refuse to load.
    createProjectConfigFile(root, { name: "p" });
    declareProjectImage(root, {
      id: "old",
      templateName: "Pharo 10.0 - 64bit",
      loadScript: "pharo/load-mcp.st",
    });
    fs.writeFileSync(
      path.join(root, ".pharo-agent", "config.json"),
      JSON.stringify({ defaultImage: "old" }),
    );
    writeRunningImages(root, { old: { imageId: "old", mcp: false } });

    assert.throws(() => readRunningImage(root, "old"), /offers no Pharo tools/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an image that kept its own Pharo MCP says the pin was not applied", () => {
  const warning = unappliedPharoMcpPin({
    id: "p13",
    pharoMcpLoad: { state: "provided", loadPolicy: "ifMissing" },
  });

  assert.ok(warning);
  assert.match(warning, /^Image p13 started with the Pharo MCP it already had/);
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
  assert.match(message, /started with the Pharo MCP it already had/);
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

function stateFileWith(image) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-state-"));
  const statePath = path.join(root, "state.json");
  fs.writeFileSync(statePath, `${JSON.stringify({ images: [image] })}\n`);
  return statePath;
}

test("a process this machine is running is alive", () => {
  assert.equal(imageProcessIsAlive(process.pid), true);
});

test("a pid that is not a pid is not alive", () => {
  for (const pid of [undefined, null, 0, -1, "1234", 1.5]) {
    assert.equal(imageProcessIsAlive(pid), false, `${pid} should not be alive`);
  }
});

test("a process that has exited is not alive", () => {
  const exited = spawnSync(process.execPath, ["-e", ""]);

  assert.equal(exited.status, 0);
  assert.equal(imageProcessIsAlive(exited.pid), false);
});

test("an image counts as running only while its process is there", () => {
  const exited = spawnSync(process.execPath, ["-e", ""]);

  assert.equal(
    recordedImageIsRunning({ imageId: "dev", statePath: stateFileWith({ id: "dev", status: "running", pid: process.pid }) }),
    true,
  );
  assert.equal(
    recordedImageIsRunning({ imageId: "dev", statePath: stateFileWith({ id: "dev", status: "running", pid: exited.pid }) }),
    false,
  );
  assert.equal(
    recordedImageIsRunning({ imageId: "dev", statePath: stateFileWith({ id: "dev", status: "stopped", pid: process.pid }) }),
    false,
  );
  assert.equal(
    recordedImageIsRunning({ imageId: "other", statePath: stateFileWith({ id: "dev", status: "running", pid: process.pid }) }),
    false,
  );
});

test("a state file that is gone leaves no image running", () => {
  assert.equal(
    recordedImageIsRunning({ imageId: "dev", statePath: path.join(os.tmpdir(), "pharo-agent-no-such-state.json") }),
    false,
  );
});

// PIFS needs macOS and fuse-t; PLexus and the Pharo MCP need neither. Before
// this was checked, `image start` mounted unconditionally and stopped the
// image when the mount failed, so no image could start on Linux or Windows,
// or on a Mac without fuse-t.
test("a source projection is offered only where it can be mounted", () => {
  const withFuse = () => true;
  const withoutFuse = () => false;

  assert.deepEqual(
    projectionAvailability({ platform: "darwin", exists: withFuse }),
    { available: true },
  );

  const onLinux = projectionAvailability({ platform: "linux", exists: withFuse });
  assert.equal(onLinux.available, false);
  assert.ok(onLinux.reason);
  assert.match(onLinux.reason, /needs macOS and fuse-t/);
  assert.match(onLinux.reason, /linux/);

  const noFuse = projectionAvailability({ platform: "darwin", exists: withoutFuse });
  assert.equal(noFuse.available, false);
  assert.ok(noFuse.reason);
  assert.match(noFuse.reason, /brew install --cask fuse-t/);
});

test("the fuse-t library is looked for where its installer puts it", () => {
  // A .pkg installer, so /usr/local whatever Homebrew's prefix is.
  assert.equal(fuseLibraryPath, "/usr/local/lib/libfuse-t.dylib");
});

test("a missing projection says the image and its tools are still there", () => {
  const unavailable = projectionAvailability({ platform: "linux", exists: () => false });
  assert.ok(unavailable.reason);
  const warning = projectionUnavailableWarning("dev", unavailable.reason);

  assert.match(warning, /Image dev is running with its Pharo tools/);
  assert.match(warning, /no source projection/);
});

// The line fuse-t's mount prints, as `mount` lists it on macOS.
function fuseMountLine(mountPath) {
  return `fuse-t:/Project-Workspace-dev on ${mountPath} (nfs, nodev, nosuid, mounted by someone)`;
}

test("a mount is found by the path the mount table prints", () => {
  // macOS resolves a project's temporary directory through /private, and
  // prints the resolved path.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-mount-"));
  try {
    const mountPath = path.join(root, "dev");
    const printed = path.join(fs.realpathSync(root), "dev");
    const table = ["/dev/disk3s1 on / (apfs, local)", fuseMountLine(printed)].join("\n");

    assert.equal(isMountedAt(mountPath, table), true);
    assert.equal(isMountedAt(path.join(root, "de"), table), false, "a prefix is another path");
    assert.equal(isMountedAt(path.join(root, "other"), table), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a projection left mounted by an image that is gone is unmounted", () => {
  let table = fuseMountLine("/project/.pharo-agent/mounts/dev");
  const unmounted = [];
  const host = {
    mountTable: () => table,
    unmount: (mountPath) => {
      unmounted.push(mountPath);
      table = "";
    },
  };

  assert.equal(releaseProjectionMount("/project/.pharo-agent/mounts/dev", host), true);
  assert.deepEqual(unmounted, ["/project/.pharo-agent/mounts/dev"]);
});

test("a path with nothing mounted is left alone", () => {
  const host = {
    mountTable: () => fuseMountLine("/project/.pharo-agent/mounts/other"),
    unmount: () => assert.fail("nothing to unmount"),
  };

  assert.equal(releaseProjectionMount("/project/.pharo-agent/mounts/dev", host), false);
  assert.equal(releaseProjectionMount(undefined, host), false, "an image started with no projection");
});

test("a mount that will not go says where it is and how to remove it", () => {
  // The next projection cannot mount over it, so starting has to stop here.
  const host = {
    mountTable: () => fuseMountLine("/project/.pharo-agent/mounts/dev"),
    unmount: () => {},
  };

  assert.throws(
    () => releaseProjectionMount("/project/.pharo-agent/mounts/dev", host),
    /still mounted at \/project\/\.pharo-agent\/mounts\/dev.*umount "\/project\/\.pharo-agent\/mounts\/dev"/,
  );
});
