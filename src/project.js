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

export function configuredActiveImageId(projectRoot) {
  const configPath = path.join(projectRoot, "plexus.project.json");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${configPath}: ${error.message}`);
  }
  const images = Array.isArray(config.images) ? config.images.filter((image) => image?.active) : [];
  if (images.length !== 1 || typeof images[0].id !== "string") {
    throw new Error(
      `pharo-agent needs exactly one active image in plexus.project.json; found ${images.length}.`,
    );
  }
  return images[0].id;
}
