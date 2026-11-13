# Tools

The commands the project's Pharo guidance hands to the agent, written out here
for a human reading along.

```sh
pharo-agent list
pharo-agent <tool> [<value>] [--<argument> <value>]...
```

## The advertised surface is not the whole catalogue

`list` names the tools the image advertises, one line each: the common ones,
covering classes, methods, tests and evaluation. The image holds many more —
packages, repositories, change history, debuggers, screen reading — and keeps
them out of that list so their schemas stay out of an agent's context.

Find them through the catalogue:

```sh
pharo-agent tool_search repository commit
pharo-agent repository_commit --help
```

`tool_search` ranks the catalogue by keyword and answers the closest tools even
when none matches every word. A tool's `--help` lists its arguments, read from
its schema.

## Calling one

```sh
pharo-agent class_get Point
pharo-agent test_run --classes PointTest --classes RectangleTest
pharo-agent method_compile --class Point --protocol accessing --source - <<'EOF'
x
	^ x
EOF
```

A tool's arguments are its flags: repeated for a list, alone for true
(`--no-<flag>` for false), JSON for one that is itself an object. A bare value
fills the tool's one required argument, or its only one. A value of `-` is read
from standard input, so code needs no quoting. Every tool the image holds is
called the same way, whether or not `list` names it.

The answer is the text the tool wrote. `--json` prints the MCP result instead,
for a script; a tool that fails exits nonzero either way.

## As an MCP server

```sh
pharo-agent mcp
```

Serves the default image's advertised tools over stdio for a host that speaks
MCP, scoped to this project; `--image <name>` serves another image's. Each
tool gains an optional `image` argument naming the image a call goes to;
everything else is the image's own schema.

The server's own `image_*` tools come first, listed whether or not an image is
running, so a chat that has the plugin enabled can take a project from no
images to a running one without a shell.

## A different MCP in the image

The tools are the image's, so a project that wants other tools can serve
another MCP. `image create --script <file>` builds the image from its template
and files that Smalltalk script in, in place of the pinned Pharo MCP release:

```sh
pharo-agent image create mine --template 'Pharo 14.0 - 64bit (stable)' --script load-my-mcp.st
```

What PLexus expects back is a class, not a registration call. At every start
it asks the image for a global named `MCP`, starts a server on a port of the
system's choosing, and reads back the port it bound:

```smalltalk
mcp := (Smalltalk globals at: #MCP) new.
mcp port: 0.
mcp start.
endpointPort := mcp port.
```

It forwards calls to that port, so a server built on MCP's core and installed
under that name is served like any other, with whatever tools it advertises.
A script that leaves no `MCP` global fails the create, and says so.

With `--every-start`, PLexus files the script in again at every start, before
the server starts, so an image whose script loads a checkout follows that
checkout. It is read from the path it had when the image was created.

## Editing source as files

`image start` mounts the image's source below `.pharo-agent/mounts`, with `tonel`,
`repositories`, `critiques` and `errors` directories. Reading and editing those
files is often simpler than calling a tool, and the two views are of the same
live image.
