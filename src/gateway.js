import { createRequire } from "node:module";
import { PlexusGateway } from "@evref-bl/plexus-gateway";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readJson, readOpenImage, selectRunningImage } from "./runtime.js";

// Read rather than restate: a hard-coded version is one more place for a
// release to forget, and the host shows this one to the user.
export const { version } = createRequire(import.meta.url)("../package.json");

export async function imageGateway(projectRoot, open) {
  const state = readJson(open.statePath);
  const { image, mcpServerId } = selectRunningImage(state, open.imageId);
  if (image.id !== open.imageId || mcpServerId !== open.mcpServerId) {
    throw new Error(`The PLexus image ${open.imageId} changed; run pharo-agent open again.`);
  }
  const gateway = new PlexusGateway({
    pharoScope: {
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      targetId: state.targetId,
    },
    pharoToolSchemaMcpServerId: mcpServerId,
  });
  const registered = await gateway.registerProjectRoute({
    projectRoot,
    statePath: open.statePath,
    state,
  });
  if (!registered.ok) {
    throw new Error(registered.error ?? "Cannot register the PLexus route.");
  }
  return { gateway, mcpServerId };
}

const catalogueDispatcher = "tool_call";
const methodNotFound = "-32601";

// An image resolves tools/call against its registry from Pharo MCP 2.1.0 on;
// before that it resolved against the advertised list, so a tool the image
// holds but does not advertise answered -32601. The project contract accepts
// any image on the same major version, so those images are supported ones,
// and tool_call reaches the tool there. Retry through it rather than let the
// documented command be a lie on an image we accept.
export async function callToolThroughGateway(call, toolName, argumentsValue) {
  const result = await call(toolName, argumentsValue);
  if (result.ok) {
    return result.data;
  }
  if (toolName !== catalogueDispatcher && (result.error ?? "").includes(methodNotFound)) {
    const dispatched = await call(catalogueDispatcher, {
      name: toolName,
      arguments: argumentsValue,
    });
    if (dispatched.ok) {
      return dispatched.data;
    }
  }
  throw new Error(result.error ?? `Pharo tool ${toolName} failed.`);
}

export async function callImageTool(projectRoot, open, toolName, argumentsValue) {
  const { gateway, mcpServerId } = await imageGateway(projectRoot, open);
  return callToolThroughGateway(
    (name, args) => gateway.routeToImage({ mcpServerId, toolName: name, arguments: args }),
    toolName,
    argumentsValue,
  );
}

export async function listImageTools(projectRoot, open) {
  const { gateway } = await imageGateway(projectRoot, open);
  return gateway.refreshPharoTools();
}

export function withImageSelector(tool, defaultImage) {
  const inputSchema = tool.inputSchema ?? {};
  const properties = { ...(inputSchema.properties ?? {}) };
  delete properties.mcpServerId;
  properties.image = {
    type: "string",
    description: `Project image to call. Defaults to ${defaultImage}.`,
  };
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((value) => value !== "mcpServerId")
    : [];
  return { ...tool, inputSchema: { ...inputSchema, properties, required } };
}

export function toolResult(data) {
  if (data && typeof data === "object" && Array.isArray(data.content)) {
    return data;
  }
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export async function serveImagesMcp(projectRoot, defaultImage) {
  const defaultOpen = readOpenImage(projectRoot, defaultImage);
  const tools = (await listImageTools(projectRoot, defaultOpen))
    .map((tool) => withImageSelector(tool, defaultImage));

  const server = new Server(
    { name: "pharo-agent", version },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Listed tools are the common ones, not the whole catalogue, and the image
    // answers for any tool it holds. Refusing a name this list does not carry
    // would hide tools that tool_search just found, and the image's own error
    // is the better answer for a name nothing holds.
    const { image, ...argumentsValue } = request.params.arguments ?? {};
    const open = readOpenImage(projectRoot, image);
    return toolResult(
      await callImageTool(projectRoot, open, request.params.name, argumentsValue),
    );
  });

  await server.connect(new StdioServerTransport());
}
