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

// Each skill names the release it ships with: the setup skill to install the
// matching CLI, the feedback skill to say which release a report is about.
for (const { skill, pattern, missing } of [
  {
    skill: "skills/pharo-setup/SKILL.md",
    pattern: /(@evref-bl\/pharo-agent@)[^\s]+(?= init --host )/,
    missing: "Setup skill has no pinned CLI version.",
  },
  {
    skill: "skills/pharo-feedback/SKILL.md",
    pattern: /(`pharo-agent )[^`]+(?=`)/,
    missing: "Feedback skill names no release.",
  },
]) {
  const content = fs.readFileSync(skill, "utf8");
  if (!pattern.test(content)) throw new Error(missing);
  fs.writeFileSync(skill, content.replace(pattern, `$1${version}`));
}
