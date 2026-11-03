import fs from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error("Expected a release SemVer version.");
}

for (const file of ["package.json", "plugin.json", ".claude-plugin/plugin.json"]) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.version = version;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

const skill = "skills/pharo-setup/SKILL.md";
const content = fs.readFileSync(skill, "utf8");
const pattern = /(@evref-bl\/pharo-agent@)[^\s]+(?= init --host )/;
if (!pattern.test(content)) throw new Error("Setup skill has no pinned CLI version.");
const updated = content.replace(pattern, `$1${version}`);
fs.writeFileSync(skill, updated);

// The plugin's server runs the published package, so its pin moves with the
// release too.
const mcp = ".mcp.json";
const servers = JSON.parse(fs.readFileSync(mcp, "utf8"));
const args = servers.mcpServers?.image?.args ?? [];
const index = args.findIndex((argument) => argument.startsWith("@evref-bl/pharo-agent@"));
if (index === -1) throw new Error("Plugin MCP server has no pinned CLI version.");
args[index] = `@evref-bl/pharo-agent@${version}`;
fs.writeFileSync(mcp, `${JSON.stringify(servers, null, 2)}\n`);
