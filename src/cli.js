import { initialize } from "./init.js";
import { callActiveTool, listActiveTools, serveActiveMcp } from "./gateway.js";
import { closeAgentImage, openAgentImage } from "./live.js";
import { findProjectRoot } from "./project.js";
import { readActive } from "./runtime.js";

function parseInit(args) {
  let host;
  let mountRoot;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--host" || option === "--mount-root") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`${option} requires a value`);
      }
      if (option === "--host") host = value;
      else mountRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown init option: ${option}`);
  }
  if (!host) throw new Error("init requires --host <codex|claude|opencode>");
  return { host, mountRoot };
}

function usage() {
  return [
    "Usage:",
    "  pharo-agent init --host <codex|claude|opencode> [--mount-root <path>]",
    "  pharo-agent open",
    "  pharo-agent status",
    "  pharo-agent close",
    "  pharo-agent mcp",
    "  pharo-agent pharo list",
    "  pharo-agent pharo <tool> [arguments-json]",
  ].join("\n");
}

function requireNoArguments(command, args) {
  if (args.length > 0) {
    throw new Error(`${command} does not accept arguments`);
  }
}

function parseToolArguments(value) {
  if (value === undefined) return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Tool arguments must be a JSON object.");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed;
}

export async function main(args) {
  const [command, ...rest] = args;
  if (command === "init") {
    const result = initialize(parseInit(rest));
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  const projectRoot = findProjectRoot();
  if (command === "open") {
    requireNoArguments(command, rest);
    console.log(JSON.stringify({ ok: true, ...(await openAgentImage(projectRoot)) }, null, 2));
    return;
  }
  if (command === "close") {
    requireNoArguments(command, rest);
    console.log(JSON.stringify({ ok: true, ...(await closeAgentImage(projectRoot)) }, null, 2));
    return;
  }
  if (command === "status") {
    requireNoArguments(command, rest);
    console.log(JSON.stringify({ ok: true, ...readActive(projectRoot) }, null, 2));
    return;
  }
  if (command === "mcp") {
    requireNoArguments(command, rest);
    await serveActiveMcp(projectRoot, readActive(projectRoot));
    return;
  }
  if (command === "pharo") {
    const [toolName, argumentsJson, ...extra] = rest;
    if (toolName === "list") {
      if (argumentsJson || extra.length > 0) throw new Error("pharo list does not accept arguments");
      console.log(JSON.stringify(await listActiveTools(projectRoot, readActive(projectRoot)), null, 2));
      return;
    }
    if (!toolName || extra.length > 0) {
      throw new Error("pharo requires one tool name and an optional JSON object");
    }
    console.log(JSON.stringify(await callActiveTool(
      projectRoot,
      readActive(projectRoot),
      toolName,
      parseToolArguments(argumentsJson),
    ), null, 2));
    return;
  }
  if (!command || command === "--help" || command === "help") {
    console.log(usage());
    return;
  }
  throw new Error(`Unsupported command: ${command}\n${usage()}`);
}
