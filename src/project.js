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

// PLexus's rule for a scope. It holds no dash because the first dash of an
// image's directory name ends its scope: were `repo-fix` a scope, `repo`
// would list, stop and delete its images as its own.
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._]{0,63}$/;

/**
 * The scope a directory name gives: runs of characters a scope cannot hold
 * become one `_`, and what remains starts with a letter or a digit and fits
 * PLexus's 64 characters.
 */
export function scopeFromDirectory(projectRoot) {
  const sanitized = path.basename(path.resolve(projectRoot))
    .replace(/[^A-Za-z0-9._]+/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64)
    .replace(/_+$/, "");
  return sanitized || "default";
}

/**
 * The scope that tells this project's images from every other's in PLexus's
 * one store: the config's, pinned at init so that renaming the directory
 * does not leave the images behind, or the directory's when it has none.
 */
export function projectScope(projectRoot, config = readConfig(projectRoot)) {
  if (config.scope === undefined) return scopeFromDirectory(projectRoot);
  // An empty scope reaches PLexus as none, which is every image of every
  // project, so a scope the config gets wrong stops here.
  if (typeof config.scope !== "string" || !scopePattern.test(config.scope)) {
    throw new Error(
      `The scope ${JSON.stringify(config.scope)} in ${configPath(projectRoot)} is not valid: `
        + "use 1 to 64 letters, digits, dots or underscores, starting with a letter or a digit, "
        + "or remove it to use the one the directory's name gives.",
    );
  }
  return config.scope;
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
