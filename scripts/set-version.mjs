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
