import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { imageGateway, toolFailureMessage, toolResult, withImageSelector } from "../src/gateway.js";
import {
  describeLifecycleFailure,
  imageCreationPlan,
  pharoMcpWarning,
  projectionAvailability,
  projectionStartOutcome,
  releaseFuseTMount,
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

test("an image copied from a base that loaded what the project loads says nothing", () => {
  assert.equal(
    unappliedPharoMcpPin({
      id: "p14",
      pharoMcpLoad: { state: "provided", loadPolicy: "ifMissing", preparedBase: "current" },
    }),
    undefined,
  );
});

test("an image whose base the project has moved on from says it holds another Pharo MCP", () => {
  const warning = unappliedPharoMcpPin({
    id: "p14",
    pharoMcpLoad: { state: "provided", loadPolicy: "ifMissing", preparedBase: "outdated" },
  });

  assert.ok(warning);
  assert.match(warning, /^Image p14 kept the Pharo MCP it was prepared with, which is not the one this project loads now/);
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

// fuse-t's daemon outlived its image, so the plugin unmounted what it left;
// the daemons PIFS starts now unmount on their own, and their records name
// the PIFS release that started them.
test("only a projection fuse-t served is unmounted for an image that is gone", () => {
  const unmounted = [];
  const unmount = (mountPath) => unmounted.push(mountPath);

  assert.equal(releaseFuseTMount({ mountPath: "/p/.pharo-agent/mounts/old", projectionPort: 1 }, unmount), true);
  assert.equal(releaseFuseTMount({ mountPath: "/p/.pharo-agent/mounts/new", projectionPort: 2, pifsRelease }, unmount), false);
  assert.equal(releaseFuseTMount({ imageId: "bare" }, unmount), false, "an image started with no projection");
  assert.equal(releaseFuseTMount(undefined, unmount), false);
  assert.deepEqual(unmounted, ["/p/.pharo-agent/mounts/old"]);
});

test("the start code answers a failure's reason instead of failing", () => {
  const source = pifsStartCode("/p/dev", "dev");
  assert.match(source, /^\[ Metacello new/);
  assert.match(source, /\) port \]\s+on: Error\s+do: \[ :error \| error messageText asString \]$/);
});
