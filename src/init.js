import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot, pluginDirectory } from "./project.js";

const managedStart = "<!-- pharo-agent:begin -->";
const managedEnd = "<!-- pharo-agent:end -->";

const hostGuide = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  opencode: "AGENTS.md",
};

function templateDirectory() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates");
}

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function updateManagedBlock(filePath, content) {
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const start = current.indexOf(managedStart);
  const end = current.indexOf(managedEnd);
  if ((start === -1) !== (end === -1) || (end !== -1 && end < start)) {
    throw new Error(`Cannot update incomplete pharo-agent block in ${filePath}`);
  }

  const block = `${managedStart}\n${content}\n${managedEnd}\n`;
  const updated = start === -1
    ? `${current}${current && !current.endsWith("\n") ? "\n" : ""}${block}`
    : `${current.slice(0, start)}${block}${current.slice(end + managedEnd.length).replace(/^\n?/, "")}`;
  fs.writeFileSync(filePath, updated);
}

function writeIfMissing(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}

function guidance() {
  return `# Pharo work\n\nWhen the task uses Pharo, read \`pharo.AGENTS.md\` before acting.\n`;
}

function pharoGuide() {
  return `# Pharo project guide\n\nUse \`pharo-agent open\` before live-image work and edit projected source under \`.pharo-agent/mounts\`. Use \`pharo-agent pharo list\` to inspect the complete live MCP tool surface and \`pharo-agent pharo <tool> [arguments-json]\` to call a tool. \`pharo-agent mcp\` is a command-scoped stdio bundle for MCP clients such as mcporter.\n\nImage, Tonel, Iceberg, disk Git, and host processes are separate states. Before source loading, version compatibility, image-to-Git handoff, CI reproduction, or recovery, read the matching skill in \`.pharo-agent/skills/\`.\n`;
}

export function initialize({ host, mountRoot, cwd = process.cwd() }) {
  const guideName = hostGuide[host];
  if (!guideName) {
    throw new Error("--host must be codex, claude, or opencode");
  }

  const projectRoot = findProjectRoot(cwd);
  const directory = pluginDirectory(projectRoot);
  const configPath = path.join(directory, "config.json");
  fs.mkdirSync(directory, { recursive: true });
  writeIfMissing(
    configPath,
    `${JSON.stringify({ mountRoot: mountRoot ?? ".pharo-agent/mounts" }, null, 2)}\n`,
  );
  writeIfMissing(path.join(directory, ".gitignore"), "mounts/\nruntime/\n");
  fs.writeFileSync(path.join(projectRoot, "pharo.AGENTS.md"), pharoGuide());
  copyDirectory(path.join(templateDirectory(), "skills"), path.join(directory, "skills"));
  updateManagedBlock(path.join(projectRoot, guideName), guidance());

  return { projectRoot, guideName };
}
