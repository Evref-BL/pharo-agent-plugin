import { hostChoices, hostIds } from "./hosts.js";

const commands = {
  init: {
    usage: `init --host <${hostChoices()}> [--mount-root <path>]`,
    description: "Initialize the current project for the required agent host. Write its managed instruction block,\n"
      + "pharo.AGENTS.md, and workflow skills/references. Re-run to refresh those generated files.\n"
      + "The mount root defaults to .pharo-agent/mounts; omit --mount-root to keep an existing setting.",
    example: `init --host ${hostIds[0]}`,
  },
  "image list": {
    usage: "image list",
    description: "List the project's declared images, default image, and recorded open state.",
    example: "image list",
  },
  "image templates": {
    usage: "image templates",
    description: "List available launcher templates and their categories. A name in several categories\n"
      + "needs --category when passed to image add.",
    example: "image templates",
  },
  "image add": {
    usage: "image add <id> --template <name> [--category <name>] [--profile <id>]",
    description: "Declare an image with a required id and template name; open creates it later.\n"
      + "Use --category for an ambiguous template name and --profile to choose a launcher profile.\n"
      + "The first declared image becomes the default.",
    example: "image add dev --template '<template name>'",
  },
  "image use": {
    usage: "image use <id>",
    description: "Make the required declared image the project's default. It may already be open.",
    example: "image use dev",
  },
  "image remove": {
    usage: "image remove <id>",
    description: "Remove the required image declaration. Close the image first. Its image files are kept.\n"
      + "Removing the default image clears the default selection.",
    example: "image remove dev",
  },
  open: {
    usage: "open [--image <id>]",
    description: "Create if needed and open an image with its tools and source projection. Omit --image\n"
      + "to use the project's default image. Other open images stay open. Pharo versions outside\n"
      + "the MCP support range open without tools or a source projection.",
    example: "open --image dev",
  },
  status: {
    usage: "status",
    description: "Report all images this project has open. This command does not accept --image.",
    example: "status",
  },
  close: {
    usage: "close [--image <id>]",
    description: "Close the selected image and its source projection. Omitting --image closes all images\n"
      + "this project opened, rather than only the default image.",
    example: "close --image dev",
  },
  mcp: {
    usage: "mcp [--image <id>]",
    description: "Expose an open image's tools as a command-scoped stdio MCP server. Omit --image\n"
      + "to use the project's default image. The server exits with this command.",
    example: "mcp --image dev",
  },
  "pharo list": {
    usage: "pharo list [--image <id>]",
    description: "List an open image's advertised tools. Omit --image to use the project's default image.\n"
      + "Use tool_search and tool_get to discover and inspect the rest of its catalogue.",
    example: "pharo list",
  },
  pharo: {
    usage: "pharo <tool> [arguments-json] [--image <id>]",
    description: "Call a tool in an open image. Arguments must be a JSON object and default to {}.\n"
      + "Omit --image to use the project's default image. Inspect the tool's schema with tool_get\n"
      + "before calling it; a failed tool result makes the command exit unsuccessfully.",
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
