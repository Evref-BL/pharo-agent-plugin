import fs from "node:fs";
import path from "node:path";

export const projectConfigFileName = "plexus.json";

function projectRootAbove(start) {
  let directory = path.resolve(start);

  while (true) {
    if (fs.existsSync(path.join(directory, projectConfigFileName))) {
      return directory;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

export function findProjectRoot(start = process.cwd()) {
  const found = projectRootAbove(start);
  if (found) return found;

  // A plugin's MCP server is started by the host, in the plugin's own
  // directory rather than the project's, so the working directory leads
  // nowhere. The host says where the project is, and that is only consulted
  // here, after the ordinary search has failed, so running the CLI inside a
  // project still answers with that project.
  const hosted = process.env.CLAUDE_PROJECT_DIR;
  const hostedRoot = hosted ? projectRootAbove(hosted) : undefined;
  if (hostedRoot) return hostedRoot;

  throw new Error("No plexus.json found above the current directory");
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
