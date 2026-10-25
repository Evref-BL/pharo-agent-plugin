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

export async function callImageTool(projectRoot, open, toolName, argumentsValue) {
  const { gateway, mcpServerId } = await imageGateway(projectRoot, open);
  const result = await gateway.routeToImage({
    mcpServerId,
    toolName,
    arguments: argumentsValue,
  });
  if (!result.ok) {
    throw new Error(result.error ?? `Pharo tool ${toolName} failed.`);
  }
  return result.data;
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
  const toolNames = new Set(tools.map((tool) => tool.name));

  const server = new Server(
    { name: "pharo-agent", version },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!toolNames.has(request.params.name)) {
      throw new Error(`Unknown Pharo tool: ${request.params.name}`);
    }
    const { image, ...argumentsValue } = request.params.arguments ?? {};
    const open = readOpenImage(projectRoot, image);
    return toolResult(
      await callImageTool(projectRoot, open, request.params.name, argumentsValue),
    );
  });

  await server.connect(new StdioServerTransport());
}
