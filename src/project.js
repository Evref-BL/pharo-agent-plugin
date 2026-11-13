import fs from "node:fs";
import path from "node:path";

export function pluginDirectory(projectRoot) {
  return path.join(projectRoot, ".pharo-agent");
}

export function configPath(projectRoot) {
  return path.join(pluginDirectory(projectRoot), "config.json");
}

function projectRootAbove(start) {
  let directory = path.resolve(start);

  while (true) {
    if (fs.existsSync(configPath(directory))) {
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

  throw new Error(
    "No .pharo-agent/config.json found above the current directory. "
      + "Run pharo-agent init --host <host> in the project root.",
  );
}

export function enclosingProjectRoot(start) {
  const directory = path.resolve(start);
  const parent = path.dirname(directory);
  if (parent === directory) return undefined;
  return projectRootAbove(parent);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  }
}

export function readConfig(projectRoot) {
  const filePath = configPath(projectRoot);
  if (!fs.existsSync(filePath)) return {};
  return readJson(filePath);
}

export function writeConfig(projectRoot, config) {
  fs.mkdirSync(pluginDirectory(projectRoot), { recursive: true });
  fs.writeFileSync(configPath(projectRoot), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * The scope a directory name gives: runs of characters a PLexus name cannot
 * hold become one `-`, and what remains starts with a letter or a digit and
 * fits PLexus's 64 characters.
 */
export function scopeFromDirectory(projectRoot) {
  const sanitized = path.basename(path.resolve(projectRoot))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return sanitized || "default";
}

// PLexus keeps every image in one store and tells a project's images from
// the rest by this prefix alone, so it is pinned in the config: renaming the
// directory must not leave the project's images behind under the old name.
export function projectScope(projectRoot, config = readConfig(projectRoot)) {
  return typeof config.scope === "string" ? config.scope : scopeFromDirectory(projectRoot);
}

/** The image a command names, or the project's default when it names none. */
export function resolveImageName(projectRoot, name) {
  if (name !== undefined) return name;
  const defaultImage = readConfig(projectRoot).defaultImage;
  if (typeof defaultImage === "string") return defaultImage;
  throw new Error(
    "No image is named, and this project has no default image. Name one, choose "
      + "a default with pharo-agent image use <name>, or create one with "
      + "pharo-agent image create <name> --template <template>; the first image "
      + "created becomes the default.",
  );
}
