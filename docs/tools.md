# Tools

The commands the project's Pharo guidance hands to the agent, written out here
for a human reading along.

```sh
pharo-agent pharo list
pharo-agent pharo <tool> [arguments-json]
```

## The advertised surface is not the whole catalogue

`pharo list` names the tools the image advertises: the common ones, covering
classes, methods, tests and evaluation. The image holds many more — packages,
repositories, change history, debuggers, screen reading — and keeps them out of
that list so their schemas stay out of an agent's context.

Find them through the catalogue:

```sh
pharo-agent pharo tool_search '{"query":"repository commit"}'
pharo-agent pharo tool_get '{"name":"repository_commit"}'
```

`tool_search` ranks the catalogue by keyword and answers the closest tools even
when none matches every word. `tool_get` returns one tool's input schema. Read
the schema before calling anything less common.

## Calling one

```sh
pharo-agent pharo class_search '{"name":"Point"}'
pharo-agent pharo package_search '{"name":"MCP"}'
```

Every tool the image holds is called the same way, whether or not `pharo list`
names it. `tool_call` is there for a client that will only send a name from
its own list; a terminal is not one.

A tool that fails prints its error and exits nonzero, so a script may test the
status rather than read the JSON.

## As an MCP server

```sh
pharo-agent mcp
```

Serves the advertised tools over stdio for a host that speaks MCP, scoped to
this project. Each tool gains an optional `image` argument; everything else is
the image's own schema.

Five tools of its own come first, listed whether or not an image is running:
`image_templates`, `image_add`, `image_start`, `image_list` and `image_stop`.
A chat that has the plugin enabled can take a project from no images to a
running one without a shell.

## A different MCP in the image

The tools are the image's, so a project that wants other tools can serve
another MCP. `mcp.loadScript` in `plexus.json` names a Smalltalk file the
image files in at start; when that file is there it is what loads, and the
pinned Pharo MCP release is the fallback for when it is not.

What PLexus expects back is a class, not a registration call. Its startup
script asks the image for a global named `MCP` and sends it four messages:

```smalltalk
mcp := (Smalltalk globals at: #MCP) new.
mcp port: 0.
mcp start.
endpointPort := mcp port.
```

It records the port that came back and forwards calls there, so a server
built on MCP's core and installed under that name is served like any other,
with whatever tools it advertises. A load that leaves no `MCP` global fails
the start and says so.

`mcp.loadPolicy` decides whether the load happens at all: `ifMissing`, the
default, leaves an image that already carries a server alone.

## Editing source as files

`image start` mounts the image's source below `.pharo-agent/mounts`, with `tonel`,
`repositories`, `critiques` and `errors` directories. Reading and editing those
files is often simpler than calling a tool, and the two views are of the same
live image.
