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
  assert.equal(packageJson.dependencies["@evref-bl/pharo-mcp"], "1.4.1");
  assert.equal(packageJson.dependencies["@evref-bl/pharo-mcp"], defaultPharoMcpVersion);
  assert.equal(agentPlugin.name, "pharo-agent");
  assert.equal(claudePlugin.name, agentPlugin.name);
  assert.equal(claudePlugin.version, agentPlugin.version);
  assert.equal(packageJson.version, agentPlugin.version);
  assert.equal(
    agentPlugin.extensions["com.openai"].onboardingSkill,
    "./skills/pharo-setup/SKILL.md",
  );
  assert.equal(agentPlugin.extensions["com.openai"].requires_local_executor, true);
});

test("setup skill installs the matching CLI release", () => {
  const packageJson = readJson("package.json");
  const skill = fs.readFileSync(path.join(root, "skills/pharo-setup/SKILL.md"), "utf8");
  assert.match(skill, new RegExp(`@evref-bl/pharo-agent@${packageJson.version} init --host codex`));
});

test("marketplaces expose the plugin from the repository root", () => {
  const codexMarketplace = readJson(".agents/plugins/marketplace.json");
  const claudeMarketplace = readJson(".claude-plugin/marketplace.json");

  assert.equal(codexMarketplace.plugins[0].name, "pharo-agent");
  assert.equal(codexMarketplace.plugins[0].source, "./");
  assert.equal(claudeMarketplace.plugins[0].name, "pharo-agent");
  assert.equal(claudeMarketplace.plugins[0].source, "./");
});

test("the published CLI entry point is executable", () => {
  const packageJson = readJson("package.json");
  const binPath = path.join(root, packageJson.bin["pharo-agent"]);

  assert.equal(
    (fs.statSync(binPath).mode & 0o111) !== 0,
    true,
    `${packageJson.bin["pharo-agent"]} must keep its executable bit so a global install can run it`,
  );
});
