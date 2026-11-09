import { hostChoices, hostIds } from "./hosts.js";

const commands = {
  init: {
    usage: `init --host <${hostChoices()}> [--mount-root <path>]`,
    description: "Write this project's Pharo guide, skills and references for the host. Re-run to refresh\n"
      + "them. --mount-root sets where sources mount, .pharo-agent/mounts by default.",
    example: `init --host ${hostIds[0]}`,
  },
  "image list": {
    usage: "image list",
    description: "List the declared images, the default, and the mount and port of each running one.",
    example: "image list",
  },
  "image templates": {
    usage: "image templates",
    description: "List the templates images can be made from, with their categories.",
    example: "image templates",
  },
  "image add": {
    usage: "image add <id> --template <name> [--category <name>] [--profile <id>]",
    description: "Declare an image; image start creates it. Name it after what it is for, like a branch.\n"
      + "The first declared image is the default. --category is for a name two categories offer.",
    example: "image add pretty-print-formatter --template '<template name>'",
  },
  "image use": {
    usage: "image use <id>",
    description: "Make an image the default.",
    example: "image use dev",
  },
  "image remove": {
    usage: "image remove <id>",
    description: "Drop an image's declaration. Stop it first; its files are kept.",
    example: "image remove dev",
  },
  "image start": {
    usage: "image start [<id>]",
    description: "Create if needed and start an image, the default one without an id. Others keep running.\n"
      + "On macOS with fuse-t its source mounts as files.",
    example: "image start dev",
  },
  "image stop": {
    usage: "image stop [<id>] [--all]",
    description: "Stop an image and its source mount, the default one without an id, or --all of them.",
    example: "image stop dev",
  },
  mcp: {
    usage: "mcp [--image <id>]",
    description: "Serve this project's images as a stdio MCP server, as the plugin does for a host.",
    example: "mcp --image dev",
  },
  "pharo list": {
    usage: "pharo list [--image <id>]",
    description: "List a running image's advertised tools. tool_search and tool_get find the rest.",
    example: "pharo list",
  },
  pharo: {
    usage: "pharo <tool> [arguments-json] [--image <id>]",
    description: "Call a tool in a running image with a JSON object of arguments, {} by default.\n"
      + "Read its schema with tool_get first.",
    example: 'pharo tool_get \'{"name":"class_search"}\'',
  },
};

export function usage(args = []) {
  const key = ["image", "pharo"].includes(args[0]) && args[1]
    ? `${args[0]} ${args[1]}`
    : args[0];
  const command = Object.hasOwn(commands, key) ? commands[key]
    : Object.hasOwn(commands, args[0]) ? commands[args[0]] : undefined;
  if (command) {
    return `Usage:\n  pharo-agent ${command.usage}\n\n${command.description}\n\nExample:\n  pharo-agent ${command.example}`;
  }
  const entries = Object.entries(commands)
    .filter(([name]) => args[0] !== "image" || name.startsWith("image "));
  return ["Usage:", ...entries.map(([, entry]) => `  pharo-agent ${entry.usage}`),
    "", "Use pharo-agent <command> --help for options and examples."].join("\n");
}
