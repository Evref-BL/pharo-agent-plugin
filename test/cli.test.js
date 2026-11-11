import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exitCodeForToolResult, main } from "../src/cli.js";
import { hostChoices } from "../src/hosts.js";

function temporaryProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-cli-"));
  fs.writeFileSync(path.join(root, "plexus.json"), `${JSON.stringify({ images: [] })}\n`);
  return root;
}

async function inProject(run) {
  const root = temporaryProject();
  const previous = process.cwd();
  try {
    process.chdir(root);
    await run(root);
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("image start takes one id and nothing else", async () => {
  await inProject(async () => {
    await assert.rejects(
      () => main(["image", "start", "dev", "extra"]),
      /image start takes one image id/,
    );
    await assert.rejects(
      () => main(["image", "start", "--all"]),
      /image start does not accept --all/,
    );
  });
});

test("help is answered wherever the word lands without initializing a project", () => {
  const binary = fileURLToPath(new URL("../bin/pharo-agent.js", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-help-"));
  try {
    /** @type {[string[], RegExp][]} */
    const cases = [
      [[], /pharo-agent image add <id> --template/],
      [["--help"], /pharo-agent init --host/],
      [["help"], /pharo-agent image add/],
      [["init", "--help"], /Re-run to refresh/],
      [["init", "help"], /\.pharo-agent\/mounts by default/],
      [["help", "init"], /Pharo guide, skills and references/],
      [["image", "--help"], /pharo-agent image templates/],
      [["image", "add", "--help"], /first declared image is the default/],
      [["image", "list", "--help"], /mount and port of each running one/],
      [["image", "templates", "--help"], /templates images can be made from/],
      [["image", "use", "--help"], /Make an image the default/],
      [["image", "remove", "--help"], /its files are kept/],
      [["image", "start", "--help"], /Others keep running/],
      [["image", "stop", "--help"], /--all of them/],
      [["mcp", "--help"], /stdio MCP server/],
      [["list", "--help"], /advertised tools, one line each/],
      [["--help"], /pharo-agent <tool> \[<value>\] \[--<argument> <value>\]/],
    ];
    for (const [args, expected] of cases) {
      const result = spawnSync(process.execPath, [binary, ...args], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, expected, args.join(" "));
      if (args.includes("init")) {
        assert.ok(result.stdout.includes(`--host <${hostChoices()}>`));
        assert.doesNotMatch(result.stdout, /pharo-agent image add/);
      }
      assert.match(result.stdout, /pharo-agent/);
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
  const binary = fileURLToPath(new URL("../bin/pharo-agent.js", import.meta.url));

  assert.equal(spawnSync(process.execPath, [binary, "--help"]).status, 0);
  assert.equal(spawnSync(process.execPath, [binary, "nonsense"]).status, 1);
});

function declare(root, images) {
  fs.writeFileSync(path.join(root, "plexus.json"), `${JSON.stringify({
    id: "probe",
    name: "probe",
    images: images.map((id) => ({
      id,
      imageName: `{workspaceId}-${id}`,
      mcp: { loadScript: "pharo/load-mcp.st" },
      create: { kind: "template", templateName: "Pharo 14.0 - 64bit (next stable)" },
    })),
  })}\n`);
}

test("a snake_case word is a tool call, and pharo is no command", async () => {
  await inProject(async (root) => {
    declare(root, []);
    await assert.rejects(() => main(["class_get", "Point"]), /No image is configured/);
    await assert.rejects(() => main(["pharo", "class_get", "{}"]), /Unsupported command: pharo/);
  });
});

test("an image that is not declared is answered with the ones that are", async () => {
  await inProject(async (root) => {
    declare(root, ["eval", "spare"]);
    fs.mkdirSync(path.join(root, ".pharo-agent"), { recursive: true });
    fs.writeFileSync(path.join(root, ".pharo-agent", "config.json"), `${JSON.stringify({ defaultImage: "eval" })}\n`);
    await assert.rejects(
      () => main(["tool_search", "--image", "default"]),
      /Image default is not configured\. This project declares eval \(the default\), spare\./,
    );
  });
});
