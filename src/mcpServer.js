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
  missingDefault,
  toolResult,
  version,
  withImageSelector,
} from "./gateway.js";
import { createImage, deleteImage, listImageTemplates, listImages, projectImages } from "./images.js";
import { callsNote, startAgentImage, stopAgentImage } from "./live.js";
import { readConfig } from "./project.js";

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

const projectToolNames = new Set(projectTools.map((tool) => tool.name));

/** The image a call that names none goes to: the server's, or the project's. */
function serverDefaultImage(projectRoot, selectedImage) {
  if (selectedImage !== undefined) return selectedImage;
  const { defaultImage } = readConfig(projectRoot);
  return typeof defaultImage === "string" ? defaultImage : undefined;
}

// How long one image's listing may hold back this server's tools/list. A
// host waits on the whole list, this server's image_* tools with it, at the
// start of a session and after every image_start and image_stop, and an
// image that is evaluating something long does not answer until it is done:
// PLexus alone would wait a minute on each of its two requests. An image
// that answers lists its tools in well under a second, 45 to 78 ms measured
// through this server, so five seconds leaves it sixty times that and is
// still a wait a person sits through. An image slower than that is left out
// of this listing and waited on, asked again while it runs each time PLexus
// gives up on it (`followLate`): once it answers, `listChanged` tells the
// host to list again, once for however many images this listing left out,
// since the listing that follows asks them all.
export const listingTimeoutMs = 5_000;

// The tools of every running image of the project, each name once, as PLexus's
// own server lists them. Listing only the default image's left an agent that
// had started another one, with the default stopped, without a single tool.
// Resolved per request rather than once at startup. A host starts this server
// when its session starts, which is before anyone has started an image, so
// resolving then meant the server died on its first line.
/**
 * @param {string} projectRoot
 * @param {string | undefined} selectedImage
 * @param {() => void} listChanged
 * @param {AbortSignal} hostLeft
 */
async function runningImageTools(projectRoot, selectedImage, listChanged, hostLeft) {
  let defaultImage;
  let images;
  let rows;
  try {
    defaultImage = serverDefaultImage(projectRoot, selectedImage);
    images = projectImages(projectRoot);
    rows = await images.list();
  } catch (error) {
    console.error(`pharo-agent: no image tools listed: ${error.message}`);
    return [];
  }
  // The default's first: where two images hold a tool, the schema listed is
  // the one a call naming no image meets.
  const answering = rows.flatMap((row) => (row.endpoint ? [{ name: row.name, endpoint: row.endpoint }] : []));
  const ordered = [
    ...answering.filter((row) => row.name === defaultImage),
    ...answering.filter((row) => row.name !== defaultImage),
  ];
  let changed = false;
  const answeredLate = () => {
    if (changed) return;
    changed = true;
    listChanged();
  };
  const listings = await Promise.allSettled(
    ordered.map((row) => listImageTools(
      { name: row.name, images, endpoint: row.endpoint },
      { timeoutMs: listingTimeoutMs, answeredLate, signal: hostLeft },
    )),
  );
  /** @type {Map<string, { tool: any, holders: string[] }>} */
  const held = new Map();
  /** @type {Set<string>} */
  const listed = new Set();
  listings.forEach((listing, index) => {
    const { name } = ordered[index];
    if (listing.status === "rejected") {
      // A running image may still not answer: it may be busy or hung.
      // Failing the whole list would take image_stop with it, and with it
      // the one way out, and offering it in a tool's image would send calls
      // to an image just seen not to answer. stderr reaches the host's log.
      console.error(`pharo-agent: image ${name} listed no tools: ${listing.reason?.message ?? listing.reason}`);
      return;
    }
    listed.add(name);
    for (const tool of listing.value) {
      if (projectToolNames.has(tool.name)) continue;
      const entry = held.get(tool.name);
      if (!entry) held.set(tool.name, { tool, holders: [name] });
      else if (!entry.holders.includes(name)) entry.holders.push(name);
    }
  });
  const absence = defaultAbsence(rows, listed, defaultImage, selectedImage !== undefined);
  return [...held.values()].map(({ tool, holders }) => withImageSelector(tool, holders, defaultImage, absence));
}

/**
 * Why the default image lists no tool at all, or nothing when it listed its
 * own: each tool then says whether it is among them.
 *
 * @param {{ name: string, running: boolean }[]} rows
 * @param {Set<string>} listed the images whose listing answered
 * @param {string | undefined} defaultImage
 * @param {boolean} chosen whether this server was started with it
 */
function defaultAbsence(rows, listed, defaultImage, chosen) {
  if (defaultImage === undefined || listed.has(defaultImage)) return undefined;
  const own = rows.find((row) => row.name === defaultImage);
  if (own === undefined) return missingDefault(chosen);
  return own.running ? "does not answer" : "is not running";
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
 * @param {string} [selectedImage] the image a call naming none goes to, instead of the default
 */
export async function serveImagesMcp(resolveProjectRoot, selectedImage) {
  const server = new Server(
    { name: "pharo-agent", version },
    { capabilities: { tools: { listChanged: true } }, instructions: serverInstructions },
  );

  // A host leaves by closing the server's input. An image still waited on
  // for answering late then has nobody to tell, and is asked nothing more.
  const hostLeft = new AbortController();
  process.stdin.once("end", () => hostLeft.abort());

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    let projectRoot;
    try {
      projectRoot = resolveProjectRoot();
    } catch {
      // No project here. The image tools are still listed rather than
      // nothing, so the host has a server that works and a call can say why.
      return { tools: projectTools };
    }
    // A host gone by the time an image answers is nobody to tell.
    const listChanged = () => { server.sendToolListChanged().catch(() => {}); };
    return {
      tools: [
        ...projectTools,
        ...(await runningImageTools(projectRoot, selectedImage, listChanged, hostLeft.signal)),
      ],
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
      return toolResult({ ok: true, ...(await listImages(projectRoot, serverDefaultImage(projectRoot, selectedImage))) });
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
      const note = callsNote(started.name, serverDefaultImage(projectRoot, selectedImage));
      return toolResult({ ok: true, ...started, ...(note ? { note } : {}) });
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
    const target = await imageTarget(
      projectRoot,
      typeof image === "string" ? image : undefined,
      { defaultImage: selectedImage },
    );
    return toolResult(await callImageTool(target, tool, imageArguments));
  });

  await server.connect(new StdioServerTransport());
}
