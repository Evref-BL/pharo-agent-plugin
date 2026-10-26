import { hostChoices, hostList } from "./hosts.js";
import { initialize } from "./init.js";
import { addImage, listImages, removeImage, useImage } from "./images.js";
import { callImageTool, listImageTools, serveImagesMcp } from "./gateway.js";
import {
  agentImageStatus,
  closeAgentImage,
  listImageTemplates,
  openAgentImage,
} from "./live.js";
import { findProjectRoot } from "./project.js";
import { readOpenImage } from "./runtime.js";

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
  if (!host) throw new Error(`init requires --host <${hostChoices()}>`);
  return { host, mountRoot };
}

function parseImageAdd(args) {
  const [id, ...rest] = args;
  if (!id || id.startsWith("--")) {
    throw new Error("image add requires an image id");
  }
  const parsed = { id };
  const options = {
    "--template": "template",
    "--category": "category",
    "--profile": "profile",
  };
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    const key = options[option];
    if (!key) {
      throw new Error(`Unknown image add option: ${option}`);
    }
    const value = rest[index + 1];
    if (!value) {
      throw new Error(`${option} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  if (!parsed.template) {
    throw new Error("image add requires --template <name>");
  }
  return parsed;
}

function takeImageOption(args) {
  const index = args.indexOf("--image");
  if (index === -1) return { image: undefined, rest: args };
  const image = args[index + 1];
  if (!image) {
    throw new Error("--image requires a value");
  }
  return { image, rest: [...args.slice(0, index), ...args.slice(index + 2)] };
}

function usage() {
  return [
    "Usage:",
    `  pharo-agent init --host <${hostChoices()}> [--mount-root <path>]`,
    "  pharo-agent image list",
    "  pharo-agent image templates",
    "  pharo-agent image add <id> --template <name> [--category <name>] [--profile <id>]",
    "  pharo-agent image use <id>",
    "  pharo-agent image remove <id>",
    "  pharo-agent open [--image <id>]",
    "  pharo-agent status",
    "  pharo-agent close [--image <id>]",
    "  pharo-agent mcp [--image <id>]",
    "  pharo-agent pharo list [--image <id>]",
    "  pharo-agent pharo <tool> [arguments-json] [--image <id>]",
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

// A tool the image answered with an error is still an answer: the MCP result
// carries the Pharo exception, and a caller wants to read it. Print it as
// always, and report the failure in the exit status too, so `set -e` and
// subprocess.run(check=True) do not read a failed load as a success.
export function exitCodeForToolResult(result) {
  return result?.isError === true ? 1 : 0;
}

export async function main(args) {
  const [command, ...rest] = args;
  // A caller reaching for help is asking the same question wherever the word
  // lands, and `image add --help` answering that it needs an image id is no
  // answer at all.
  if (!command || args.some((value) => value === "--help" || value === "help")) {
    console.log(usage());
    return;
  }
  if (command === "init") {
    const result = initialize(parseInit(rest));
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  const projectRoot = findProjectRoot();
  if (command === "image") {
    const [subcommand, ...imageArgs] = rest;
    if (subcommand === "list") {
      requireNoArguments("image list", imageArgs);
      console.log(JSON.stringify({ ok: true, ...listImages(projectRoot) }, null, 2));
      return;
    }
    if (subcommand === "templates") {
      requireNoArguments("image templates", imageArgs);
      console.log(JSON.stringify(
        { ok: true, ...(await listImageTemplates(projectRoot)) },
        null,
        2,
      ));
      return;
    }
    if (subcommand === "add") {
      console.log(JSON.stringify({ ok: true, ...addImage(projectRoot, parseImageAdd(imageArgs)) }, null, 2));
      return;
    }
    if (subcommand === "use" || subcommand === "remove") {
      const [id, ...extra] = imageArgs;
      if (!id || extra.length > 0) {
        throw new Error(`image ${subcommand} requires one image id`);
      }
      const result = subcommand === "use" ? useImage(projectRoot, id) : removeImage(projectRoot, id);
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    throw new Error(`Unsupported image command: ${subcommand ?? ""}\n${usage()}`);
  }
  const { image, rest: commandArgs } = takeImageOption(rest);
  if (command === "open") {
    requireNoArguments(command, commandArgs);
    console.log(JSON.stringify({ ok: true, ...(await openAgentImage(projectRoot, image)) }, null, 2));
    return;
  }
  if (command === "close") {
    requireNoArguments(command, commandArgs);
    console.log(JSON.stringify({ ok: true, ...(await closeAgentImage(projectRoot, image)) }, null, 2));
    return;
  }
  if (command === "status") {
    requireNoArguments(command, commandArgs);
    if (image) {
      throw new Error("status reports every open image and does not accept --image");
    }
    console.log(JSON.stringify({ ok: true, ...agentImageStatus(projectRoot) }, null, 2));
    return;
  }
  if (command === "mcp") {
    requireNoArguments(command, commandArgs);
    await serveImagesMcp(projectRoot, image);
    return;
  }
  if (command === "pharo") {
    const [toolName, argumentsJson, ...extra] = commandArgs;
    if (toolName === "list") {
      if (argumentsJson || extra.length > 0) throw new Error("pharo list does not accept arguments");
      console.log(JSON.stringify(
        await listImageTools(projectRoot, readOpenImage(projectRoot, image)),
        null,
        2,
      ));
      return;
    }
    if (!toolName || extra.length > 0) {
      throw new Error("pharo requires one tool name and an optional JSON object");
    }
    const result = await callImageTool(
      projectRoot,
      readOpenImage(projectRoot, image),
      toolName,
      parseToolArguments(argumentsJson),
    );
    console.log(JSON.stringify(result, null, 2));
    return exitCodeForToolResult(result);
  }
  throw new Error(`Unsupported command: ${command}\n${usage()}`);
}
