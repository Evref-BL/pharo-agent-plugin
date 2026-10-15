import fs from "node:fs";
import path from "node:path";

export function findProjectRoot(start = process.cwd()) {
  let directory = path.resolve(start);

  while (true) {
    if (fs.existsSync(path.join(directory, "plexus.project.json"))) {
      return directory;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("No plexus.project.json found above the current directory");
    }
    directory = parent;
  }
}

export function pluginDirectory(projectRoot) {
  return path.join(projectRoot, ".pharo-agent");
}
