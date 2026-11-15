// The plugin's answers to its image tools: PLexus's, which say the same in
// both servers that serve these tools, with what this package adds: the
// project's default image, the source mounts, and where a call goes.
import path from "node:path";
import { imageToolAnswers } from "@evref-bl/plexus";
import { missingDefault } from "./gateway.js";

const { texts } = imageToolAnswers;

/** @typedef {import("@evref-bl/plexus").ToolAnswer} ToolAnswer */
/** @typedef {import("@evref-bl/plexus").ImageInfo} ImageInfo */
/**
 * What a start through this package did: PLexus's start, the image as listed
 * before it, the mount when its source mounted, and otherwise why not, when
 * that is to be said: not when projections are off, or the platform has none.
 *
 * @typedef {import("@evref-bl/plexus").StartResult & {
 *   row: ImageInfo,
 *   mountPath?: string,
 *   projectionPort?: number,
 *   notMounted?: string,
 * }} AgentStart
 */
/**
 * What a stop through this package did: PLexus's stops, and the running
 * images a stop of all of them left, which take no calls.
 *
 * @typedef {{ stopped: { name: string, killed: number[] }[], left: ImageInfo[] }} AgentStop
 */

/**
 * A path as an answer gives it: from the project root when it is inside it,
 * as it is otherwise.
 *
 * @param {string} projectRoot
 * @param {string} target
 */
export function pathFrom(projectRoot, target) {
  const relative = path.relative(projectRoot, target);
  const outside = relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
  return outside ? target : relative;
}

/**
 * Said where an agent takes up an image, by a start from the terminal or
 * from the server: a call that names no image does not follow the image
 * just started.
 *
 * @param {string} name the image started
 * @param {string} [defaultImage] where a call naming none goes
 */
export function callsNote(name, defaultImage) {
  if (name === defaultImage) return undefined;
  return defaultImage === undefined
    ? `Pass image: "${name}" to its tools.`
    : `Pass image: "${name}" to its tools: a call that names no image goes to ${defaultImage}, the default image.`;
}

/**
 * What `pharo-agent image use` did. It has no MCP tool: setting the default
 * is the terminal's.
 *
 * @param {string} name
 */
export function defaultChosen(name) {
  return `The project's default image is ${name} now.`;
}

/**
 * A start or a stop through the server that names no image, in a project
 * with no default. The terminal says it with its own commands.
 */
export function noDefaultImage() {
  return "No image is named, and this project has no default image. Name one, or create one with"
    + " image_create; the first image created becomes the default.";
}

/**
 * Why a start mounted no source, said once its tools answer: PIFS's reason,
 * or a projection setting the plugin does not take.
 *
 * @param {string} reason
 */
export function noSourceMounted(reason) {
  return `No source is mounted: ${reason} Read and edit its code through its tools.`;
}

/** @param {ToolAnswer} answer @param {string | undefined} sentence */
function adding(answer, sentence) {
  return sentence === undefined ? answer : { ...answer, summary: `${answer.summary} ${sentence}` };
}

/** @param {{ templates: import("@evref-bl/plexus").Template[] }} listed */
export function templatesAnswer(listed) {
  return imageToolAnswers.templates(listed.templates);
}

/**
 * Every image of the project, with the mount of each whose source is
 * mounted, and which is the default.
 *
 * @param {string} projectRoot
 * @param {{ defaultImage?: string, images: (ImageInfo & { mountPath?: string })[] }} listed
 * @param {boolean} chosen whether the default is the one the server was started with
 * @returns {ToolAnswer}
 */
export function listAnswer(projectRoot, listed, chosen) {
  const answer = imageToolAnswers.list(listed.images, (row) => {
    const { mountPath } = /** @type {{ mountPath?: string }} */ (row);
    return mountPath === undefined ? [] : [["mount", pathFrom(projectRoot, mountPath)]];
  });
  return adding(answer, defaultSaid(listed.images, listed.defaultImage, chosen));
}

/**
 * @param {ImageInfo[]} rows
 * @param {string | undefined} defaultImage
 * @param {boolean} chosen
 */
function defaultSaid(rows, defaultImage, chosen) {
  if (defaultImage === undefined) {
    // With no image either, there is nothing to name, and PLexus says how
    // to make the first, which becomes the default.
    return rows.length === 0 ? undefined
      : "There is no default image: name one on every call, or choose a default with pharo-agent image use <name>.";
  }
  return rows.some((row) => row.name === defaultImage)
    ? `The default image is ${defaultImage}.`
    : `The default image, ${defaultImage}, ${missingDefault(chosen)}.`;
}

/**
 * @param {Parameters<typeof imageToolAnswers.created>[0] & { isDefault: boolean }} created
 * @param {string} [selectedImage] the image the server was started with
 */
export function createAnswer(created, selectedImage) {
  const answer = imageToolAnswers.created(created);
  if (!created.isDefault) return answer;
  return adding(answer, selectedImage === undefined || selectedImage === created.name
    ? "It is the project's default image."
    : `It is the project's default image; a call that names no image still goes to ${selectedImage}.`);
}

/**
 * @param {string} projectRoot
 * @param {AgentStart} start
 * @param {string} [defaultImage] where a call naming no image goes
 * @returns {ToolAnswer}
 */
export function startAnswer(projectRoot, start, defaultImage) {
  const answer = adding(imageToolAnswers.started(start, start.row), callsNote(start.name, defaultImage));
  return {
    ...answer,
    warnings: [...answer.warnings, ...(start.notMounted === undefined ? [] : [noSourceMounted(start.notMounted)])],
    fields: [
      ...answer.fields,
      ...(start.mountPath === undefined ? [] : [/** @type {[string, string]} */ (["mount", pathFrom(projectRoot, start.mountPath)])]),
    ],
  };
}

/**
 * One image stopped, as PLexus says it, or every running image of the
 * project that takes calls, with a warning for each one left running.
 *
 * @param {AgentStop} result
 * @param {boolean} [all]
 * @returns {ToolAnswer}
 */
export function stopAnswer(result, all = false) {
  const { stopped, left } = result;
  const warnings = left.map(leftRunning);
  if (!all || stopped.length === 1) return { ...imageToolAnswers.stopped(stopped[0]), warnings };
  if (stopped.length === 0) {
    // Not "was running": the warnings say which images still run.
    return {
      summary: left.length === 0 ? "No image of this project was running." : "No image of this project was stopped.",
      warnings,
      fields: [],
    };
  }
  return {
    summary: `Stopped ${texts.andList(stopped.map((each) => each.name))}; what they had not saved is lost.`,
    warnings,
    fields: [],
  };
}

/**
 * A stop of all leaves an image that takes no calls: a VM it cannot tell is
 * one a person started, or one a create still runs.
 *
 * @param {ImageInfo} row
 */
function leftRunning(row) {
  return row.building
    ? `Left ${row.name} running: it is still being created.`
    : `Left ${row.name} running: ${row.endpointProblem}, so only image_stop with its name stops it.`;
}

/**
 * @param {{ name: string, clearedDefault?: boolean }} deleted
 * @param {string} [selectedImage] the image the server was started with
 */
export function deleteAnswer(deleted, selectedImage) {
  const answer = imageToolAnswers.deleted(deleted);
  if (!deleted.clearedDefault) return answer;
  return adding(answer, [
    "It was the project's default image; the next image created becomes the default.",
    ...(selectedImage === undefined || selectedImage === deleted.name
      ? [] : [`A call that names no image still goes to ${selectedImage}.`]),
  ].join(" "));
}

/**
 * The answer's warnings as the one `warning` field of the JSON the terminal
 * prints, absent when the answer has none.
 *
 * @param {ToolAnswer} answer
 */
function warningOf(answer) {
  return answer.warnings.length === 0 ? {} : { warning: answer.warnings.join("\n") };
}

/**
 * A start as JSON: PLexus's result and the mount, as before the answers were
 * text.
 *
 * @param {AgentStart} start
 * @param {ToolAnswer} answer
 */
export function startJson(start, answer) {
  const { row: _row, notMounted: _notMounted, ...result } = start;
  return { ...result, ...warningOf(answer) };
}

/**
 * @param {AgentStop} result
 * @param {ToolAnswer} answer
 */
export function stopJson(result, answer) {
  return { stopped: result.stopped, ...warningOf(answer) };
}

/**
 * What a forwarded call that failed did to its image, in PLexus's words, or
 * nothing for a call its caller cancelled, which is answered nothing. Only
 * for a call the agent made: this package's own calls keep their errors, and
 * would otherwise report a call the agent never made.
 *
 * @param {import("./gateway.js").Target} target
 * @param {string} tool
 * @param {unknown} error what callImageTool rejected with
 * @returns {Promise<string | undefined>}
 */
export async function callFailedText(target, tool, error) {
  const answer = await imageToolAnswers.callFailed(
    target.name,
    tool,
    error,
    async () => (await target.images.list(target.name))[0],
  );
  return answer === undefined ? undefined : imageToolAnswers.render(answer);
}
