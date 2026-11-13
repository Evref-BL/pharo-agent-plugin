import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exitCodeForToolResult, main } from "../src/cli.js";
import { hostChoices } from "../src/hosts.js";
import { readConfig, writeConfig } from "../src/project.js";
import {
  callsOf,
  pinnedImage,
  plexusHook,
  readWorld,
  runningImage,
  useFakePlexus,
} from "./support/fake-plexus.js";

const binary = fileURLToPath(new URL("../bin/pharo-agent.js", import.meta.url));

// The host running these tests may name its own project, which is not the
// one a test means.
function hermeticEnv() {
  const { CLAUDE_PROJECT_DIR: _host, ...inherited } = process.env;
  return inherited;
}

function run(args, cwd) {
  return spawnSync(process.execPath, ["--import", plexusHook, binary, ...args], {
    cwd,
    encoding: "utf8",
    env: hermeticEnv(),
  });
}

/**
 * Runs `main` from inside a project over a fake PLexus store, and gives back
 * what it printed.
 *
 * @param {(root: string, printed: string[]) => Promise<void>} body
 * @param {Parameters<typeof useFakePlexus>[0]} [world]
 * @param {Record<string, unknown>} [config]
 */
async function inProject(body, world = {}, config = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-cli-")));
  const dropStore = useFakePlexus(world);
  const previous = process.cwd();
  const log = console.log;
  /** @type {string[]} */
  const printed = [];
  try {
    writeConfig(root, { scope: "proj", ...config });
    process.chdir(root);
    console.log = (text) => printed.push(String(text));
    await body(root, printed);
  } finally {
    console.log = log;
    process.chdir(previous);
    dropStore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("image start takes one name and a display", async () => {
  await inProject(async () => {
    await assert.rejects(() => main(["image", "start", "dev", "extra"]), /image start takes one image name/);
    await assert.rejects(() => main(["image", "start", "--all"]), /image start takes one image name/);
    await assert.rejects(() => main(["image", "start", "dev", "--display", "full"]), /--display is headless or interactive/);
    assert.deepEqual(callsOf("start"), []);
  });
});

test("image stop takes one name or --all", async () => {
  await inProject(async () => {
    await assert.rejects(() => main(["image", "stop", "dev", "ci"]), /image stop takes one image name or --all/);
    await assert.rejects(() => main(["image", "stop", "dev", "--all"]), /takes no image name/);
  });
});

test("image create needs a name and a template, and --every-start a script", async () => {
  await inProject(async () => {
    await assert.rejects(() => main(["image", "create", "--template", "x"]), /requires an image name/);
    await assert.rejects(() => main(["image", "create", "dev"]), /requires --template/);
    await assert.rejects(() => main(["image", "create", "dev", "--template", "x", "--every-start"]), /needs one/);
    await assert.rejects(() => main(["image", "create", "dev", "--template", "x", "--profile", "p"]), /Unknown image create option: --profile/);
    assert.deepEqual(callsOf("create"), []);
  });
});

test("image create passes a script, and every start, to PLexus", async () => {
  await inProject(async (root, printed) => {
    const script = path.join(root, "load.st");
    fs.writeFileSync(script, "Transcript show: 'loaded'.\n");
    await main(["image", "create", "mcp", "--template", "Pharo 14.0 - 64bit (stable)", "--script", script, "--every-start"]);

    assert.equal(JSON.parse(printed.join("\n")).isDefault, true);
    assert.deepEqual(readWorld().images["proj-mcp"].mcp, { source: "script", script });
    assert.equal(readWorld().images["proj-mcp"].everyStart, script);
    assert.equal(readConfig(root).defaultImage, "mcp");
  });
});

test("image use and image delete name their image", async () => {
  await inProject(async (root) => {
    await assert.rejects(() => main(["image", "delete"]), /image delete requires one image name/);
    await main(["image", "use", "ci"]);
    assert.equal(readConfig(root).defaultImage, "ci");
    await main(["image", "delete", "ci"]);
    assert.equal(readConfig(root).defaultImage, undefined);
    assert.deepEqual(Object.keys(readWorld().images), ["proj-dev"]);
  }, { images: { "proj-dev": pinnedImage(), "proj-ci": pinnedImage() } }, { defaultImage: "dev" });
});

test("help is answered wherever the word lands without initializing a project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-help-"));
  try {
    /** @type {[string[], RegExp][]} */
    const cases = [
      [[], /pharo-agent image create <name> --template/],
      [["--help"], /pharo-agent init --host/],
      [["help"], /pharo-agent image create/],
      [["init", "--help"], /Re-run to refresh/],
      [["init", "help"], /\.pharo-agent\/mounts by default/],
      [["help", "init"], /Pharo guide, skills and references/],
      [["image", "--help"], /pharo-agent image templates/],
      [["image", "create", "--help"], /first image created is the default/],
      [["image", "list", "--help"], /which are running now/],
      [["image", "templates", "--help"], /templates images can be created from/],
      [["image", "use", "--help"], /Make an image the default/],
      [["image", "delete", "--help"], /Delete a stopped image/],
      [["image", "start", "--help"], /Others keep running/],
      [["image", "stop", "--help"], /--all of this project's running images/],
      [["mcp", "--help"], /stdio MCP server/],
      [["list", "--help"], /advertised tools, one line each/],
      [["class_create", "--help"], /class_create's own arguments come from a running image/],
      [["--help"], /pharo-agent <tool> \[<value>\] \[--<argument> <value>\]/],
    ];
    for (const [args, expected] of cases) {
      const result = run(args, root);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, expected, args.join(" "));
      if (args.includes("init")) {
        assert.ok(result.stdout.includes(`--host <${hostChoices()}>`));
        assert.doesNotMatch(result.stdout, /pharo-agent image create/);
      }
      assert.match(result.stdout, /pharo-agent/);
      assert.doesNotMatch(result.stdout, /image add|image remove|--profile/);
      assert.equal(result.stderr, "");
      assert.deepEqual(fs.readdirSync(root), []);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the bundle reports the published version, not a placeholder", async () => {
  const { version } = await import("../src/gateway.js");
  const published = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;

  assert.equal(version, published);
  assert.notEqual(version, "0.0.0");
});

test("a tool answering with an error fails the command", () => {
  const failed = {
    content: [{ type: "text", text: "ZeroDivide: attempt to divide by zero" }],
    isError: true,
  };

  assert.equal(exitCodeForToolResult(failed), 1);
  assert.equal(exitCodeForToolResult({ content: [{ type: "text", text: "3" }] }), 0);
  assert.equal(exitCodeForToolResult({}), 0);
});

test("the executable reports what main answers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-exit-"));
  try {
    assert.equal(run(["--help"], root).status, 0);
    assert.equal(run(["nonsense"], root).status, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a snake_case word is a tool call, and pharo is no command", async () => {
  await inProject(async () => {
    await assert.rejects(() => main(["class_get", "Point"]), /no default image/);
    await assert.rejects(() => main(["pharo", "class_get", "{}"]), /Unsupported command: pharo/);
    await assert.rejects(() => main(["image_start", "dev"]), /image_start is pharo-agent image start here/);
    await assert.rejects(() => main(["image_delete", "dev"]), /image_delete is pharo-agent image delete here/);
  });
});

test("a tool call reaches the default image, its arguments read from the schema", async () => {
  await inProject(async (_root, printed) => {
    const exitCode = await main(["class_get", "Point"]);

    assert.equal(exitCode, 0);
    assert.deepEqual(printed, ["Point class"]);
    assert.deepEqual(callsOf("callTool").map((call) => [call.tool, call.arguments]), [["class_get", { name: "Point" }]]);
  }, {
    images: {
      "proj-dev": runningImage(41000, {
        tools: [{ name: "class_get", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }],
        answers: [{ tool: "class_get", result: { content: [{ type: "text", text: "Point class" }] } }],
      }),
    },
  }, { defaultImage: "dev" });
});

test("a tool call to an image that is not running is PLexus's refusal", async () => {
  await inProject(async () => {
    await assert.rejects(
      () => main(["tool_search", "--image", "spare"]),
      (/** @type {any} */ error) => error.code === "not-running",
    );
  }, { images: { "proj-spare": pinnedImage() } });
});
