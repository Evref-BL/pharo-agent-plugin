import fs from "node:fs";

// The README links PLexus's documentation as of the release the plugin pins,
// and any command it gives runs that release.
const plexus = JSON.parse(fs.readFileSync("package.json", "utf8")).dependencies["@evref-bl/plexus"];
const readme = fs.readFileSync("README.md", "utf8");
fs.writeFileSync(
  "README.md",
  readme
    .replaceAll(/(Evref-BL\/PLexus\/(?:blob|tree)\/)[^/\s)]+/g, `$1v${plexus}`)
    .replaceAll(/(@evref-bl\/plexus@)[^"\s]+/g, `$1${plexus}`),
);
