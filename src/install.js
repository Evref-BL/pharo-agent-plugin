import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Hosts that read the skills and a server entry from the project, not from a plugin. */
export const hosts = {
  codex: { name: "Codex", configs: [".codex/config.toml"], edit: codexConfig },
  opencode: { name: "OpenCode", configs: ["opencode.json", "opencode.jsonc"], edit: openCodeConfig },
};

/** Where both hosts read a project's skills. */
export const skillsDirectory = ".agents/skills";

/** The record of what an install wrote among the skills, read by the next one. */
export const recordFile = ".pharo-agent.json";

/** An install that would change something it should not, said before anything is written. */
export class Refusal extends Error {}

/** This release: its version, the PLexus it pins, and the skills it carries. */
export function thisRelease(root = packageRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return {
    version: manifest.version,
    plexus: manifest.dependencies["@evref-bl/plexus"],
    skills: path.join(root, "skills"),
  };
}

/** The command that serves the project's images, with the PLexus a release pins. */
export function serverCommand(plexus) {
  return ["npx", "--yes", `@evref-bl/plexus@${plexus}`, "mcp", "--project", "."];
}

/**
 * Writes the release's skills and the `pharo` server entry into the project
 * for a host. Everything is read and checked first, so a refusal writes
 * nothing.
 */
export function install({ host, project, release = thisRelease() }) {
  const target = hosts[host];
  if (target === undefined) {
    throw new Refusal(`Unknown host ${host}.`);
  }

  const config = configFile(project, target);
  const configured = target.edit(config.text, serverCommand(release.plexus), config.relative);

  const skillsRoot = path.join(project, skillsDirectory);
  const recordPath = path.join(skillsRoot, recordFile);
  const before = readRecord(recordPath);
  const skills = fs
    .readdirSync(release.skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(release.skills, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
  const removed = before.skills.filter((name) => !skills.includes(name) && isSkillName(name));

  for (const name of removed) {
    fs.rmSync(path.join(skillsRoot, name), { recursive: true, force: true });
  }
  for (const name of skills) {
    const destination = path.join(skillsRoot, name);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(path.join(release.skills, name), destination, { recursive: true });
  }
  fs.writeFileSync(recordPath, `${JSON.stringify({ release: release.version, skills }, null, 2)}\n`);

  fs.mkdirSync(path.dirname(config.path), { recursive: true });
  fs.writeFileSync(config.path, configured);

  return { host: target.name, release, skills, removed, config: config.relative };
}

/** The host's project configuration: the first that exists, else the first it reads. */
function configFile(project, target) {
  const relative = target.configs.find((name) => fs.existsSync(path.join(project, name))) ?? target.configs[0];
  const file = path.join(project, relative);
  return { relative, path: file, text: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "" };
}

function readRecord(file) {
  if (!fs.existsSync(file)) {
    return { skills: [] };
  }
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(record.skills) && record.skills.every((name) => typeof name === "string")) {
      return record;
    }
  } catch {
    // Said below, as for a record of the wrong shape.
  }
  throw new Refusal(
    `${path.join(skillsDirectory, recordFile)} does not say which skills an earlier install wrote: delete it, and any of those skills, then install again.`,
  );
}

/** A skill directory's name, never a path, so a record cannot remove anything else. */
function isSkillName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

const tableHeader = /^\s*\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?$/;

/** A TOML table name with its quotes and the spaces around its dots dropped. */
function tableName(header) {
  return header.replace(/\s*\.\s*/g, ".").replace(/["']/g, "");
}

/**
 * Codex's configuration with the `[mcp_servers.pharo]` table, and its own
 * subtables, replaced by one running `command`, in place, or appended.
 */
export function codexConfig(text, command, file = ".codex/config.toml") {
  const lines = text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const block = codexTable(command).split("\n");

  // The table's command and args give way to the release's, written under its
  // header; its other keys and its subtables, such as env, stay.
  const kept = [];
  let table = "";
  let main = false;
  let found = false;
  let inArray = false;
  for (const line of lines) {
    if (inArray) {
      inArray = !/\]\s*(?:#.*)?$/.test(line);
      continue;
    }
    const header = line.match(tableHeader);
    if (header && !line.trimStart().startsWith("[[")) {
      table = tableName(header[1]);
      main = table === "mcp_servers.pharo" && !found;
      kept.push(line);
      if (main) {
        kept.push(...block.slice(1));
        found = true;
      }
      continue;
    }
    if (main && /^\s*["']?(?:command|args)["']?\s*=/.test(line)) {
      inArray = /^\s*["']?args["']?\s*=\s*\[/.test(line) && !/\]\s*(?:#.*)?$/.test(line);
      continue;
    }
    // A `pharo` server written as dotted keys or an inline table is not one
    // this edits.
    const dotted = table === "" && /^\s*["']?mcp_servers["']?\s*(\.\s*["']?pharo["']?|=.*\bpharo\b)/.test(line);
    const inTable = table === "mcp_servers" && /^\s*["']?pharo["']?\s*[.=]/.test(line);
    if (dotted || inTable) {
      throw new Refusal(
        `${file} defines the pharo server in a form this does not edit. Replace it with this table, then install again:\n\n${codexTable(command)}`,
      );
    }
    kept.push(line);
  }
  if (!found) {
    kept.push(...(kept.length > 0 && kept.at(-1).trim() !== "" ? [""] : []), ...block);
  }
  while (kept.length > 0 && kept.at(-1).trim() === "") kept.pop();
  return `${kept.join("\n")}\n`;
}

function codexTable(command) {
  const args = command.slice(1).map((arg) => JSON.stringify(arg));
  return `[mcp_servers.pharo]\ncommand = ${JSON.stringify(command[0])}\nargs = [${args.join(", ")}]`;
}

/**
 * OpenCode's configuration with its `pharo` server running `command`, under
 * `mcp.servers`, or directly under `mcp` where the file already lists its
 * servers that older way. Every other key is kept, the entry's own included.
 */
export function openCodeConfig(text, command, file = "opencode.json") {
  const byHand = (why) =>
    new Refusal(
      `${file} ${why}. Add the pharo server to its "mcp" "servers" yourself:\n\n"pharo": ${JSON.stringify(openCodeEntry(undefined, command))}`,
    );
  let config;
  try {
    config = text.trim() === "" ? { $schema: "https://opencode.ai/config.json" } : JSON.parse(text);
  } catch {
    throw byHand("is not plain JSON, which this edits");
  }
  if (!isObject(config) || (config.mcp !== undefined && !isObject(config.mcp))) {
    throw byHand("does not hold a configuration this edits");
  }

  const mcp = config.mcp ?? {};
  const older = mcp.servers === undefined && Object.keys(mcp).some((key) => key !== "pharo");
  if (older) {
    mcp.pharo = { ...openCodeEntry(mcp.pharo, command), enabled: true };
  } else {
    if (mcp.servers !== undefined && !isObject(mcp.servers)) {
      throw byHand("has an mcp.servers this does not edit");
    }
    const entry = openCodeEntry(mcp.servers?.pharo ?? mcp.pharo, command);
    delete mcp.pharo;
    mcp.servers = { ...mcp.servers, pharo: entry };
  }
  config.mcp = mcp;
  return `${JSON.stringify(config, null, indentation(text))}\n`;
}

/** The pharo entry running `command`, with what an earlier one set besides. */
function openCodeEntry(earlier, command) {
  const { type, command: _command, codemode, enabled, ...rest } = isObject(earlier) ? earlier : {};
  return { type: "local", command, ...rest, codemode: false };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The indentation a JSON file already uses, two spaces otherwise. */
function indentation(text) {
  return text.match(/\n([ \t]+)"/)?.[1] ?? 2;
}
