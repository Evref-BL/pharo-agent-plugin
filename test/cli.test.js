import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exitCodeForToolResult, main } from "../src/cli.js";

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

test("help is answered wherever the word lands", async () => {
  const lines = [];
  const log = console.log;
  console.log = (value) => lines.push(value);
  try {
    await main(["image", "add", "--help"]);
  } finally {
    console.log = log;
  }

  assert.match(lines.join("\n"), /pharo-agent image add <id> --template/);
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
