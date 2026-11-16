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
  defaultPharoMcpVersion,
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

// The terminal is the plugin's first surface, and its start said nothing,
// so the next tool command went to the default image.
test("image start of an image other than the default says to name it, as the server's does", async () => {
  const projection = process.env.PHARO_AGENT_PROJECTION;
  process.env.PHARO_AGENT_PROJECTION = "off";
  try {
    await inProject(async (_root, printed) => {
      await main(["image", "start", "p13", "--json"]);
      const started = JSON.parse(printed.join("\n"));
      assert.equal(started.name, "p13");
      assert.equal(
        started.note,
        'Pass image: "p13" to its tools: a call that names no image goes to dev, the default image.',
      );
      assert.equal(started.warning, undefined, "projections off by choice, so nothing to warn of");

      printed.length = 0;
      await main(["image", "start", "--json"]);
      assert.equal(JSON.parse(printed.join("\n")).name, "dev");
      assert.equal(JSON.parse(printed.join("\n")).note, undefined, "a call that names no image already goes there");
    }, { images: { "proj-dev": pinnedImage(), "proj-p13": pinnedImage() } }, { defaultImage: "dev" });
  } finally {
    if (projection === undefined) delete process.env.PHARO_AGENT_PROJECTION;
    else process.env.PHARO_AGENT_PROJECTION = projection;
  }
});

// The terminal prints what the image tools answer over MCP, from the same
// functions; a script reads today's JSON with --json.
test("each image command prints its tool's text, and with --json the JSON it printed before", async () => {
  const projection = process.env.PHARO_AGENT_PROJECTION;
  process.env.PHARO_AGENT_PROJECTION = "off";
  try {
    await inProject(async (root, printed) => {
      /** @param {string[]} args */
      const said = async (args) => {
        printed.length = 0;
        await main(args);
        return printed.join("\n");
      };

      assert.equal(
        await said(["image", "templates"]),
        [
          "4 templates in 2 categories.",
          "Official distributions:",
          "  Pharo 14.0 - 64bit (stable)",
          "  Pharo 13.0 - 64bit",
          "  Pharo 10.0 - 64bit",
          "Pharo Mooc:",
          "  Pharo 10.0 - 64bit",
        ].join("\n"),
      );
      assert.equal(
        await said(["image", "create", "dev", "--template", "Pharo 13.0 - 64bit"]),
        "Created image dev from Pharo 13.0 - 64bit. It is not running yet; image_start starts it."
          + " It is the project's default image.",
      );
      assert.equal(await said(["image", "start"]), "Started image dev as it was last saved.");
      assert.equal(
        await said(["image", "list"]),
        [
          "2 images, 1 running. The default image is dev.",
          "images (each mcp=" + defaultPharoMcpVersion + "):",
          '  dev state=running template="Pharo 13.0 - 64bit"',
          '  p13 state=stopped pharo=13.0 template="Pharo 13.0 - 64bit (stable)"',
        ].join("\n"),
      );
      assert.equal(await said(["image", "use", "p13"]), "The project's default image is p13 now.");
      assert.equal(await said(["image", "stop", "dev"]), "Stopped image dev; what it had not saved is lost.");
      assert.equal(
        await said(["image", "delete", "p13"]),
        "Deleted image p13 and its files. It was the project's default image; the next image created becomes the default.",
      );
      assert.equal(readConfig(root).defaultImage, undefined);
    }, {
      images: {
        "proj-p13": pinnedImage({ template: "Pharo 13.0 - 64bit (stable)", pharoVersion: "130" }),
      },
    });
  } finally {
    if (projection === undefined) delete process.env.PHARO_AGENT_PROJECTION;
    else process.env.PHARO_AGENT_PROJECTION = projection;
  }
});

test("--json, anywhere among an image command's arguments, prints the object a script parsed before", async () => {
  const projection = process.env.PHARO_AGENT_PROJECTION;
  process.env.PHARO_AGENT_PROJECTION = "off";
  try {
    await inProject(async (_root, printed) => {
      /** @param {string[]} args */
      const parsed = async (args) => {
        printed.length = 0;
        await main(args);
        return JSON.parse(printed.join("\n"));
      };

      assert.equal((await parsed(["image", "templates", "--json"])).templates.length, 4);
      assert.deepEqual(
        await parsed(["image", "create", "dev", "--template", "Pharo 13.0 - 64bit", "--json"]),
        {
          ok: true,
          name: "dev",
          diskName: "proj-dev",
          path: "/fake-plexus/profiles/images/proj-dev/proj-dev.image",
          running: false,
          pids: [],
          template: "Pharo 13.0 - 64bit",
          mcp: { source: "pin", version: defaultPharoMcpVersion },
          fromBase: true,
          seconds: 0,
          isDefault: true,
        },
      );
      assert.deepEqual(await parsed(["image", "start", "--json", "dev"]), {
        ok: true,
        name: "dev",
        pids: [90001],
        endpoint: { url: "http://127.0.0.1:40001/", pid: 90001 },
        display: "headless",
        seconds: 0,
      });
      const listed = await parsed(["image", "list", "--json"]);
      assert.equal(listed.ok, true);
      assert.equal(listed.defaultImage, "dev");
      assert.deepEqual(listed.images.map((image) => [image.name, image.running, image.isDefault]), [["dev", true, true]]);
      assert.deepEqual(await parsed(["image", "use", "dev", "--json"]), { ok: true, defaultImage: "dev" });
      assert.deepEqual(await parsed(["image", "--json", "use", "dev"]), { ok: true, defaultImage: "dev" });
      assert.deepEqual(await parsed(["image", "stop", "--json"]), { ok: true, stopped: [{ name: "dev", killed: [90001] }] });
      assert.deepEqual(await parsed(["image", "delete", "dev", "--json"]), { ok: true, name: "dev", clearedDefault: true });
    });
  } finally {
    if (projection === undefined) delete process.env.PHARO_AGENT_PROJECTION;
    else process.env.PHARO_AGENT_PROJECTION = projection;
  }
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
    await main(["image", "create", "mcp", "--template", "Pharo 14.0 - 64bit (stable)", "--script", script, "--every-start", "--json"]);

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
      [["image", "list", "--help"], /pharo-agent image list \[--json\][^]*--json prints the answer as JSON, for a script\./],
      [["image", "--help"], /pharo-agent image stop \[<name>\] \[--all\] \[--json\]/],
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

// test_run's own limit is 90 s by default: cut at a minute, its answer was lost.
test("a tool call waits as the schema it read its arguments from allows", async () => {
  const testRun = { type: "object", properties: { package: { type: "string" }, timeoutSeconds: { type: "integer", default: 90 } } };
  await inProject(async () => {
    await main(["test_run", "--package", "Foo"]);
    await main(["test_run"]);

    assert.deepEqual(callsOf("callTool").map((call) => call.options), [
      { inputSchema: testRun, minimumMs: 60_000 },
      { minimumMs: 60_000 },
    ]);
  }, {
    images: { "proj-dev": runningImage(41000, { tools: [{ name: "test_run", inputSchema: testRun }] }) },
  }, { defaultImage: "dev" });
});

// As the server says it with the answer; on stderr here, so that the answer
// a redirect or a script keeps is the image's own.
test("a tool call that names no image says on stderr which image answered while others run", async () => {
  await inProject(async (root) => {
    const unnamed = run(["evaluate", "--json"], root);
    assert.equal(unnamed.status, 0, unnamed.stderr);
    assert.deepEqual(JSON.parse(unnamed.stdout), { content: [{ type: "text", text: "'Pharo14.0.0SNAPSHOT'" }] });
    assert.equal(
      unnamed.stderr,
      'No image was named, so the call went to dev, the default image. p13 runs too: pass image: "p13" to call it.\n',
    );

    const named = run(["evaluate", "--image", "dev"], root);
    assert.equal(named.stdout, "'Pharo14.0.0SNAPSHOT'\n");
    assert.equal(named.stderr, "");
  }, {
    images: {
      "proj-dev": runningImage(41000, {
        answers: [{ tool: "evaluate", result: { content: [{ type: "text", text: "'Pharo14.0.0SNAPSHOT'" }] } }],
      }),
      "proj-p13": runningImage(42000),
    },
  }, { defaultImage: "dev" });
});

test("a tool call that names no image, with no other image running, says nothing more", async () => {
  await inProject(async (root) => {
    const unnamed = run(["class_get"], root);
    assert.equal(unnamed.stdout, "nil\n");
    assert.equal(unnamed.stderr, "");
  }, { images: { "proj-dev": runningImage(41000), "proj-p13": pinnedImage() } }, { defaultImage: "dev" });
});

test("a tool call that fails says on stderr what became of the image, and fails the command", async () => {
  await inProject(async (root) => {
    const result = run(["image_evaluate", "--image", "p13"], root);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Image p13 closed the connection before answering image_evaluate, and still runs: check whether"
        + " the call took effect before making it again.\n",
    );
  }, {
    images: { "proj-p13": runningImage(42000, { answers: [{ tool: "image_evaluate", error: "socket hang up", kind: "closed" }] }) },
  });
});

test("a tool call to an image that is not running is PLexus's refusal", async () => {
  await inProject(async () => {
    await assert.rejects(
      () => main(["tool_search", "--image", "spare"]),
      (/** @type {any} */ error) => error.code === "not-running" && /image_start/.test(error.message),
    );
  }, { images: { "proj-spare": pinnedImage() } });
});
