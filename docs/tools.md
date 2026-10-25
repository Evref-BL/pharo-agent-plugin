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
pharo-agent pharo tool_call '{"name":"package_search","arguments":{"name":"MCP"}}'
```

A tool `pharo list` names is called directly. One found through the catalogue
is called through `tool_call`, which takes the tool's own arguments nested.

## As an MCP server

```sh
pharo-agent mcp
```

Serves the advertised tools over stdio for a host that speaks MCP, scoped to
this project. Each tool gains an optional `image` argument; everything else is
the image's own schema.

## Editing source as files

`open` mounts the image's source below `.pharo-agent/mounts`, with `tonel`,
`repositories`, `critiques` and `errors` directories. Reading and editing those
files is often simpler than calling a tool, and the two views are of the same
live image.
