# Images

The commands the project's Pharo guidance hands to the agent, written out here
for a human reading along.

A project declares its images in `plexus.json`. Declaring one does not create
it; the first `image start` does.

## Choosing a template

```sh
pharo-agent image templates
```

Every template the launcher offers, with the category of each. A name that two
categories offer is flagged, and needs the category as well:

```sh
pharo-agent image add old --template 'Pharo 10.0 - 64bit' --category 'Pharo Mooc'
```

`--profile <id>` puts the image under a particular launcher profile.

With the plugin enabled, the same two steps are MCP tools — `image_templates`
and `image_add`, which takes `id`, `template`, and `category` or `profile`
when they are needed. Declaring an image is the one step that used to need a
shell.

## When to make another image

An image takes one writer, so agents are told to make a new one, in seconds,
for each new subject or parallel agent rather than share one, and to name it
like a branch (`pretty-print-formatter`, not `p15`). The first image declared
is the default, the main line.

## Managing declarations

`image list` shows what the project declares, which is the default, and the
mount and projection port of each image that is running. `image use <id>`
changes the default, and `image remove <id>` drops a declaration. A running
image has to be stopped before its declaration goes.

## Several images at once

`image start <id>` and `image stop <id>` name their image, the way
`image use <id>` and `image remove <id>` do. A tool command, `list` and `mcp`
take `--image <id>`, which scopes a call rather than naming a subject. Without
either, the default image answers, so a project with one image never names an
image at all.

`image start <id>` adds an image without stopping the others, and
`image stop --all` stops every image this project started. Over `mcp`, each
Pharo tool takes the same optional `image` argument.

## When an image exits

An image can exit without being stopped: it crashes, or its window is closed.
`image list` then lists it as `exited` rather than running, and the `mcp`
server lists its own tools without the image's. `image start` starts it again,
and `image stop` forgets it. Its source projection unmounts on its own a few
seconds after the image exits: the daemon serving it watches the image.

## Where the source projection works

An image and its Pharo tools run anywhere Node does. Projecting its source as
files works on macOS, with nothing to install, and on Linux with FUSE 3. When
the mount fails, `image start` keeps the image and passes on why:

```json
{ "ok": true, "imageId": "dev",
  "warning": "pharo-image-fs daemon exited before mounting /home/me/project/.pharo-agent/mounts/dev. The daemon logged: FUSE needs fusermount3, which the fuse3 package installs. Set PHARO_AGENT_PROJECTION=off to start images without trying to mount. Image dev is running with its Pharo tools and no source projection; read and edit its code through the tools." }
```

A start whose outcome PIFS does not report, such as a call that times out,
stops the image instead, since its projection may have mounted anyway.

The image is running and fully usable; `mountPath` and `projectionPort` are
absent from `image list`, and `image stop` has nothing extra to unmount.
Setting `PHARO_AGENT_PROJECTION=off` in the environment starts every image this
way, wherever it runs, and the warning names the variable.

## Pharo versions outside the MCP range

Any version the launcher offers can be declared. MCP and the source projection
support a range of versions, and an image outside it still starts:

```json
{ "ok": true, "imageId": "old", "mcp": false,
  "warning": "Pharo 10 is outside the supported Pharo MCP range (12, 13, 14, 15). ..." }
```

The image runs, and is yours to drive another way. It offers no Pharo tools
and no source projection, and a tool call against it says so.

## An image that brought its own MCP

An image that already carries a Pharo MCP keeps it: `mcp.loadPolicy` defaults
to `ifMissing`, so the version the project pins is not loaded over one that is
already there. That is what the policy is for, and the image works, but its
tools are whatever that MCP has.

An image created by `image start` is copied from a base prepared with what the
project loads, so its MCP is the project's own and nothing is said. Once the
project loads something else, a newer pin or an edited load script, an image
created before keeps what it was prepared with, and `image start` says so:

```json
{ "ok": true, "imageId": "p13",
  "warning": "Image p13 kept the Pharo MCP it was prepared with, which is not the one this project loads now, ..." }
```

An image whose origin nothing recorded, created before PLexus kept track, gets
the same warning hedged: it started with the Pharo MCP it already had, so the
version the project pins may not be the one it runs.

A `-32601` from such an image repeats the warning: a tool that is plainly in
the catalogue, and answers that it does not exist, is otherwise a puzzle.
Recreate the image to pick the pinned version up, or set `mcp.loadPolicy` to
`always` in `plexus.json` to load it on every start.

## An image that is no longer running

`image start` on an image this project already started answers
`alreadyRunning` — but only after checking that the image is still there. A
Pharo image can exit on its own, and the record of having started it outlives
the process. Answering from the record alone hands back an endpoint nothing
answers, and every later `image start` does it again.

When the process is gone the record goes with it and the image is started
again, which `image start` reports:

```json
{ "ok": true, "imageId": "scratch", "restarted": true, "mountPath": "..." }
```

## Where things live

`.pharo-agent/mounts` holds the projections, `.pharo-agent/runtime` the record
of what is running. Both are git-ignored. Pass `--mount-root <path>` to `init`
to project somewhere else.
