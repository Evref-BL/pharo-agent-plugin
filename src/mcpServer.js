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
import { listImages } from "./images.js";
import { startAgentImage, stopAgentImage } from "./live.js";
import { readRunningImage } from "./runtime.js";

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

// Listed whether or not an image is running, so the list is never empty. A
// host that caches tools and ignores tools/list_changed would otherwise hold
// an empty list for the whole session and never learn that one had started.
const lifecycleTools = [
  {
    name: "image_start",
    description:
      "Start one of this project's Pharo images, creating it from its template "
      + "when it does not exist yet. The image's own tools are listed once it "
      + "answers. On macOS with fuse-t its source also mounts as files; "
      + "elsewhere the image starts without that and says so.",
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
      "List this project's declared images, which are running, and the route "
      + "and mount of each running one.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "image_stop",
    description:
      "Stop a running image, and any source projection this project started for it.",
    inputSchema: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description: "Image id to stop. Defaults to the project's default image.",
        },
        all: {
          type: "boolean",
          description: "Stop every image this project started, instead of one.",
        },
      },
    },
  },
];

// Resolved per request rather than once at startup. A host starts this server
// when its session starts, which is before anyone has started an image, so
// resolving then meant the server died on its first line.
async function runningImageTools(projectRoot, defaultImage) {
  let running;
  try {
    running = readRunningImage(projectRoot, defaultImage);
  } catch {
    // No image running, none configured, or one running without MCP. The image
    // contributes no tools yet and the lifecycle tools say how to change that.
    return [];
  }
  return (await listImageTools(projectRoot, running))
    .map((tool) => withImageSelector(tool, running.imageId));
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
    return {
      tools: [...lifecycleTools, ...(await runningImageTools(projectRoot, defaultImage))],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { image, all, ...argumentsValue } = request.params.arguments ?? {};
    const selected = image ?? defaultImage;
    // Throws when there is no project, which is the answer the caller needs.
    const projectRoot = resolveProjectRoot();

    // Matched before the image's catalogue: these three names belong to this
    // server, and an image that happened to hold one must not decide what
    // starting an image means.
    if (request.params.name === "image_start") {
      const started = await startAgentImage(projectRoot, selected);
      await server.sendToolListChanged();
      return toolResult({ ok: true, ...started });
    }
    if (request.params.name === "image_list") {
      return toolResult({ ok: true, ...listImages(projectRoot) });
    }
    if (request.params.name === "image_stop") {
      const stopped = all
        ? await stopAgentImage(projectRoot, undefined, { all: true })
        : await stopAgentImage(projectRoot, selected);
      await server.sendToolListChanged();
      return toolResult({ ok: true, ...stopped });
    }

    // Listed tools are the common ones, not the whole catalogue, and the image
    // answers for any tool it holds. Refusing a name this list does not carry
    // would hide tools that tool_search just found, and the image's own error
    // is the better answer for a name nothing holds.
    const running = readRunningImage(projectRoot, selected);
    return toolResult(
      await callImageTool(projectRoot, running, request.params.name, argumentsValue),
    );
  });

  await server.connect(new StdioServerTransport());
}
