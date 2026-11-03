import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  callImageTool,
  listImageTools,
  toolResult,
  version,
  withImageSelector,
} from "./gateway.js";
import { agentImageStatus, closeAgentImage, openAgentImage } from "./live.js";
import { readOpenImage } from "./runtime.js";

// The host loads only tool names and these instructions at session start and
// defers the rest, so this is what decides whether Pharo tools are searched
// for at all. It is the conditional guidance the generated guide gives,
// written where the host can act on it.
export const serverInstructions = `Live Pharo images for this project: reading and writing Smalltalk code in the
image, running tests, finding senders and implementors, applying critiques,
and projecting image source as files on disk.

Search these tools whenever the task involves Pharo, Smalltalk, a Tonel
package, or a .st file. Start an image with image_start before calling the
image's own tools, which are listed once an image answers; image_list says
what is already running.

The image advertises the common tools rather than all of it. Use tool_search
and tool_get to find the rest, then call one by name like any other.`;

// Listed whether or not an image is open, so the list is never empty. A host
// that caches tools and ignores tools/list_changed would otherwise hold an
// empty list for the whole session and never learn that an image had opened.
const lifecycleTools = [
  {
    name: "image_start",
    description:
      "Start one of this project's Pharo images, creating it from its template "
      + "when it does not exist yet, and mount its source projection. The "
      + "image's own tools are listed once it answers.",
    inputSchema: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description: "Image id to start. Defaults to the project's default image.",
        },
      },
    },
  },
  {
    name: "image_list",
    description:
      "Report which of this project's images are running, with their routes and mounts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "image_stop",
    description:
      "Stop a running image and the source projection this project started for it.",
    inputSchema: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description: "Image id to stop. Defaults to every image this project started.",
        },
      },
    },
  },
];

// Resolved per request rather than once at startup. A host starts this server
// when its session starts, which is before anyone has opened an image, so
// resolving then meant the server died on its first line.
async function openImageTools(projectRoot, defaultImage) {
  let open;
  try {
    open = readOpenImage(projectRoot, defaultImage);
  } catch {
    // No image open, none configured, or one open without MCP. The image
    // contributes no tools yet and the lifecycle tools say how to change that.
    return [];
  }
  return (await listImageTools(projectRoot, open))
    .map((tool) => withImageSelector(tool, open.imageId));
}

export async function serveImagesMcp(resolveProjectRoot, defaultImage) {
  const server = new Server(
    { name: "pharo-agent", version },
    { capabilities: { tools: { listChanged: true } }, instructions: serverInstructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let projectRoot;
    try {
      projectRoot = resolveProjectRoot();
    } catch {
      // No project here. The lifecycle tools are still listed rather than
      // nothing, so the host has a server that works and a call can say why.
      return { tools: lifecycleTools };
    }
    return { tools: [...lifecycleTools, ...(await openImageTools(projectRoot, defaultImage))] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { image, ...argumentsValue } = request.params.arguments ?? {};
    const selected = image ?? defaultImage;
    // Throws when there is no project, which is the answer the caller needs.
    const projectRoot = resolveProjectRoot();

    // Matched before the image's catalogue: these three names belong to this
    // server, and an image that happened to hold one must not decide what
    // starting an image means.
    if (request.params.name === "image_start") {
      const opened = await openAgentImage(projectRoot, selected);
      await server.sendToolListChanged();
      return toolResult({ ok: true, ...opened });
    }
    if (request.params.name === "image_list") {
      return toolResult({ ok: true, ...agentImageStatus(projectRoot) });
    }
    if (request.params.name === "image_stop") {
      const closed = await closeAgentImage(projectRoot, selected);
      await server.sendToolListChanged();
      return toolResult({ ok: true, ...closed });
    }

    // Listed tools are the common ones, not the whole catalogue, and the image
    // answers for any tool it holds. Refusing a name this list does not carry
    // would hide tools that tool_search just found, and the image's own error
    // is the better answer for a name nothing holds.
    const open = readOpenImage(projectRoot, selected);
    return toolResult(
      await callImageTool(projectRoot, open, request.params.name, argumentsValue),
    );
  });

  await server.connect(new StdioServerTransport());
}
