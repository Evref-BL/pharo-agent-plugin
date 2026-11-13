import { hostChoices, hostIds } from "./hosts.js";

const commands = {
  init: {
    usage: `init --host <${hostChoices()}> [--mount-root <path>]`,
    description: "Write this project's Pharo guide, skills and references for the host. Re-run to refresh\n"
      + "them. --mount-root sets where sources mount, .pharo-agent/mounts by default.",
    example: `init --host ${hostIds[0]}`,
  },
  "image templates": {
    usage: "image templates",
    description: "List the templates images can be created from, with their categories.",
    example: "image templates",
  },
  "image create": {
    usage: "image create <name> --template <name> [--category <name>] [--script <file> [--every-start]]",
    description: "Create an image from a template, with the pinned Pharo MCP in it, without starting it.\n"
      + "Name it after what it is for, like a branch. The first image created is the default.\n"
      + "--category is for a name two categories offer. --script files in your own Smalltalk\n"
      + "instead of the pinned MCP, once; --every-start files it in again at every start.",
    example: "image create pretty-print-formatter --template '<template name>'",
  },
  "image list": {
    usage: "image list",
    description: "List this project's images, the default, which are running now, and the mount of each\n"
      + "running one.",
    example: "image list",
  },
  "image use": {
    usage: "image use <name>",
    description: "Make an image the default.",
    example: "image use dev",
  },
  "image start": {
    usage: "image start [<name>] [--display interactive]",
    description: "Start an image, the default one without a name; an image already running is refused.\n"
      + "Others keep running. On macOS and Linux its source mounts as files, unless\n"
      + "PHARO_AGENT_PROJECTION=off. --display interactive opens its window.",
    example: "image start dev",
  },
  "image stop": {
    usage: "image stop [<name>] [--all]",
    description: "Kill an image without saving it, and unmount its source: the default one without a\n"
      + "name, or --all of this project's running images.",
    example: "image stop dev",
  },
  "image delete": {
    usage: "image delete <name>",
    description: "Delete a stopped image and its files.",
    example: "image delete dev",
  },
  list: {
    usage: "list [--image <name>] [--json]",
    description: "List a running image's advertised tools, one line each. tool_search finds the rest.",
    example: "list",
  },
  "<tool>": {
    usage: "<tool> [<value>] [--<argument> <value>]... [--image <name>] [--json]",
    description: "Call an image tool. Its arguments are flags, - reads a value from stdin, and\n"
      + "<tool> --help lists them. Prints the answer's text, or the MCP result with --json.",
    example: "class_get Point",
  },
  mcp: {
    usage: "mcp [--image <name>]",
    description: "Serve this project's images as a stdio MCP server, as the plugin does for a host.",
    example: "mcp --image dev",
  },
};

export function usage(args = []) {
  const key = args[0] === "image" && args[1]
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
