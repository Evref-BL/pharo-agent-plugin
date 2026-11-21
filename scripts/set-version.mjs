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

// The marketplace installs the release's tag, which the release workflow
// creates once this version reaches main, so an install never serves main.
const marketplaceFile = ".claude-plugin/marketplace.json";
const marketplace = JSON.parse(fs.readFileSync(marketplaceFile, "utf8"));
for (const plugin of marketplace.plugins) {
  if (typeof plugin.source !== "object" || plugin.source.ref === undefined) {
    throw new Error(`${marketplaceFile} does not install ${plugin.name} from a tag.`);
  }
  plugin.source.ref = `v${version}`;
}
fs.writeFileSync(marketplaceFile, `${JSON.stringify(marketplace, null, 2)}\n`);

// The feedback skill says which release a report is about.
const skill = "skills/pharo-feedback/SKILL.md";
const pattern = /(`pharo-agent )[^`]+(?=`)/;
const content = fs.readFileSync(skill, "utf8");
if (!pattern.test(content)) throw new Error("Feedback skill names no release.");
fs.writeFileSync(skill, content.replace(pattern, `$1${version}`));
