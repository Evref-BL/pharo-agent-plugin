import { createRequire } from "node:module";
import { PlexusGateway } from "@evref-bl/plexus/gateway";
import { loadProjectState } from "@evref-bl/plexus";
import { toolContractFrom } from "./mcpYaml.js";
import {
  selectRunningImage,
  unappliedPharoMcpPin,
} from "./runtime.js";

// Read rather than restate: a hard-coded version is one more place for a
// release to forget, and the host shows this one to the user.
export const { version } = createRequire(import.meta.url)("../package.json");

// A route source is the directory, not the route. PLexus re-reads the state
// file and the image's endpoint handoff every time it resolves one, so there
// is nothing to register here and nothing that can go stale between the call
// that started the image and this one.
export function imageGateway(projectRoot, running) {
  const state = loadProjectState(running.statePath);
  if (!state) {
    throw new Error(`PLexus has no state at ${running.statePath}.`);
  }
  const { image, mcpServerId } = selectRunningImage(state, running.imageId);
  if (image.id !== running.imageId || mcpServerId !== running.mcpServerId) {
    throw new Error(`The PLexus image ${running.imageId} changed; run pharo-agent image start again.`);
  }
  const gateway = new PlexusGateway({
    routeSources: [{ projectRoot, statePath: running.statePath }],
    pharoScope: {
      projectId: state.projectId,
      workspaceId: state.workspaceId,
    },
    pharoToolSchemaMcpServerId: mcpServerId,
  });
  return { gateway, mcpServerId, image };
}

// An image whose Pharo MCP predates 2.1.0 resolves tools/call against the
// advertised list, so a tool it holds but does not advertise answers -32601.
// That is the loudest way an unapplied pin shows itself, and the message
// alone sends a reader looking for a tool that is right there.
const methodNotFound = "-32601";

export function toolFailureMessage(error, image) {
  const unappliedPin = error.includes(methodNotFound) ? unappliedPharoMcpPin(image) : undefined;
  return unappliedPin ? `${error}\n${unappliedPin}` : error;
}

export async function callImageTool(projectRoot, running, toolName, argumentsValue) {
  const { gateway, mcpServerId, image } = imageGateway(projectRoot, running);
  const result = await gateway.routeToImage({
    mcpServerId,
    toolName,
    arguments: argumentsValue,
  });
  if (result.ok) {
    return result.data;
  }
  throw new Error(
    toolFailureMessage(result.error ?? `Pharo tool ${toolName} failed.`, image),
  );
}

export async function listImageTools(projectRoot, running) {
  const { gateway } = imageGateway(projectRoot, running);
  return gateway.refreshPharoTools();
}

// PLexus adds its routing handle to every schema it lists; a caller never
// passes it, so the CLI neither offers nor describes it.
function withoutRouting(tool) {
  const { required: listed = [], ...schema } = tool.inputSchema ?? {};
  const properties = { ...(schema.properties ?? {}) };
  delete properties.mcpServerId;
  const required = listed.filter((name) => name !== "mcpServerId");
  return { ...tool, inputSchema: { ...schema, properties, ...(required.length ? { required } : {}) } };
}

export async function listAdvertisedTools(projectRoot, running) {
  return (await listImageTools(projectRoot, running)).map(withoutRouting);
}

/**
 * A tool's contract: from the advertised list when it is there, otherwise
 * from tool_get, which reaches the rest of the catalogue.
 */
export async function toolContract(projectRoot, running, toolName) {
  const advertised = (await listAdvertisedTools(projectRoot, running)).find((tool) => tool.name === toolName);
  if (advertised) return advertised;
  const answer = /** @type {{ isError?: boolean, content?: { text?: string }[] }} */ (
    await callImageTool(projectRoot, running, "tool_get", { name: toolName })
  );
  const contract = answer?.isError ? undefined
    : toolContractFrom((answer?.content ?? []).map((part) => part.text ?? "").join("\n"));
  if (!contract) {
    throw new Error(`Image ${running.imageId} has no tool ${toolName}. pharo-agent tool_search <words> finds one.`);
  }
  return withoutRouting(contract);
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
