import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { defaultPharoMcpVersion } from "@evref-bl/plexus";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

test("package and host manifests share the plugin identity", () => {
  const packageJson = readJson("package.json");
  const agentPlugin = readJson("plugin.json");
  const claudePlugin = readJson(".claude-plugin/plugin.json");

  assert.equal(packageJson.name, "@evref-bl/pharo-agent");
  assert.equal(packageJson.repository.url, "git+https://github.com/Evref-BL/pharo-agent-plugin.git");
  assert.equal(agentPlugin.name, "pharo-agent");
  assert.equal(claudePlugin.name, agentPlugin.name);
  assert.equal(claudePlugin.version, agentPlugin.version);
  assert.equal(packageJson.version, agentPlugin.version);
});

// The skills are MCP's for the images PLexus creates, so they come from the
// MCP release PLexus loads.
test("pins the pharo-mcp release PLexus loads into the images it creates", () => {
  assert.equal(readJson("package.json").dependencies["@evref-bl/pharo-mcp"], defaultPharoMcpVersion);
});

// Claude Code installs a plugin's dependencies only when each is a registry
// package pinned to an exact version.
test("depends on exact registry versions only", () => {
  const packageJson = readJson("package.json");
  assert.equal(packageJson.devDependencies, undefined);
  for (const [name, version] of Object.entries(packageJson.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, name);
  }
});

test("runs the server of the PLexus it pins, in the host's project", () => {
  const plexus = readJson("node_modules/@evref-bl/plexus/package.json");
  assert.equal(plexus.version, readJson("package.json").dependencies["@evref-bl/plexus"]);
  assert.deepEqual(readJson(".mcp.json"), {
    mcpServers: {
      pharo: {
        command: "node",
        args: [`\${CLAUDE_PLUGIN_ROOT}/node_modules/@evref-bl/plexus/${plexus.bin.plexus}`, "mcp", "--project", "${CLAUDE_PROJECT_DIR}"],
      },
    },
  });
});

// The release workflow moves stable to a release once its tag exists, so the
// marketplace never names a tag not made yet, nor serves main.
test("the Claude Code marketplace installs from stable", () => {
  const [plugin] = readJson(".claude-plugin/marketplace.json").plugins;
  assert.equal(plugin.name, "pharo-agent");
  assert.deepEqual(plugin.source, { source: "github", repo: "Evref-BL/pharo-agent-plugin", ref: "stable" });
});

test("the Codex marketplace exposes the plugin from the repository root", () => {
  const [plugin] = readJson(".agents/plugins/marketplace.json").plugins;
  assert.equal(plugin.name, "pharo-agent");
  assert.equal(plugin.source, "./");
});

test("feedback skill names the release it ships with", () => {
  const packageJson = readJson("package.json");
  const skill = fs.readFileSync(path.join(root, "skills/pharo-feedback/SKILL.md"), "utf8");
  assert.ok(skill.includes(`\`pharo-agent ${packageJson.version}\``));
});

test("the README names the PLexus release it pins", () => {
  const plexus = readJson("package.json").dependencies["@evref-bl/plexus"];
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const links = [...readme.matchAll(/Evref-BL\/PLexus\/(?:blob|tree)\/([^/\s)]+)/g)].map((match) => match[1]);
  const commands = [...readme.matchAll(/@evref-bl\/plexus@([^"\s]+)/g)].map((match) => match[1]);
  assert.ok(links.length > 0);
  for (const ref of links) assert.equal(ref, `v${plexus}`);
  for (const version of commands) assert.equal(version, plexus);
});

// A host installs the plugin's dependencies from its lock. The release train
// refreshes it after set-version.mjs; a lock that disagrees would install
// other versions than the release names.
test("the lock records the release and its pins", () => {
  const packageJson = readJson("package.json");
  const lock = readJson("package-lock.json");
  assert.equal(lock.version, packageJson.version);
  assert.equal(lock.packages[""].version, packageJson.version);
  assert.deepEqual(lock.packages[""].dependencies, packageJson.dependencies);
});

// npm and GitHub find the licence by its text, not by package.json.
test("ships the full text of the licence it declares", () => {
  assert.equal(readJson("package.json").license, "Apache-2.0");
  const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
  assert.match(license, /^\s*Apache License\s+Version 2\.0, January 2004/);
  assert.ok(license.includes("9. Accepting Warranty or Additional Liability."));
  assert.ok(license.includes("END OF TERMS AND CONDITIONS"));
});
