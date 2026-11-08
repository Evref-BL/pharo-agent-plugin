---
name: pharo-feedback
description: Look back on how the Pharo tools served this conversation and propose GitHub issues for what failed, misled you or was missing. Use when the user asks for feedback on the Pharo tools or wants to report a problem with them. At the end of Pharo work in which a tool failed, misled you or needed a workaround, offer it once; never file anything unasked.
---

# Pharo tool feedback

The Pharo tools improve from what their users run into, and you saw this
conversation's tool calls more closely than anyone. Turn what got in your way
into issues the maintainers can act on. Issues are public: file only what the
user approves.

## Look back

Go over this conversation's calls to the Pharo tools, whether through this
plugin's MCP tools or the `pharo-agent` command, and keep what the tools did
wrong:

- a call failed with an error you could not have avoided: an internal error, a
  Smalltalk exception, a timeout;
- a call failed on your input, and its description, schema or error message
  led you there or did not say what was wrong;
- a search missed a tool that existed, or found it only after several tries;
- an answer was wrong, partial, too large to use, or said less than you needed;
- a warning or the Pharo guidance sent you the wrong way;
- you fell back to `image_evaluate`, a shell or the files because no tool did
  what you needed;
- one step took several attempts.

Leave out your own slips that a clear error caught, bugs in the user's project,
and passing trouble such as a network outage, unless the tool handled it badly.
If the conversation was summarized, say what you can no longer see rather than
reconstruct it.

Then ask the user whether a tool got in their way in a way you did not notice.

## Where each one goes

- The image's own tools, from classes, methods and tests to repositories,
  search and evaluation, and the Pharo guidance copied into the project
  (`pharo.AGENTS.md`, the `pharo-*` skills and references): `Evref-BL/MCP`.
- Everything else this plugin brings, such as the `image_*` tools, the source
  projection, setup, the `pharo-agent` command and the passing of calls between
  the host and an image: `Evref-BL/pharo-agent-plugin`. Its maintainers move an
  issue to the component that owns it.

When the project loads an MCP of its own into the image, that project answers
for the image's tools.

## Before proposing

Look for the same problem among each repository's issues, open and closed:

```sh
gh issue list --repo Evref-BL/MCP --state all --search "<words>"
```

Where one exists, propose a comment adding what this conversation showed
instead of a new issue.

## Drafting

One issue per problem; findings that share a cause make one issue. Title it
with what goes wrong, in the tool's own terms. Keep the body short:

- **Tool:** its name; `pharo-agent 0.14.1`; the image's Pharo version, which
  `image_list` gives; the host you run in.
- **What happened:** what you asked for and what came back, the error quoted
  and trimmed.
- **Expected:** what would have served.
- **Workaround:** what worked instead, or none.
- **To reproduce:** the smallest call that shows it.

End with: "Reported through the pharo-agent feedback skill."

Issues are public. Leave out the project's code, class and package names,
paths, URLs, and anything that identifies the user or their organization.
Reproduce on Pharo's own classes, such as `Object` or `OrderedCollection`, or
describe the shape of what you had. When a problem cannot be shown without the
project's material, say so and let the user decide.

## Propose, then file

Show every draft in full, with its repository, and ask which to file. File only
those the user names:

```sh
gh issue create --repo Evref-BL/MCP --title "<title>" --body-file <draft>
```

Without `gh` or its login, give each draft as a link that opens the form
already filled, `https://github.com/<owner>/<repo>/issues/new?title=…&body=…`
with both values URL-encoded, and let the user submit it. A comment on an
existing issue goes the same way.

Report what was filed, with its link.
