import fs from "node:fs";
import path from "node:path";

export const projectConfigFileName = "plexus.project.json";

export function findProjectRoot(start = process.cwd()) {
  let directory = path.resolve(start);

  while (true) {
    if (fs.existsSync(path.join(directory, projectConfigFileName))) {
      return directory;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("No plexus.project.json found above the current directory");
    }
    directory = parent;
  }
}

export function enclosingProjectRoot(start) {
  const directory = path.resolve(start);
  const parent = path.dirname(directory);
  if (parent === directory) return undefined;
  try {
    return findProjectRoot(parent);
  } catch {
    return undefined;
  }
}

export function projectConfigPath(projectRoot) {
  return path.join(projectRoot, projectConfigFileName);
}

export function pluginDirectory(projectRoot) {
  return path.join(projectRoot, ".pharo-agent");
}

export function projectIdentity(projectRoot) {
  const name = path.basename(path.resolve(projectRoot));
  const id = name
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .toLowerCase();
  return { id: id || "pharo-project", name };
}

export function readProjectConfig(projectRoot) {
  const configPath = projectConfigPath(projectRoot);
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${configPath}: ${error.message}`);
  }
}

export function writeProjectConfig(projectRoot, config) {
  fs.writeFileSync(projectConfigPath(projectRoot), `${JSON.stringify(config, null, 2)}\n`);
}

export function createProjectConfig(projectRoot) {
  const { id, name } = projectIdentity(projectRoot);
  const config = { id, name, images: [] };
  writeProjectConfig(projectRoot, config);
  return config;
}

export function configuredImages(projectRoot) {
  const config = readProjectConfig(projectRoot);
  return Array.isArray(config.images) ? config.images : [];
}
