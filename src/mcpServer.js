import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  callImageTool,
  imageTarget,
  listImageTools,
  toolResult,
  version,
  withImageSelector,
} from "./gateway.js";
import { createImage, deleteImage, listImageTemplates, listImages } from "./images.js";
import { startAgentImage, stopAgentImage } from "./live.js";

// The host loads only tool names and these instructions at session start and
// defers the rest, so this is what decides whether Pharo tools are searched
// for at all. It is the conditional guidance the generated guide gives,
// written where the host can act on it.
export const serverInstructions = `Live Pharo images for this project: reading and changing code, running tests,
searching and critiquing it.

Search these tools for any Pharo, Smalltalk, Tonel or .st work. image_list
says which images this project has and which are running, as of the call.
Start an image with image_start before calling its tools; a project with no
image needs image_templates and image_create first. An image lists its common
tools; tool_search and tool_get find the rest.

An image takes one writer: image_create a new one for each new subject or
parallel agent rather than share one, named like a branch
(pretty-print-formatter, not p15). The default image is the main line. A
running image may be another session's. image_stop kills an image without
saving it.`;

const nameProperty = {
  type: "string",
  description: "Image name. Defaults to the default image.",
};

// This server's own tools, in the order a project meets them: create an
// image, start it, and the image's tools join the list. Listed whether or not
// an image is running, so the list is never empty — a host that caches tools
// and ignores tools/list_changed would otherwise hold an empty list for the
// whole session and never learn that one had started.
const projectTools = [
  {
    name: "image_templates",
    description: "List the templates images can be created from, with their categories.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "image_create",
    description:
      "Create an image from a template, with the pinned Pharo MCP in it, without "
      + "starting it. The first image created is the default.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "What the image is for, named like a branch.",
        },
        template: {
          type: "string",
          description: "Template name, as image_templates gives it.",
        },
        category: {
          type: "string",
          description: "Template category, for a name two categories offer.",
        },
      },
      required: ["name", "template"],
    },
  },
  {
    name: "image_list",
    description:
      "List this project's images, which is the default, and which are running now, "
      + "with the source mount of each running one.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "image_start",
    description:
      "Start an image; it refuses one that is already running. Its tools are "
      + "listed once it answers. On macOS and Linux its source also mounts as files.",
    inputSchema: {
      type: "object",
      properties: {
        name: nameProperty,
        display: {
          type: "string",
          enum: ["headless", "interactive"],
          description: "headless, the default, or interactive to open the image's window.",
        },
      },
    },
  },
  {
    name: "image_stop",
    description: "Kill an image, without saving it, and unmount its source.",
    inputSchema: {
      type: "object",
      properties: {
        name: nameProperty,
        all: {
          type: "boolean",
          description: "Stop every running image of this project instead.",
        },
      },
    },
  },
  {
    name: "image_delete",
    description: "Delete a stopped image and its files.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Image name." },
      },
      required: ["name"],
    },
  },
];

// Resolved per request rather than once at startup. A host starts this server
// when its session starts, which is before anyone has started an image, so
// resolving then meant the server died on its first line.
async function selectedImageTools(projectRoot, selected) {
  let target;
  try {
    target = await imageTarget(projectRoot, selected);
  } catch {
    // No default image, or it is not running. It contributes no tools yet,
    // and the image tools say how to change that.
    return [];
  }
  try {
    return (await listImageTools(target)).map((tool) => withImageSelector(tool, target.name));
  } catch (error) {
    // A running image may still not answer: it may be hung. Failing the
    // whole list would take image_stop with it, and with it the one way out.
    // stderr reaches the host's log.
    console.error(`pharo-agent: image ${target.name} listed no tools: ${error.message}`);
    return [];
  }
}

// A schema is a description, not a guard: nothing between the model and here
// enforces it, so a missing argument is named here rather than somewhere
// further in.
function requiredString(argumentsValue, key, tool, purpose) {
  const value = argumentsValue[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${tool} needs ${key}, ${purpose}.`);
  }
  return value;
}

function optionalString(argumentsValue, key) {
  const value = argumentsValue[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * @param {() => string} resolveProjectRoot
 * @param {string} [selectedImage] the image whose tools are served, instead of the default
 */
export async function serveImagesMcp(resolveProjectRoot, selectedImage) {
  const server = new Server(
    { name: "pharo-agent", version },
    { capabilities: { tools: { listChanged: true } }, instructions: serverInstructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let projectRoot;
    try {
      projectRoot = resolveProjectRoot();
    } catch {
      // No project here. The image tools are still listed rather than
      // nothing, so the host has a server that works and a call can say why.
      return { tools: projectTools };
    }
    return {
      tools: [...projectTools, ...(await selectedImageTools(projectRoot, selectedImage))],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const argumentsValue = request.params.arguments ?? {};
    const tool = request.params.name;
    // Throws when there is no project, which is the answer the caller needs.
    const projectRoot = resolveProjectRoot();

    // Matched before the image's catalogue: these names belong to this
    // server, and an image that happened to hold one must not decide what
    // starting an image means.
    if (tool === "image_templates") {
      return toolResult({ ok: true, ...(await listImageTemplates(projectRoot)) });
    }
    if (tool === "image_create") {
      const name = requiredString(argumentsValue, "name", tool, "the name the image will be called by");
      const template = requiredString(argumentsValue, "template", tool, "a template name as image_templates gives it");
      const category = optionalString(argumentsValue, "category");
      return toolResult({
        ok: true,
        ...(await createImage(projectRoot, name, { template, ...(category ? { category } : {}) })),
      });
    }
    if (tool === "image_list") {
      return toolResult({ ok: true, ...(await listImages(projectRoot)) });
    }
    if (tool === "image_start") {
      const display = optionalString(argumentsValue, "display");
      if (display !== undefined && display !== "headless" && display !== "interactive") {
        throw new Error("image_start takes display headless or interactive.");
      }
      const started = await startAgentImage(
        projectRoot,
        optionalString(argumentsValue, "name") ?? selectedImage,
        display ? { display } : {},
      );
      await server.sendToolListChanged();
      return toolResult({ ok: true, ...started });
    }
    if (tool === "image_stop") {
      // A name given with all reaches stopAgentImage, which refuses the pair,
      // rather than be dropped for the reading that stops the most.
      const stopped = argumentsValue.all === true
        ? await stopAgentImage(projectRoot, optionalString(argumentsValue, "name"), { all: true })
        : await stopAgentImage(projectRoot, optionalString(argumentsValue, "name") ?? selectedImage);
      await server.sendToolListChanged();
      return toolResult({ ok: true, ...stopped });
    }
    if (tool === "image_delete") {
      const name = requiredString(argumentsValue, "name", tool, "the image to delete");
      return toolResult({ ok: true, ...(await deleteImage(projectRoot, name)) });
    }

    // Listed tools are the common ones, not the whole catalogue, and the image
    // answers for any tool it holds. Refusing a name this list does not carry
    // would hide tools that tool_search just found, and the image's own error
    // is the better answer for a name nothing holds.
    const { image, ...imageArguments } = argumentsValue;
    const target = await imageTarget(projectRoot, typeof image === "string" ? image : selectedImage);
    return toolResult(await callImageTool(target, tool, imageArguments));
  });

  await server.connect(new StdioServerTransport());
}
