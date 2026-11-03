import fs from "node:fs";
import path from "node:path";
// The config file is PLexus's, so its name and its path come from PLexus.
// Spelling them here made this package a second definition of another
// package's format, free to drift from it without anything noticing.
import {
  createProjectConfigFile,
  loadProjectConfig,
  plexusProjectConfigFileName,
  projectConfigPath as plexusProjectConfigPath,
} from "@evref-bl/plexus";

export const projectConfigFileName = plexusProjectConfigFileName;

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
  return plexusProjectConfigPath(projectRoot);
}

export function pluginDirectory(projectRoot) {
  return path.join(projectRoot, ".pharo-agent");
}

// Validated, not merely parsed: a malformed plexus.json then fails naming
// what is wrong with it, rather than reaching PLexus as a shape it refuses
// further in.
export function readProjectConfig(projectRoot) {
  return loadProjectConfig(projectRoot);
}

export function createProjectConfig(projectRoot) {
  return createProjectConfigFile(projectRoot, {
    name: path.basename(path.resolve(projectRoot)),
  });
}

export function configuredImages(projectRoot) {
  return readProjectConfig(projectRoot).images;
}
