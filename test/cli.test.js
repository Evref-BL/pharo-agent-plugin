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

test("status refuses --image instead of ignoring it", async () => {
  await inProject(async () => {
    await assert.rejects(
      () => main(["status", "--image", "dev"]),
      /status reports every open image and does not accept --image/,
    );
  });
});

test("help is answered wherever the word lands without initializing a project", () => {
  const binary = fileURLToPath(new URL("../bin/pharo-agent.js", import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-help-"));
  try {
    const cases = [
      [[], /pharo-agent image add <id> --template/],
      [["--help"], /pharo-agent init --host/],
      [["help"], /pharo-agent image add/],
      [["init", "--help"], /Re-run to refresh/],
      [["init", "help"], /mount root defaults to \.pharo-agent\/mounts/],
      [["help", "init"], /required agent host/],
      [["image", "--help"], /pharo-agent image templates/],
      [["image", "add", "--help"], /first declared image becomes the default/],
      [["image", "list", "--help"], /recorded open state/],
      [["image", "templates", "--help"], /available launcher templates/],
      [["image", "use", "--help"], /project's default/],
      [["image", "remove", "--help"], /image files are kept/],
      [["open", "--help"], /Other open images stay open/],
      [["close", "--help"], /Omitting --image closes all images/],
      [["status", "--help"], /does not accept --image/],
      [["mcp", "--help"], /command-scoped stdio MCP server/],
      [["pharo", "--help"], /JSON object and default to \{\}/],
      [["pharo", "list", "--help"], /advertised tools/],
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
