import { PlexusGateway } from "@evref-bl/plexus-gateway";
import { createGatewayServerWithOptions } from "@evref-bl/plexus-gateway";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readJson, selectRunningImage } from "./runtime.js";

export async function activeGateway(projectRoot, active) {
  const state = readJson(active.statePath);
  const { image, mcpServerId } = selectRunningImage(state);
  if (image.id !== active.imageId || mcpServerId !== active.mcpServerId) {
    throw new Error("The active PLexus image changed; run pharo-agent open again.");
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
    statePath: active.statePath,
    state,
  });
  if (!registered.ok) {
    throw new Error(registered.error ?? "Cannot register the PLexus route.");
  }
  return { gateway, mcpServerId };
}

export async function callActiveTool(projectRoot, active, toolName, argumentsValue) {
  const { gateway, mcpServerId } = await activeGateway(projectRoot, active);
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

export async function listActiveTools(projectRoot, active) {
  const { gateway } = await activeGateway(projectRoot, active);
  return gateway.refreshPharoTools();
}

export async function serveActiveMcp(projectRoot, active) {
  const { gateway, mcpServerId } = await activeGateway(projectRoot, active);
  const server = createGatewayServerWithOptions(gateway, { fixedMcpServerId: mcpServerId });
  await server.connect(new StdioServerTransport());
}
