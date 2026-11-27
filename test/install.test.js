import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { codexConfig, install, openCodeConfig, Refusal, serverCommand, thisRelease } from "../src/install.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = serverCommand("9.9.9");

function temporaryProject(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-install-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function read(directory, file) {
  return fs.readFileSync(path.join(directory, file), "utf8");
}

test("the server entry runs the PLexus the release pins, in the project", () => {
  const release = thisRelease();
  assert.equal(release.plexus, JSON.parse(read(root, "package.json")).dependencies["@evref-bl/plexus"]);
  assert.deepEqual(serverCommand(release.plexus), ["npx", "--yes", `@evref-bl/plexus@${release.plexus}`, "mcp", "--project", "."]);
});

test("Codex gets a pharo table, after what the file already holds", () => {
  const table = '[mcp_servers.pharo]\ncommand = "npx"\nargs = ["--yes", "@evref-bl/plexus@9.9.9", "mcp", "--project", "."]\n';
  assert.equal(codexConfig("", command), table);
  assert.equal(codexConfig('model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n', command), `model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n${table}`);
});

test("Codex's pharo table gets the release's command where it was, its other settings kept", () => {
  const before = [
    'model = "o3"',
    "",
    '[mcp_servers."pharo"]',
    'command = "old"',
    "args = [",
    '  "mcp",',
    "]",
    "startup_timeout_sec = 60",
    "",
    "[profiles.fast]",
    'model = "o4"',
    "",
    "[mcp_servers.pharo.env]",
    'PLEXUS_HOME = "/elsewhere"',
    "",
  ].join("\n");
  const after = codexConfig(before, command);
  assert.equal(
    after,
    [
      'model = "o3"',
      "",
      '[mcp_servers."pharo"]',
      'command = "npx"',
      'args = ["--yes", "@evref-bl/plexus@9.9.9", "mcp", "--project", "."]',
      "startup_timeout_sec = 60",
      "",
      "[profiles.fast]",
      'model = "o4"',
      "",
      "[mcp_servers.pharo.env]",
      'PLEXUS_HOME = "/elsewhere"',
      "",
    ].join("\n"),
  );
  assert.equal(codexConfig(after, command), after);
});

test("Codex's pharo server in another form is left to the user", () => {
  for (const text of [
    'mcp_servers.pharo.command = "x"\n',
    'mcp_servers = { pharo = { command = "x" } }\n',
    '[mcp_servers]\npharo = { command = "x" }\n',
  ]) {
    assert.throws(() => codexConfig(text, command), Refusal, text);
  }
});

test("OpenCode gets the pharo server under mcp.servers, every other key kept", () => {
  assert.deepEqual(JSON.parse(openCodeConfig("", command)), {
    $schema: "https://opencode.ai/config.json",
    mcp: { servers: { pharo: { type: "local", command, codemode: false } } },
  });
  const edited = openCodeConfig('{\n    "model": "x",\n    "mcp": { "servers": { "other": { "type": "remote" } } }\n}\n', command);
  assert.deepEqual(JSON.parse(edited), {
    model: "x",
    mcp: { servers: { other: { type: "remote" }, pharo: { type: "local", command, codemode: false } } },
  });
  assert.match(edited, /^\{\n {4}"model"/);
});

test("OpenCode's older shape is kept where the file lists other servers that way", () => {
  assert.deepEqual(JSON.parse(openCodeConfig('{"mcp": {"other": {"type": "remote"}}}', command)).mcp, {
    other: { type: "remote" },
    pharo: { type: "local", command, enabled: true, codemode: false },
  });
  // An entry the README gave in that shape, alone, moves to the current one.
  assert.deepEqual(JSON.parse(openCodeConfig('{"mcp": {"pharo": {"type": "local", "command": ["old"]}}}', command)).mcp, {
    servers: { pharo: { type: "local", command, codemode: false } },
  });
});

test("OpenCode's pharo entry keeps what it set besides the command", () => {
  const earlier = '{"mcp": {"servers": {"pharo": {"type": "local", "command": ["old"], "timeout": 60, "codemode": true}}}}';
  const after = openCodeConfig(earlier, command);
  assert.deepEqual(JSON.parse(after).mcp.servers.pharo, { type: "local", command, timeout: 60, codemode: false });
  assert.equal(openCodeConfig(after, command), after);
});

test("an OpenCode configuration that is not plain JSON is left to the user, with the entry to add", () => {
  for (const text of ['{\n  // comment\n  "mcp": {}\n}', "[]", '{"mcp": []}', '{"mcp": {"servers": 1}}']) {
    assert.throws(() => openCodeConfig(text, command), (error) => error instanceof Refusal && error.message.includes('"pharo": {"type":"local"'), text);
  }
  assert.throws(() => codexConfig('mcp_servers.pharo.command = "x"\n', command), /\[mcp_servers\.pharo\]\ncommand = "npx"/);
});

test("install writes the skills and the server entry, and again the same", (t) => {
  const project = temporaryProject(t);
  fs.mkdirSync(path.join(project, ".agents/skills/mine"), { recursive: true });
  fs.writeFileSync(path.join(project, ".agents/skills/mine/SKILL.md"), "mine");

  const release = thisRelease();
  const first = install({ host: "codex", project });
  const skills = fs.readdirSync(release.skills).sort();
  assert.deepEqual(first.skills, skills);
  for (const name of skills) {
    assert.equal(read(project, `.agents/skills/${name}/SKILL.md`), read(release.skills, `${name}/SKILL.md`));
  }
  assert.deepEqual(JSON.parse(read(project, ".agents/skills/.pharo-agent.json")), { release: release.version, skills });
  assert.match(read(project, ".codex/config.toml"), new RegExp(`@evref-bl/plexus@${release.plexus.replaceAll(".", "\\.")}`));

  const again = install({ host: "codex", project });
  assert.deepEqual(again.removed, []);
  assert.equal(read(project, ".agents/skills/mine/SKILL.md"), "mine");
});

test("a later release removes the skills it no longer carries, and only those", (t) => {
  const project = temporaryProject(t);
  const release = (version, names) => {
    const skills = path.join(project, `release-${version}`);
    for (const name of names) {
      fs.mkdirSync(path.join(skills, name), { recursive: true });
      fs.writeFileSync(path.join(skills, name, "SKILL.md"), `${name} ${version}`);
    }
    return { version, plexus: "9.9.9", skills };
  };
  install({ host: "opencode", project, release: release("1.0.0", ["pharo-a", "pharo-b"]) });
  fs.mkdirSync(path.join(project, ".agents/skills/mine"));
  const later = install({ host: "opencode", project, release: release("1.1.0", ["pharo-b", "pharo-c"]) });

  assert.deepEqual(later.removed, ["pharo-a"]);
  assert.deepEqual(fs.readdirSync(path.join(project, ".agents/skills")).sort(), [".pharo-agent.json", "mine", "pharo-b", "pharo-c"]);
  assert.equal(read(project, ".agents/skills/pharo-b/SKILL.md"), "pharo-b 1.1.0");
});

test("a refusal writes nothing", (t) => {
  const project = temporaryProject(t);
  fs.writeFileSync(path.join(project, "opencode.json"), "{ not json");
  assert.throws(() => install({ host: "opencode", project }), Refusal);
  assert.deepEqual(fs.readdirSync(project), ["opencode.json"]);
  assert.equal(read(project, "opencode.json"), "{ not json");
});

test("the command installs, refuses, and reads its command line", (t) => {
  const project = temporaryProject(t);
  // Offline, the fetch of PLexus fails at once, and the install still succeeds.
  const env = { ...process.env, npm_config_offline: "true", npm_config_cache: path.join(project, ".npm-cache") };
  const run = (...args) =>
    spawnSync(process.execPath, [path.join(root, "bin/pharo-agent.js"), ...args], { cwd: project, encoding: "utf8", env });

  const installed = run("install", "--host", "OpenCode");
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /^Installed pharo-agent .* for OpenCode in /);
  assert.match(installed.stdout, /PLexus .* could not be fetched now/);
  assert.ok(fs.existsSync(path.join(project, "opencode.json")));

  assert.equal(run("install", "--host=codex").status, 0);
  assert.equal(run("--version").stdout.trim(), thisRelease().version);

  const claude = run("install", "--host", "claude");
  assert.equal(claude.status, 1);
  assert.match(claude.stderr, /marketplace/);

  for (const args of [[], ["setup"], ["install"], ["install", "--host"], ["install", "--host", "vscode"], ["install", "--dir", "."]]) {
    const unreadable = run(...args);
    assert.equal(unreadable.status, 2, args.join(" "));
    assert.match(unreadable.stderr, /Usage: pharo-agent install --host/);
  }
});
