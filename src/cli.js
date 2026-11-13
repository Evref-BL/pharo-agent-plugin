import { hostChoices, hostList } from "./hosts.js";
import { usage } from "./help.js";
import { initialize } from "./init.js";
import {
  createImage,
  deleteImage,
  listImageTemplates,
  listImages,
  useImage,
} from "./images.js";
import { callImageTool, imageTarget, listImageTools, toolContract } from "./gateway.js";
import { serveImagesMcp } from "./mcpServer.js";
import { startAgentImage, stopAgentImage } from "./live.js";
import { findProjectRoot } from "./project.js";
import {
  isToolName,
  resultText,
  toolArguments,
  toolListing,
  toolUsage,
} from "./toolCommand.js";

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

/**
 * The template is required, and the loop below refuses the call without one,
 * which the dynamic key assignment hides from the typechecker.
 *
 * @returns {{ name: string, options: { template: string, category?: string, script?: string, everyStart?: boolean } }}
 */
function parseImageCreate(args) {
  const [name, ...rest] = args;
  if (!name || name.startsWith("--")) {
    throw new Error("image create requires an image name");
  }
  /** @type {{ template?: string, category?: string, script?: string, everyStart?: boolean }} */
  const options = {};
  const valued = {
    "--template": "template",
    "--category": "category",
    "--script": "script",
  };
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === "--every-start") {
      options.everyStart = true;
      continue;
    }
    const key = valued[option];
    if (!key) {
      throw new Error(`Unknown image create option: ${option}`);
    }
    const value = rest[index + 1];
    if (!value) {
      throw new Error(`${option} requires a value`);
    }
    options[key] = value;
    index += 1;
  }
  if (!options.template) {
    throw new Error("image create requires --template <name>");
  }
  if (options.everyStart && !options.script) {
    throw new Error("--every-start files in the --script <file> at every start, and needs one");
  }
  return { name, options: { ...options, template: options.template } };
}

// `image start` and `image stop` name their subject, like `image use` and
// `image delete`; `--image` stays on the commands that scope a call.
function parseImageStart(args) {
  let display;
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--display") {
      rest.push(args[index]);
      continue;
    }
    display = args[index + 1];
    if (display !== "headless" && display !== "interactive") {
      throw new Error("--display is headless or interactive");
    }
    index += 1;
  }
  const [name, ...extra] = rest;
  if (extra.length > 0 || (name && name.startsWith("--"))) {
    throw new Error("image start takes one image name and --display");
  }
  return { name, options: display ? { display } : {} };
}

function parseImageStop(args) {
  const all = args.includes("--all");
  const [name, ...extra] = args.filter((value) => value !== "--all");
  if (extra.length > 0 || (name && name.startsWith("--"))) {
    throw new Error("image stop takes one image name or --all");
  }
  return { name, all };
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

function requireNoArguments(command, args) {
  if (args.length > 0) {
    throw new Error(`${command} does not accept arguments`);
  }
}

// A tool the image answered with an error is still an answer: the MCP result
// carries the Pharo exception, and a caller wants to read it. Print it as
// always, and report the failure in the exit status too, so `set -e` and
// subprocess.run(check=True) do not read a failed load as a success.
export function exitCodeForToolResult(result) {
  return result?.isError === true ? 1 : 0;
}

function takeFlag(args, flag) {
  return { present: args.includes(flag), rest: args.filter((value) => value !== flag) };
}

// `pharo-agent <tool> ...`: the answer's text for a reader, or the MCP result
// with --json. Its schema is fetched only when the words need reading.
// The MCP server's own tools manage images; from the shell they are the
// image commands, which an agent that knows the server may not have read.
const lifecycleTools = new Set([
  "image_templates",
  "image_create",
  "image_list",
  "image_start",
  "image_stop",
  "image_delete",
]);

async function runTool([toolName, ...words]) {
  if (lifecycleTools.has(toolName)) {
    throw new Error(`${toolName} is pharo-agent image ${toolName.slice("image_".length)} here.`);
  }
  const { image, rest: withoutImage } = takeImageOption(words);
  const json = takeFlag(withoutImage, "--json");
  const help = takeFlag(json.rest, "--help");
  if (help.present) {
    // Help answers before a project or image exists; only the tool's own
    // arguments need its image.
    try {
      const target = await imageTarget(findProjectRoot(), image);
      console.log(toolUsage(await toolContract(target, toolName)));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`${usage(["<tool>"])}\n\n${toolName}'s own arguments come from a running image: ${reason}`);
    }
    return 0;
  }
  const target = await imageTarget(findProjectRoot(), image);
  const argumentsValue = help.rest.length === 0 ? {}
    : toolArguments(toolName, help.rest, (await toolContract(target, toolName)).inputSchema);
  const result = await callImageTool(target, toolName, argumentsValue);
  console.log(json.present ? JSON.stringify(result, null, 2) : resultText(result));
  return exitCodeForToolResult(result);
}

async function listTools(words) {
  const { image, rest: withoutImage } = takeImageOption(words);
  const json = takeFlag(withoutImage, "--json");
  requireNoArguments("list", json.rest);
  const tools = await listImageTools(await imageTarget(findProjectRoot(), image));
  console.log(json.present ? JSON.stringify(tools, null, 2) : toolListing(tools));
}

async function runImageCommand(projectRoot, subcommand, args) {
  if (subcommand === "templates") {
    requireNoArguments("image templates", args);
    return listImageTemplates(projectRoot);
  }
  if (subcommand === "create") {
    const { name, options } = parseImageCreate(args);
    return createImage(projectRoot, name, options);
  }
  if (subcommand === "list") {
    requireNoArguments("image list", args);
    return listImages(projectRoot);
  }
  if (subcommand === "start") {
    const { name, options } = parseImageStart(args);
    return startAgentImage(projectRoot, name, options);
  }
  if (subcommand === "stop") {
    const { name, all } = parseImageStop(args);
    return stopAgentImage(projectRoot, name, { all });
  }
  if (subcommand === "use" || subcommand === "delete") {
    const [name, ...extra] = args;
    if (!name || name.startsWith("--") || extra.length > 0) {
      throw new Error(`image ${subcommand} requires one image name`);
    }
    return subcommand === "use" ? useImage(projectRoot, name) : deleteImage(projectRoot, name);
  }
  throw new Error(`Unsupported image command: ${subcommand ?? ""}\n${usage(["image"])}`);
}

export async function main(args) {
  const [command, ...rest] = args;
  // A snake_case word is an image tool; its own --help reads the tool's
  // schema, and the word help is a value it may take, not a request for
  // the CLI's usage.
  if (command && isToolName(command)) {
    return runTool(args);
  }
  // A caller reaching for help is asking the same question wherever the word
  // lands, and `image create --help` answering that it needs an image name is
  // no answer at all.
  if (!command || args.some((value) => value === "--help" || value === "help")) {
    console.log(usage(args.filter((value) => value !== "--help" && value !== "help")));
    return;
  }
  if (command === "init") {
    const result = initialize(parseInit(rest));
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  // Above the project lookup on purpose: a host starts this in whatever
  // directory it likes, which may hold no project at all, and a server that
  // exits is a broken server in the host's list. It resolves a project per
  // request instead, so the reason reaches whoever calls a tool.
  if (command === "mcp") {
    const { image: mcpImage, rest: mcpArgs } = takeImageOption(rest);
    requireNoArguments(command, mcpArgs);
    await serveImagesMcp(findProjectRoot, mcpImage);
    return;
  }
  if (command === "list") {
    await listTools(rest);
    return;
  }
  if (command === "image") {
    const [subcommand, ...imageArgs] = rest;
    const answer = await runImageCommand(findProjectRoot(), subcommand, imageArgs);
    console.log(JSON.stringify({ ok: true, ...answer }, null, 2));
    return;
  }
  throw new Error(`Unsupported command: ${command}\n${usage()}`);
}
