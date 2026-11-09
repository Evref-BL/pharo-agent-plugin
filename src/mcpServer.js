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
import { addImage, listImages } from "./images.js";
import { listImageTemplates, startAgentImage, stopAgentImage } from "./live.js";
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
image's own tools, which are listed once an image answers. A project that
declares no image yet needs image_templates and image_add first.

An image holds one line of work and takes one writer: it has no branches, so
two agents in one image share every edit. Images are cheap, created and
started in seconds, so make one with image_add and image_start whenever a new
subject comes up (another fix, an experiment, a review, another branch), when
you work beside another agent or session, and when the image you would use was
made for something else or has fallen behind. Name it like a branch, after
what it is for (pretty-print-formatter), not after its version or a role (p15,
dev2). The default image is the project's main line. image_list says which
images exist and which run, not which are free: a running image may be another
session's.

The image advertises the common tools rather than all of it. Use tool_search
and tool_get to find the rest, then call one by name like any other.`;

// This server's own tools, in the order a project meets them: declare an
// image, start it, and the image's tools join the list. Listed whether or not
// an image is running, so the list is never empty — a host that caches tools
// and ignores tools/list_changed would otherwise hold an empty list for the
// whole session and never learn that one had started.
const projectTools = [
  {
    name: "image_templates",
    description:
      "List the images Pharo Launcher can create, with the category of each. "
      + "A template name that two categories offer is flagged, and needs its "
      + "category when it is declared.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "image_add",
    description:
      "Declare an image in this project, from a template image_templates "
      + "names. Declare one for each subject that should not share an image: "
      + "declaring does not create it, and the first image_start creates it "
      + "from this template in seconds. The first image declared becomes the "
      + "project's default.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "What the image is for, named like a branch: "
            + "pretty-print-formatter, not p15 or dev2.",
        },
        template: {
          type: "string",
          description: "Template name, exactly as image_templates gives it.",
        },
        category: {
          type: "string",
          description:
            "Template category. Needed only for a name two categories offer.",
        },
        profile: {
          type: "string",
          description: "Pharo Launcher profile to create the image under.",
        },
      },
      required: ["id", "template"],
    },
  },
  {
    name: "image_start",
    description:
      "Start one of this project's Pharo images, creating it from its template "
      + "when it does not exist yet. Start one made for this subject; for a new "
      + "subject, image_add one first. The image's own tools are listed once it "
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
      + "and mount of each running one. An image that was started and has "
      + "exited since is listed as exited; image_start starts it again. A "
      + "running image may be another session's.",
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
  try {
    return (await listImageTools(projectRoot, running))
      .map((tool) => withImageSelector(tool, running.imageId));
  } catch (error) {
    // A record says this project started the image, not that it still
    // answers: it may have exited, or hung. Failing the whole list would take
    // image_start with it, and with it the one way back. image_list says
    // which image is gone; stderr reaches the host's log.
    console.error(`pharo-agent: image ${running.imageId} listed no tools: ${error.message}`);
    return [];
  }
}

// A schema is a description, not a guard: nothing between the model and here
// enforces it, and a declaration missing its template would otherwise fail
// somewhere further in, naming a field the caller never saw.
function declarationFrom(argumentsValue) {
  const { id, template, category, profile } = argumentsValue;
  if (typeof id !== "string" || id === "") {
    throw new Error("image_add needs the id this project will call the image by.");
  }
  if (typeof template !== "string" || template === "") {
    throw new Error("image_add needs a template name, as image_templates gives it.");
  }
  return { id, template, category, profile };
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
      return { tools: projectTools };
    }
    return {
      tools: [...projectTools, ...(await runningImageTools(projectRoot, defaultImage))],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { image, all, ...argumentsValue } = request.params.arguments ?? {};
    const selected = image ?? defaultImage;
    // Throws when there is no project, which is the answer the caller needs.
    const projectRoot = resolveProjectRoot();

    // Matched before the image's catalogue: these names belong to this
    // server, and an image that happened to hold one must not decide what
    // starting an image means.
    if (request.params.name === "image_templates") {
      return toolResult({ ok: true, ...(await listImageTemplates(projectRoot)) });
    }
    if (request.params.name === "image_add") {
      return toolResult({ ok: true, ...addImage(projectRoot, declarationFrom(argumentsValue)) });
    }
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
