import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callImageTool, imageTarget } from "../src/gateway.js";
import { pifsRelease, startAgentImage, stopAgentImage } from "../src/live.js";
import { writeConfig } from "../src/project.js";
import { projectionPath, readProjection, recordProjection } from "../src/runtime.js";
import {
  callsOf,
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
    assert.equal(started.warning, undefined);
    assert.deepEqual(readProjection(root, "dev"), { mountPath, projectionPort: 60341, pifsRelease, pids: started.pids });
    const [evaluation] = callsOf("callTool");
    assert.equal(evaluation.tool, "image_evaluate");
    assert.ok(evaluation.arguments.code.includes(`named: 'proj-dev'`), "the mount carries the image's disk name");
  }, { images: { "proj-dev": pinnedImage({ answers: [projectionPort] }) } });
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

test("PHARO_AGENT_PROJECTION=off starts the image without asking PIFS", async () => {
  await inProject(async (root) => {
    const started = await startAgentImage(root, "dev");

    assert.equal(started.mountPath, undefined);
    assert.match(started.warning ?? "", /PHARO_AGENT_PROJECTION=off/);
    assert.match(started.warning ?? "", /Image dev is running with its Pharo tools/);
    assert.deepEqual(callsOf("callTool"), []);
    assert.equal(readProjection(root, "dev"), undefined);
  }, { images: { "proj-dev": pinnedImage() } }, { projection: "off" });
});

test("a projection PIFS refuses leaves the image running, with the reason", mounts, async () => {
  await inProject(async (root) => {
    const started = await startAgentImage(root, "dev");

    assert.match(started.warning ?? "", /^FUSE needs fusermount3\./);
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
test("a projection that answers nothing readable stops the image", mounts, async () => {
  await inProject(async (root) => {
    await assert.rejects(() => startAgentImage(root, "dev"), /PIFS did not report a projection port/);
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
    assert.match(started.warning ?? "", /Image dev holds Pharo MCP 0\.0\.1/);
  }, { images: { "proj-dev": pinnedImage({ mcp: { source: "pin", version: "0.0.1" } }) } }, { projection: "off" });
});

// runningImage(41000) runs as pid 91000.
const mountedDev = { mountPath: "/m/dev", projectionPort: 60341, pifsRelease, pids: [91000] };

test("a stop unmounts the projection, then kills the image", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", mountedDev);
    const stopped = await stopAgentImage(root, "dev");

    assert.deepEqual(stopped, { stopped: [{ name: "dev", killed: [91000] }] });
    const order = readWorld().calls.filter((call) => call.op === "callTool" || call.op === "stop");
    assert.deepEqual(order.map((call) => call.op), ["callTool", "stop"]);
    assert.match(order[0].arguments.code, /stopOn: 60341/);
    assert.equal(readProjection(root, "dev"), undefined);
  }, { images: { "proj-dev": runningImage(41000) } });
});

test("an image that exited is stopped without asking it to unmount", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", mountedDev);
    assert.deepEqual(await stopAgentImage(root, undefined), { stopped: [{ name: "dev", killed: [] }] });
    assert.deepEqual(callsOf("callTool"), []);
    assert.equal(readProjection(root, "dev"), undefined);
  }, { images: { "proj-dev": pinnedImage() } }, { config: { defaultImage: "dev" } });
});

// The VM that mounted exited, and the image runs again in a VM started
// elsewhere, which has no projection and serves nothing on that port.
test("a projection recorded for another VM of the image is not unmounted", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", { ...mountedDev, pids: [5] });
    assert.deepEqual(await stopAgentImage(root, "dev"), { stopped: [{ name: "dev", killed: [91000] }] });
    assert.deepEqual(callsOf("callTool"), []);
  }, { images: { "proj-dev": runningImage(41000) } });
});

// A record is an extra: one that cannot be read must not keep an image
// from stopping.
test("a projection record that does not read is no record", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", mountedDev);
    fs.writeFileSync(projectionPath(root, "dev"), '{"mountPath":');
    assert.deepEqual(await stopAgentImage(root, "dev"), { stopped: [{ name: "dev", killed: [91000] }] });
    assert.deepEqual(callsOf("callTool"), []);
  }, { images: { "proj-dev": runningImage(41000) } });
});

test("an unmount that fails still stops the image, and says so", async () => {
  await inProject(async (root) => {
    recordProjection(root, "dev", mountedDev);
    const stopped = await stopAgentImage(root, "dev");

    assert.deepEqual(stopped.stopped, [{ name: "dev", killed: [91000] }]);
    assert.match(stopped.warning ?? "", /PIFS did not unmount dev: socket hang up/);
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
      { op: "callTool", url: "http://127.0.0.1:42000/", tool: "class_get", arguments: { name: "Point" } },
    ]);
  }, {
    images: {
      "proj-dev": runningImage(41000),
      "proj-ci": runningImage(42000, { answers: [{ tool: "class_get", result: { content: [{ type: "text", text: "Point" }] } }] }),
    },
  }, { config: { defaultImage: "dev" } });
});

test("a call to an image that is not running is PLexus's refusal", async () => {
  await inProject(async (root) => {
    await assert.rejects(() => imageTarget(root, undefined), (/** @type {any} */ error) => error.code === "not-running");
  }, { images: { "proj-dev": pinnedImage() } }, { config: { defaultImage: "dev" } });
});

test("a -32601 from an image made with another pin names the pin", async () => {
  await inProject(async (root) => {
    const target = await imageTarget(root, "dev");
    await assert.rejects(
      () => callImageTool(target, "package_list", {}),
      /-32601[\s\S]*Image dev holds Pharo MCP 0\.0\.1/,
    );
  }, {
    images: {
      "proj-dev": runningImage(41000, {
        mcp: { source: "pin", version: "0.0.1" },
        answers: [{ tool: "package_list", error: "MCP error -32601: The method does not exist" }],
      }),
    },
  });
});
