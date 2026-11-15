import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { imageToolAnswers } from "@evref-bl/plexus";
import { startAnswer, stopAnswer } from "../src/answers.js";
import { callImageTool, imageTarget } from "../src/gateway.js";
import { pifsRelease, pifsStartSeconds, startAgentImage, stopAgentImage } from "../src/live.js";
import { writeConfig } from "../src/project.js";
import { projectionPath, readProjection, recordProjection } from "../src/runtime.js";
import {
  callsOf,
  defaultPharoMcpVersion,
  pinnedImage,
  readWorld,
  runningImage,
  useFakePlexus,
} from "./support/fake-plexus.js";

// Where PIFS has no daemon, every start goes without a projection, and the
// tests that mount have nothing to show.
const mounts = { skip: !["darwin", "linux"].includes(process.platform) && "PIFS mounts on macOS and Linux only" };

const projectionPort = { tool: "image_evaluate", contains: "startMountedAt:", result: { content: [{ type: "text", text: "60341" }] } };

/**
 * What `run` writes on stderr through console.error, which reaches a host's
 * log and not the answer.
 *
 * @param {() => Promise<void>} run
 */
async function logged(run) {
  const error = console.error;
  /** @type {string[]} */
  const lines = [];
  console.error = (text) => { lines.push(String(text)); };
  try {
    await run();
  } finally {
    console.error = error;
  }
  return lines;
}

/**
 * A project, a fake PLexus store and a projection setting, all put back
 * afterwards.
 *
 * @param {(root: string) => Promise<void>} run
 * @param {Parameters<typeof useFakePlexus>[0]} [world]
 * @param {{ config?: Record<string, unknown>, projection?: string }} [options]
 */
async function inProject(run, world = {}, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-live-"));
  const dropStore = useFakePlexus(world);
  const previous = process.env.PHARO_AGENT_PROJECTION;
  if (options.projection === undefined) delete process.env.PHARO_AGENT_PROJECTION;
  else process.env.PHARO_AGENT_PROJECTION = options.projection;
  try {
    writeConfig(root, { scope: "proj", mountRoot: ".pharo-agent/mounts", ...options.config });
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.PHARO_AGENT_PROJECTION;
    else process.env.PHARO_AGENT_PROJECTION = previous;
    dropStore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a start mounts the image's source and records the projection", mounts, async () => {
  await inProject(async (root) => {
    const started = await startAgentImage(root, "dev");
    const mountPath = path.join(root, ".pharo-agent", "mounts", "dev");

    assert.equal(started.name, "dev");
    assert.equal(started.mountPath, mountPath);
    assert.equal(started.projectionPort, 60341);
    assert.equal(started.notMounted, undefined);
    assert.equal(
      imageToolAnswers.render(startAnswer(root, started, "dev")),
      "Started image dev as it was last saved.\nmount: .pharo-agent/mounts/dev",
    );
    assert.deepEqual(readProjection(root, "dev"), { mountPath, projectionPort: 60341, pifsRelease, pids: started.pids });
    const [evaluation] = callsOf("callTool");
    assert.equal(evaluation.tool, "image_evaluate");
    assert.ok(evaluation.arguments.code.includes(`named: 'proj-dev'`), "the mount carries the image's disk name");
  }, { images: { "proj-dev": pinnedImage({ answers: [projectionPort] }) } });
});

// An MCP with an evaluation time limit stops the load at its 30 s default
// unless told otherwise; one without the limit refuses the argument.
test("the projection start gives its evaluation a limit only where the image lists one", mounts, async () => {
  const limitedEvaluate = {
    name: "image_evaluate",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" }, timeoutSeconds: { type: "integer", default: 30, minimum: 1, maximum: 600 } },
      required: ["code"],
    },
  };
  const olderEvaluate = { name: "image_evaluate", inputSchema: { type: "object", properties: { code: { type: "string" } } } };
  await inProject(async (root) => {
    await startAgentImage(root, "dev");
    await startAgentImage(root, "old");
    await startAgentImage(root, "bare");

    const [limited, older, bare] = callsOf("callTool");
    assert.equal(limited.arguments.timeoutSeconds, pifsStartSeconds);
    assert.deepEqual(limited.options, { inputSchema: limitedEvaluate.inputSchema, minimumMs: 60_000 });
    for (const call of [older, bare]) {
      assert.deepEqual(Object.keys(call.arguments), ["code"]);
      assert.deepEqual(call.options, { minimumMs: 60_000 });
    }
  }, {
    images: {
      "proj-dev": pinnedImage({ tools: [limitedEvaluate], answers: [projectionPort] }),
      "proj-old": pinnedImage({ tools: [olderEvaluate], answers: [projectionPort] }),
      "proj-bare": pinnedImage({ answers: [projectionPort] }),
    },
  });
});

// The listing is the image's first answer: one that fails is a mount that
// fails, and the evaluation is not sent to an image that did not answer it.
test("a projection start whose image does not list its tools stops the image", mounts, async () => {
  await inProject(async (root) => {
    await assert.rejects(
      () => startAgentImage(root, "dev"),
      { message: "Image dev started, but was stopped again because mounting its source failed: fetch failed:"
        + " nothing answers at http://127.0.0.1:40001/. Start it with PHARO_AGENT_PROJECTION=off to skip the mount." },
    );
    assert.deepEqual(callsOf("callTool"), []);
    assert.equal(readWorld().images["proj-dev"].running, undefined);
  }, { images: { "proj-dev": pinnedImage({ unreachable: true }) } });
});

test("no name starts the default image, as headless unless asked", mounts, async () => {
  await inProject(async (root) => {
    await startAgentImage(root, undefined, { display: "interactive" });
    assert.deepEqual(callsOf("start"), [
      { op: "start", scope: "proj", name: "dev", options: { display: "interactive" } },
    ]);
    assert.equal(readWorld().images["proj-dev"].running?.display, "interactive");
  }, { images: { "proj-dev": pinnedImage({ answers: [projectionPort] }) } }, { config: { defaultImage: "dev" } });
});

// Chosen, so nothing to warn of: an answer without a mount line says there
// is no mount.
test("PHARO_AGENT_PROJECTION=off starts the image without asking PIFS, and says nothing of it", async () => {
  await inProject(async (root) => {
    const started = await startAgentImage(root, "dev");

    assert.equal(started.mountPath, undefined);
    assert.equal(started.notMounted, undefined);
    assert.equal(imageToolAnswers.render(startAnswer(root, started, "dev")), "Started image dev as it was last saved.");
    assert.deepEqual(callsOf("callTool"), []);
    assert.equal(readProjection(root, "dev"), undefined);
  }, { images: { "proj-dev": pinnedImage() } }, { projection: "off" });
});

test("a PHARO_AGENT_PROJECTION other than off starts the image unmounted, and says why", async () => {
  await inProject(async (root) => {
    const started = await startAgentImage(root, "dev");

    assert.deepEqual(startAnswer(root, started, "dev").warnings, [
      'No source is mounted: PHARO_AGENT_PROJECTION takes only off, and is "0". Unset it to mount sources'
        + " where the platform allows. Read and edit its code through its tools.",
    ]);
    assert.deepEqual(callsOf("callTool"), []);
  }, { images: { "proj-dev": pinnedImage() } }, { projection: "0" });
});

// PIFS has no daemon there, so no mount was to be had, and nothing is
// warned of: an answer without a mount line says there is none.
test("a start on a platform PIFS has no daemon for asks nothing of PIFS, and says nothing of it", async () => {
  const platform = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(process, "platform"));
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    await inProject(async (root) => {
      const started = await startAgentImage(root, "dev");

      assert.equal(started.notMounted, undefined);
      assert.equal(imageToolAnswers.render(startAnswer(root, started, "dev")), "Started image dev as it was last saved.");
      assert.deepEqual(callsOf("callTool"), []);
    }, { images: { "proj-dev": pinnedImage() } });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("a projection PIFS refuses leaves the image running, with the reason", mounts, async () => {
  await inProject(async (root) => {
    const started = await startAgentImage(root, "dev");

    assert.deepEqual(startAnswer(root, started, "dev").warnings, [
      "No source is mounted: FUSE needs fusermount3. Set PHARO_AGENT_PROJECTION=off to start images"
        + " without trying to mount. Read and edit its code through its tools.",
    ]);
    assert.equal(readWorld().images["proj-dev"].running !== undefined, true);
    assert.equal(readProjection(root, "dev"), undefined);
  }, {
    images: {
      "proj-dev": pinnedImage({
        answers: [{ tool: "image_evaluate", contains: "startMountedAt:", result: { content: [{ type: "text", text: "'FUSE needs fusermount3'" }] } }],
      }),
    },
  });
});

// Nothing then says whether PIFS mounted; a mount nothing records would
// outlive the session, so the image goes, and its daemon unmounts with it.
test("a projection that answers nothing readable stops the image, and says so", mounts, async () => {
  await inProject(async (root) => {
    const stderr = await logged(() => assert.rejects(
      () => startAgentImage(root, "dev"),
      { message: "Image dev started, but was stopped again because PIFS answered no projection port."
        + " Start it with PHARO_AGENT_PROJECTION=off to skip the mount." },
    ));
    assert.deepEqual(stderr, [
      'pharo-agent: PIFS answered no projection port for dev: {"content":[{"type":"text","text":"a Dictionary()"}]}',
    ]);
    assert.deepEqual(callsOf("stop").map((call) => call.name), ["dev"]);
    assert.equal(readWorld().images["proj-dev"].running, undefined);
  }, {
    images: {
      "proj-dev": pinnedImage({
        answers: [{ tool: "image_evaluate", contains: "startMountedAt:", result: { content: [{ type: "text", text: "a Dictionary()" }] } }],
      }),
    },
  });
});

// A cold start that outlasts the evaluation's limit is what the limit given
// to the start is for: the image's own words say so, not a missing port.
test("a mount the image answers with an error stops the image, and says what the image said", mounts, async () => {
  const stopped = "Evaluation stopped after 120 s, its time limit.\nWhat it changed before then stays changed."
    + "\nStopped in:\nZnClient>>executeRequestResponse";
  await inProject(async (root) => {
    const stderr = await logged(() => assert.rejects(
      () => startAgentImage(root, "dev"),
      { message: "Image dev started, but was stopped again because mounting its source failed:"
        + " Evaluation stopped after 120 s, its time limit. Start it with PHARO_AGENT_PROJECTION=off to skip the mount." },
    ));
    assert.deepEqual(stderr, [`pharo-agent: dev answered the PIFS start with: ${stopped}`]);
    assert.deepEqual(callsOf("stop").map((call) => call.name), ["dev"]);
    assert.equal(readWorld().images["proj-dev"].running, undefined);
    assert.equal(readProjection(root, "dev"), undefined);
  }, {
    images: {
      "proj-dev": pinnedImage({
        answers: [{ tool: "image_evaluate", contains: "startMountedAt:", result: { isError: true, content: [{ type: "text", text: stopped }] } }],
      }),
    },
  });
});

// One line is the whole of what the image said, and the answer carries it.
test("a mount the image answers with a one-line error logs nothing more", mounts, async () => {
  await inProject(async (root) => {
    const stderr = await logged(() => assert.rejects(
      () => startAgentImage(root, "dev"),
      { message: "Image dev started, but was stopped again because mounting its source failed:"
        + " Evaluation ended the process running it, so it has no value to answer."
        + " Start it with PHARO_AGENT_PROJECTION=off to skip the mount." },
    ));
    assert.deepEqual(stderr, []);
  }, {
    images: {
      "proj-dev": pinnedImage({
        answers: [{
          tool: "image_evaluate",
          contains: "startMountedAt:",
          result: { isError: true, content: [{ type: "text", text: "Evaluation ended the process running it, so it has no value to answer." }] },
        }],
      }),
    },
  });
});

// The evaluation is this package's, not the agent's: what PLexus would say of
// a call the agent made, that the image still runs, is no longer true.
test("a mount whose evaluation hangs up stops the image, and says the mount failed", mounts, async () => {
  await inProject(async (root) => {
    await assert.rejects(
      () => startAgentImage(root, "dev"),
      { message: "Image dev started, but was stopped again because mounting its source failed: socket hang up."
        + " Start it with PHARO_AGENT_PROJECTION=off to skip the mount." },
    );
    assert.equal(readWorld().images["proj-dev"].running, undefined);
    assert.equal(readProjection(root, "dev"), undefined);
  }, {
    images: {
      "proj-dev": pinnedImage({
        answers: [{ tool: "image_evaluate", contains: "startMountedAt:", error: "socket hang up", kind: "closed" }],
      }),
    },
  });
});

test("a failed mount whose stop fails too says both", mounts, async () => {
  await inProject(async (root) => {
    await assert.rejects(
      () => startAgentImage(root, "dev"),
      { message: "Image dev started, but mounting its source failed: socket hang up."
        + " Stopping it again failed as well: the launcher did not answer." },
    );
  }, {
    images: {
      "proj-dev": pinnedImage({
        stopFails: "the launcher did not answer.",
        answers: [{ tool: "image_evaluate", contains: "startMountedAt:", error: "socket hang up.", kind: "closed" }],
      }),
    },
  });
});

test("a running image is refused, and nothing is asked of it", async () => {
  await inProject(async (root) => {
    await assert.rejects(() => startAgentImage(root, "dev"), (/** @type {any} */ error) => error.code === "image-running");
    assert.deepEqual(callsOf("callTool"), []);
  }, { images: { "proj-dev": runningImage(41000) } });
});

test("a start forgets the projection a gone VM left recorded", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", { mountPath: "/m/dev", projectionPort: 1, pifsRelease: "v0.0.1", pids: [7] });
    await startAgentImage(root, "dev");
    assert.equal(readProjection(root, "dev"), undefined);
  }, { images: { "proj-dev": pinnedImage() } }, { projection: "off" });
});

test("a start of an image made with another pin says so", async () => {
  await inProject(async (root) => {
    const started = await startAgentImage(root, "dev");
    assert.deepEqual(started.row.mcp, { source: "pin", version: "0.0.1" }, "the image as listed before its start");
    assert.ok(startAnswer(root, started, "dev").warnings.includes(
      `Image dev holds Pharo MCP 0.0.1, and images are created with ${defaultPharoMcpVersion} now, so its tools`
        + " may differ from the current ones. Recreating it gives it the current MCP.",
    ));
  }, { images: { "proj-dev": pinnedImage({ mcp: { source: "pin", version: "0.0.1" } }) } }, { projection: "off" });
});

// runningImage(41000) runs as pid 91000.
const mountedDev = { mountPath: "/m/dev", projectionPort: 60341, pifsRelease, pids: [91000] };

test("a stop unmounts the projection, then kills the image", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", mountedDev);
    const stopped = await stopAgentImage(root, "dev");

    assert.deepEqual(stopped, { stopped: [{ name: "dev", killed: [91000] }], left: [] });
    const order = readWorld().calls.filter((call) => call.op === "callTool" || call.op === "stop");
    assert.deepEqual(order.map((call) => call.op), ["callTool", "stop"]);
    assert.match(order[0].arguments.code, /stopOn: 60341/);
    assert.equal(readProjection(root, "dev"), undefined);
  }, { images: { "proj-dev": runningImage(41000) } });
});

test("an image that exited is stopped without asking it to unmount", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", mountedDev);
    assert.deepEqual(await stopAgentImage(root, undefined), { stopped: [{ name: "dev", killed: [] }], left: [] });
    assert.deepEqual(callsOf("callTool"), []);
    assert.equal(readProjection(root, "dev"), undefined);
  }, { images: { "proj-dev": pinnedImage() } }, { config: { defaultImage: "dev" } });
});

// The VM that mounted exited, and the image runs again in a VM started
// elsewhere, which has no projection and serves nothing on that port.
test("a projection recorded for another VM of the image is not unmounted", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", { ...mountedDev, pids: [5] });
    assert.deepEqual(await stopAgentImage(root, "dev"), { stopped: [{ name: "dev", killed: [91000] }], left: [] });
    assert.deepEqual(callsOf("callTool"), []);
  }, { images: { "proj-dev": runningImage(41000) } });
});

// A record is an extra: one that cannot be read must not keep an image
// from stopping.
test("a projection record that does not read is no record", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", mountedDev);
    fs.writeFileSync(projectionPath(root, "dev"), '{"mountPath":');
    assert.deepEqual(await stopAgentImage(root, "dev"), { stopped: [{ name: "dev", killed: [91000] }], left: [] });
    assert.deepEqual(callsOf("callTool"), []);
  }, { images: { "proj-dev": runningImage(41000) } });
});

// The daemon unmounts once its image is gone, so the answer would hold
// nothing to act on; the host's log keeps it.
test("an unmount that fails still stops the image, and says so on stderr only", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", mountedDev);
    /** @type {import("../src/answers.js").AgentStop | undefined} */
    let stopped;
    const stderr = await logged(async () => { stopped = await stopAgentImage(root, "dev"); });

    assert.deepEqual(stopped, { stopped: [{ name: "dev", killed: [91000] }], left: [] });
    assert.deepEqual(stderr, ["pharo-agent: PIFS did not unmount dev: socket hang up"]);
    assert.deepEqual(stopAnswer(/** @type {any} */ (stopped)).warnings, []);
  }, {
    images: {
      "proj-dev": runningImage(41000, { answers: [{ tool: "image_evaluate", contains: "stopOn:", error: "socket hang up" }] }),
    },
  });
});

// A VM started by hand, or by an older PLexus, has no endpoint: a sweep
// must not kill what this project cannot even talk to.
test("stopping all stops the project's images that have an endpoint", async () => {
  await inProject(async (root) => {
    const stopped = await stopAgentImage(root, undefined, { all: true });

    assert.deepEqual(stopped.stopped.map((each) => each.name), ["dev"]);
    assert.deepEqual(stopped.left.map((each) => each.name), ["legacy"], "what all leaves running, to say so");
    assert.deepEqual(callsOf("stop").map((call) => call.name), ["dev"]);
    assert.notEqual(readWorld().images["proj-legacy"].running, undefined);
    assert.notEqual(readWorld().images["other-dev"].running, undefined);
  }, {
    images: {
      "proj-dev": runningImage(41000),
      "proj-legacy": pinnedImage({ running: { pids: [123] } }),
      "proj-idle": pinnedImage(),
      "other-dev": runningImage(42000),
    },
  });
});

test("stopping all takes no name", async () => {
  await inProject(async (root) => {
    await assert.rejects(() => stopAgentImage(root, "dev", { all: true }), /takes no image name/);
    assert.deepEqual(callsOf("stop"), []);
  });
});

test("a call reaches the endpoint PLexus gives for the named image", async () => {
  await inProject(async (root) => {
    const target = await imageTarget(root, "ci");
    const answer = await callImageTool(target, "class_get", { name: "Point" });

    assert.deepEqual(answer, { content: [{ type: "text", text: "Point" }] });
    assert.deepEqual(callsOf("callTool"), [
      { op: "callTool", url: "http://127.0.0.1:42000/", tool: "class_get", arguments: { name: "Point" }, options: { minimumMs: 60_000 } },
    ]);
  }, {
    images: {
      "proj-dev": runningImage(41000),
      "proj-ci": runningImage(42000, { answers: [{ tool: "class_get", result: { content: [{ type: "text", text: "Point" }] } }] }),
    },
  }, { config: { defaultImage: "dev" } });
});

test("a call to an image that is not running is PLexus's refusal, with how to start it", async () => {
  await inProject(async (root) => {
    await assert.rejects(
      () => imageTarget(root, undefined),
      (/** @type {any} */ error) => error.code === "not-running"
        && /^Image dev is not running\. Start it with image_start/.test(error.message),
    );
  }, { images: { "proj-dev": pinnedImage() } }, { config: { defaultImage: "dev" } });
});

// Not running, and start it, sent an agent to a start refused for want of
// an image.
test("a default image that does not exist is refused with a code of its own", async () => {
  await inProject(async (root) => {
    await assert.rejects(
      () => imageTarget(root, undefined),
      (/** @type {any} */ error) => error.code === "no-such-default"
        && error.message === "No image is named, and the default image dev does not exist. Create it with"
          + " image_create, or choose another default with pharo-agent image use <name>.",
    );
  }, { images: { "proj-ci": pinnedImage() } }, { config: { defaultImage: "dev" } });
});

// pharo-agent image use changes the project's default, not the one a server
// was started with.
test("a default a server was started with, that does not exist, is to be created", async () => {
  await inProject(async (root) => {
    await assert.rejects(
      () => imageTarget(root, undefined, { defaultImage: "ci" }),
      (/** @type {any} */ error) => error.code === "no-such-default"
        && error.message === "No image is named, and the default image ci does not exist. Running now: dev."
          + " Name one with image, or create it with image_create.",
    );
  }, { images: { "proj-dev": runningImage(41000) } }, { config: { defaultImage: "dev" } });
});

// It runs: saying it does not, and offering to start it, would send an agent
// to a start that is refused.
test("a default image running without an endpoint is PLexus's refusal, whatever else runs", async () => {
  await inProject(async (root) => {
    await assert.rejects(() => imageTarget(root, undefined), (/** @type {any} */ error) => error.code === "no-endpoint");
  }, {
    images: { "proj-dev": pinnedImage({ running: { pids: [123] } }), "proj-ci": runningImage(42000) },
  }, { config: { defaultImage: "dev" } });
});

// This package's own calls go through it, the PIFS start and stop among
// them: said there, a failure would report a call the agent never made.
test("a call that fails rejects with PLexus's error as it is", async () => {
  await inProject(async (root) => {
    const target = await imageTarget(root, "dev");
    await assert.rejects(
      () => callImageTool(target, "package_list", {}),
      (/** @type {any} */ error) => error.message === "MCP error -32601: The method does not exist"
        && error.kind === "answered" && error.rpcCode === -32601,
    );
    await assert.rejects(
      () => callImageTool(target, "image_evaluate", { code: "Smalltalk snapshot: true andQuit: false" }),
      (/** @type {any} */ error) => error.message === "socket hang up" && error.kind === "closed",
    );
  }, {
    images: {
      "proj-dev": runningImage(41000, {
        mcp: { source: "pin", version: "0.0.1" },
        answers: [
          { tool: "package_list", error: "MCP error -32601: The method does not exist", kind: "answered", rpcCode: -32601 },
          { tool: "image_evaluate", error: "socket hang up", kind: "closed" },
        ],
      }),
    },
  });
});

// A forwarded call waits longer than the image's own limit, which the schema
// it listed gives, so that the image's answer to a call it stopped arrives
// first.
test("a call passes PLexus the schema it was listed with, the least it waits, and the signal", async () => {
  await inProject(async (root) => {
    const target = await imageTarget(root, "dev");
    const inputSchema = { type: /** @type {const} */ ("object"), properties: { timeoutSeconds: { type: "integer", default: 90 } } };
    await callImageTool(target, "test_run", { package: "Foo" }, { inputSchema, signal: new AbortController().signal });

    assert.deepEqual(callsOf("callTool").map((call) => call.options), [{ inputSchema, minimumMs: 60_000, signal: true }]);
  }, { images: { "proj-dev": runningImage(41000) } });
});
