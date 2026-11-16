import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { imageToolAnswers } from "@evref-bl/plexus";
import {
  callImageTool,
  imageTarget,
  listImageTools,
  missingDefault,
  version,
  withImageSelector,
} from "./gateway.js";
import {
  callFailedText,
  createAnswer,
  deleteAnswer,
  listAnswer,
  noDefaultImage,
  startAnswer,
  stopAnswer,
  templatesAnswer,
} from "./answers.js";
import { createImage, deleteImage, listImageTemplates, listImages, projectImages } from "./images.js";
import { startAgentImage, stopAgentImage } from "./live.js";
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
saving it; with save: true, the image saves itself and quits.`;

const nameProperty = {
  type: "string",
  description: "Image name. Defaults to the default image.",
};

// A schema is a description, not a guard: nothing between the model and here
// enforces it, so each call is checked against the schema it was offered, and
// an argument the schema does not name is refused with the ones it does, as
// MCP refuses one, rather than dropped.
/**
 * @param {Record<string, object>} properties
 * @param {string[]} [required]
 * @returns {import("@modelcontextprotocol/sdk/types.js").Tool["inputSchema"]}
 */
function schema(properties, required) {
  return { type: "object", properties, ...(required ? { required } : {}), additionalProperties: false };
}

// This server's own tools, in the order a project meets them: create an
// image, start it, and the image's tools join the list. Listed whether or not
// an image is running, so the list is never empty — a host that caches tools
// and ignores tools/list_changed would otherwise hold an empty list for the
// whole session and never learn that one had started.
const projectTools = [
  {
    name: "image_templates",
    description: "List the templates images can be created from, with their categories.",
    inputSchema: schema({}),
  },
  {
    name: "image_create",
    description:
      "Create an image from a template, with the pinned Pharo MCP in it, without "
      + "starting it. The first image created is the default.",
    inputSchema: schema({
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
    }, ["name", "template"]),
  },
  {
    name: "image_list",
    description:
      "List this project's images, which is the default, and which are running now, "
      + "with the source mount of each running one.",
    inputSchema: schema({}),
  },
  {
    name: "image_start",
    description:
      "Start an image; it refuses one that is already running. Its tools are "
      + "listed once it answers. On macOS and Linux its source also mounts as files, "
      + "at the path its answer gives.",
    inputSchema: schema({
      name: nameProperty,
      display: {
        type: "string",
        enum: ["headless", "interactive"],
        description: "headless, the default, or interactive to open the image's window.",
      },
    }),
  },
  {
    name: "image_stop",
    description:
      "Stop an image and unmount its source. By default it kills the image without saving it, and "
      + "the image starts again as it was last saved. With save: true, the image saves itself and "
      + "quits instead, keeping its changes. Evaluating `Smalltalk saveSession` in the image saves "
      + "it without stopping it.",
    inputSchema: schema({
      name: nameProperty,
      all: {
        type: "boolean",
        description: "Stop every running image of this project instead.",
      },
      save: {
        type: "boolean",
        description: "true to have the image save itself and quit; false or absent kills it without saving.",
      },
    }),
  },
  {
    name: "image_delete",
    description: "Delete a stopped image and its files.",
    inputSchema: schema({ name: { type: "string", description: "Image name." } }, ["name"]),
  },
];

const projectToolNames = new Set(projectTools.map((tool) => tool.name));

/** The names of this server's own tools, which the texts it answers may name. */
export const imageToolNames = [...projectToolNames];

// The one argument of a forwarded call this server reads: the rest is the
// image's to check, against its own schema.
const imageArgument = /** @type {const} */ ({ type: "object", properties: { image: { type: "string" } } });

/**
 * The input schema each running image listed for each of its tools, by image
 * and then by tool, as of the last listing: a call passes it on, so that it
 * waits as long as the image's own limit for the tool allows.
 *
 * @typedef {Map<string, Map<string, import("@modelcontextprotocol/sdk/types.js").Tool["inputSchema"]>>} ListedSchemas
 */

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
 * @returns {Promise<{ tools: any[], schemas: ListedSchemas }>}
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
    return { tools: [], schemas: new Map() };
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
  /** @type {ListedSchemas} */
  const schemas = new Map();
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
    schemas.set(name, new Map(listing.value.map((tool) => [tool.name, tool.inputSchema])));
    for (const tool of listing.value) {
      if (projectToolNames.has(tool.name)) continue;
      const entry = held.get(tool.name);
      if (!entry) held.set(tool.name, { tool, holders: [name] });
      else if (!entry.holders.includes(name)) entry.holders.push(name);
    }
  });
  const absence = defaultAbsence(rows, listed, defaultImage, selectedImage !== undefined);
  return {
    tools: [...held.values()].map(({ tool, holders }) => withImageSelector(tool, holders, defaultImage, absence)),
    schemas,
  };
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

/** @param {string} text */
function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Any refusal, this package's or PLexus's, as a result the caller reads: its
 * message alone. Thrown, it reached a host as a JSON-RPC error, which one
 * host showed as its own failure to call the tool.
 */
function failure(error) {
  return textResult(error instanceof Error ? error.message : String(error), true);
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
  // From the last listing: a call to a tool waits as long as the schema its
  // image listed for it allows. A tool found through tool_search, which no
  // listing names, has none.
  /** @type {ListedSchemas} */
  let listedSchemas = new Map();

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
    const { tools, schemas } = await runningImageTools(projectRoot, selectedImage, listChanged, hostLeft.signal);
    listedSchemas = schemas;
    return { tools: [...projectTools, ...tools] };
  });

  // A call the host cancels aborts its signal: the forwarded request is
  // dropped, and the SDK answers nothing for it. The host leaving does not
  // cancel one, since a client may close its input and still read the answer.
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      return await answerCall(request.params.name, request.params.arguments ?? {}, extra.signal);
    } catch (error) {
      return failure(error);
    }
  });

  /**
   * @param {string} tool
   * @param {Record<string, unknown>} argumentsValue
   * @param {AbortSignal} signal
   */
  async function answerCall(tool, argumentsValue, signal) {
    // Before the project: a call that breaks the schema it was offered is
    // refused for that wherever it is made. Of a forwarded call, only the
    // image it names is this server's to check.
    const projectTool = projectTools.find((each) => each.name === tool);
    const { image, ...imageArguments } = argumentsValue;
    const refusal = projectTool
      ? imageToolAnswers.checkArguments(projectTool, argumentsValue)
      : imageToolAnswers.checkArguments({ name: tool, inputSchema: imageArgument }, image === undefined ? {} : { image });
    if (refusal) return textResult(refusal, true);
    // Throws when there is no project, which is the answer the caller needs.
    const projectRoot = resolveProjectRoot();

    // Matched before the image's catalogue: these names belong to this
    // server, and an image that happened to hold one must not decide what
    // starting an image means.
    if (projectTool) {
      return textResult(imageToolAnswers.render(await projectToolAnswer(projectRoot, tool, argumentsValue)));
    }

    // Listed tools are the common ones, not the whole catalogue, and the image
    // answers for any tool it holds. Refusing a name this list does not carry
    // would hide tools that tool_search just found, and the image's own error
    // is the better answer for a name nothing holds.
    const target = await imageTarget(
      projectRoot,
      /** @type {string | undefined} */ (image),
      { defaultImage: selectedImage },
    );
    const inputSchema = listedSchemas.get(target.name)?.get(tool);
    try {
      // The image's answer, an error or not, is the image's to word.
      return await callImageTool(target, tool, imageArguments, { ...(inputSchema ? { inputSchema } : {}), signal });
    } catch (error) {
      const failed = await callFailedText(target, tool, error);
      if (failed === undefined) throw error;
      return textResult(failed, true);
    }
  }

  /**
   * What one of this server's own tools did, its arguments already checked
   * against its schema.
   *
   * @param {string} projectRoot
   * @param {string} tool
   * @param {Record<string, any>} args
   */
  async function projectToolAnswer(projectRoot, tool, args) {
    const defaultImage = serverDefaultImage(projectRoot, selectedImage);
    // A start or a stop that names no image, with no default, is told what
    // to do in this server's terms: the terminal's text names commands.
    const named = (/** @type {string | undefined} */ name) => {
      const resolved = name ?? defaultImage;
      if (resolved === undefined) throw new Error(noDefaultImage());
      return resolved;
    };
    switch (tool) {
      case "image_templates":
        return templatesAnswer(await listImageTemplates(projectRoot));
      case "image_create":
        return createAnswer(
          await createImage(projectRoot, args.name, {
            template: args.template,
            ...(args.category === undefined ? {} : { category: args.category }),
          }),
        );
      case "image_list":
        return listAnswer(projectRoot, await listImages(projectRoot, defaultImage), selectedImage !== undefined);
      case "image_start": {
        const start = await startAgentImage(projectRoot, named(args.name), args.display ? { display: args.display } : {});
        await server.sendToolListChanged();
        return startAnswer(projectRoot, start, defaultImage);
      }
      case "image_stop": {
        // A name given with all reaches stopAgentImage, which refuses the
        // pair, rather than be dropped for the reading that stops the most.
        const name = args.all ? args.name : named(args.name);
        const options = { ...(args.all ? { all: true } : {}), ...(args.save === true ? { save: true } : {}) };
        let stopped;
        try {
          stopped = await stopAgentImage(projectRoot, name, options);
        } catch (error) {
          // A save that fails may still have ended the image: its VM can
          // quit without writing its file.
          if (args.save === true) await server.sendToolListChanged();
          throw error;
        }
        await server.sendToolListChanged();
        return stopAnswer(stopped, args.all === true);
      }
      default:
        return deleteAnswer(await deleteImage(projectRoot, args.name));
    }
  }

  await server.connect(new StdioServerTransport());
}
