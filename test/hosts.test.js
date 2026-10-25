import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { guideForHost, hostChoices, hostIds, hostList, supportedHosts } from "../src/hosts.js";

test("Claude Code is offered first, and every host has a guide", () => {
  assert.deepEqual(hostIds, ["claude", "codex", "opencode"]);
  for (const host of supportedHosts) {
    assert.ok(host.name, `${host.id} has no display name`);
    assert.equal(guideForHost(host.id), host.guide);
  }
  assert.equal(hostChoices(), "claude|codex|opencode");
  assert.equal(hostList(), "claude, codex, or opencode");
});

test("the README names every supported host, and none it does not support", () => {
  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const host of supportedHosts) {
    assert.match(readme, new RegExp(host.name), `README does not name ${host.name}`);
  }
  const choices = hostChoices().replaceAll("|", "\\|");
  assert.match(readme, new RegExp(`--host <${choices}>`));
});

test("the setup skill initializes the host it is installed into", () => {
  const skill = fs.readFileSync(
    new URL("../skills/pharo-setup/SKILL.md", import.meta.url),
    "utf8",
  );
  for (const host of supportedHosts) {
    assert.match(skill, new RegExp(`--host ${host.id}`), `skill does not offer ${host.id}`);
  }
});

test("a host that installs as a plugin ships the manifest that host reads", () => {
  const root = new URL("../", import.meta.url);
  const manifests = { claude: ".claude-plugin/marketplace.json", codex: ".agents/plugins/marketplace.json" };
  for (const host of supportedHosts.filter((each) => each.plugin)) {
    const manifest = manifests[host.id];
    assert.ok(manifest, `${host.id} claims to install as a plugin but names no manifest`);
    assert.ok(fs.existsSync(path.join(root.pathname, manifest)), `${manifest} is missing`);
  }
});
