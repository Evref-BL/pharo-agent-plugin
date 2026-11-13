import { createRequire } from "node:module";
import { callTool, listTools } from "@evref-bl/plexus";
import { olderMcpWarning, projectImages } from "./images.js";
import { toolContractFrom } from "./mcpYaml.js";
import { resolveImageName } from "./project.js";

// Read rather than restate: a hard-coded version is one more place for a
// release to forget, and the host shows this one to the user.
export const { version } = createRequire(import.meta.url)("../package.json");

/**
 * @typedef {{
 *   name: string,
 *   images: import("@evref-bl/plexus").Images,
 *   endpoint: import("@evref-bl/plexus").Endpoint,
 * }} Target
 */

/**
 * The image a call goes to, the one named or the default, and where it
 * answers. Asked for every call rather than kept: the image may have exited,
 * or been started again on another port, since the last one.
 *
 * @param {string} projectRoot
 * @param {string} [name]
 * @returns {Promise<Target>}
 */
export async function imageTarget(projectRoot, name) {
  const images = projectImages(projectRoot);
  const resolved = resolveImageName(projectRoot, name);
  return { name: resolved, images, endpoint: await images.endpoint(resolved) };
}

// An image whose Pharo MCP predates 2.1.0 resolves tools/call against the
// advertised list, so a tool it holds but does not advertise answers -32601.
// That is the loudest way an older MCP shows itself, and the message alone
// sends a reader looking for a tool that is right there.
const methodNotFound = "-32601";

export function toolFailureMessage(message, row) {
  const warning = row && message.includes(methodNotFound) ? olderMcpWarning(row) : undefined;
  return warning ? `${message}\n${warning}` : message;
}

/** @param {Target} target */
export async function callImageTool(target, toolName, argumentsValue) {
  try {
    return await callTool(target.endpoint, toolName, argumentsValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(methodNotFound)) throw error;
    const row = await target.images.list(target.name).then(([found]) => found, () => undefined);
    throw new Error(toolFailureMessage(message, row));
  }
}

/** @param {Target} target */
export async function listImageTools(target) {
  return listTools(target.endpoint);
}

/**
 * A tool's contract: from the advertised list when it is there, otherwise
 * from tool_get, which reaches the rest of the catalogue.
 *
 * @param {Target} target
 * @param {string} toolName
 */
export async function toolContract(target, toolName) {
  const advertised = (await listImageTools(target)).find((tool) => tool.name === toolName);
  if (advertised) return advertised;
  const answer = /** @type {{ isError?: boolean, content?: { text?: string }[] }} */ (
    await callImageTool(target, "tool_get", { name: toolName })
  );
  const contract = answer?.isError ? undefined
    : toolContractFrom((answer?.content ?? []).map((part) => part.text ?? "").join("\n"));
  if (!contract) {
    throw new Error(`Image ${target.name} has no tool ${toolName}. pharo-agent tool_search <words> finds one.`);
  }
  return contract;
}

export function withImageSelector(tool, defaultImage) {
  const inputSchema = tool.inputSchema ?? {};
  const properties = {
    ...(inputSchema.properties ?? {}),
    image: {
      type: "string",
      description: `Project image to call. Defaults to ${defaultImage}.`,
    },
  };
  return { ...tool, inputSchema: { ...inputSchema, properties } };
}

export function toolResult(data) {
  if (data && typeof data === "object" && Array.isArray(data.content)) {
    return data;
  }
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
