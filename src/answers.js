// The plugin's answers to its image tools: PLexus's, which say the same in
// both servers that serve these tools, with what this package adds.
import { imageToolAnswers } from "@evref-bl/plexus";

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
