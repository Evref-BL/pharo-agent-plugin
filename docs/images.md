# Images

The commands the project's Pharo guidance hands to the agent, written out here
for a human reading along. With the plugin enabled, each `image` command but
`use` is also an MCP tool, `image_create` for `image create` and so on, and
each command prints what its tool answers. `--json` prints the answer as JSON,
for a script.

## What an image is

PLexus keeps every image in one store under its home, `~/.plexus` or
`$PLEXUS_HOME`, one directory per image. A project's images are the
directories whose names start with its scope and a dash, which `init` takes
from the project directory's name and writes in `.pharo-agent/config.json`: in
a project whose scope is `shop`, the image `dev` is the directory `shop-dev`.
A scope holds no dash, so a directory `shop-api` gets the scope `shop_api`,
and its images are never `shop`'s.

Nothing else records an image. It exists while its directory does, and it is
running while a Pharo VM runs its image file. `image list` asks both questions
each time, the way `ps` lists processes, so its answer is true when it is
given and may not be a moment later: an image can exit on its own, and another
session can start or stop one.

## Creating one

```sh
pharo-agent image templates
pharo-agent image create dev --template 'Pharo 14.0 - 64bit (stable)'
```

`image templates` lists every template the launcher offers, under its
category. A name that two categories offer is under both, and the answer says
it needs the category as well:

```sh
pharo-agent image create old --template 'Pharo 10.0 - 64bit' --category 'Pharo Mooc'
```

`image create` makes the image with the Pharo MCP release this plugin pins
loaded in it, saves it, and leaves it stopped. PLexus keeps a prepared copy of
each template it has built from, so the first image of a template takes the
time loading MCP takes, and the next ones are copies. A name is letters,
digits, `.`, `_` and `-`, and a name the project already has is refused.

The first image created is the project's default. `image use <name>` makes
another one the default, and `image delete <name>` deletes a stopped image
and its files, and clears the default when it named that image.

## When to make another image

An image takes one writer, so agents are told to create one for each new
subject or parallel agent rather than share one, and to name it like a branch
(`pretty-print-formatter`, not `p15`).

## Starting and stopping

`image start <name>` starts a stopped image as it was last saved, and answers
once the image's MCP server does. It refuses an image a VM already runs, and
says whether its tools answer. Images run headless; `--display interactive`
opens the image's window.

`image stop <name>` kills the image's VM. It does not save: whatever the image
has not saved is lost, and the image starts again as it was last saved.
`image stop <name> --save` has the image save itself and quit instead, and
answers once its VM is gone and its image file was written; an image that
does not save and quit in time is left running, and the answer says so.
Evaluating `Smalltalk saveSession` in the image saves it without stopping it.
Stopping an image that is not running is not an error. `image stop --all`
stops every running image of the project that PLexus started and can reach;
a VM started by hand, or by an older PLexus, stops only when its image is
named. With `--save`, each of them saves itself, and one that does not is
left running and named in the answer.

Without a name, `image start` and `image stop` act on the default image. A
tool command, `list` and `mcp` take `--image <name>`, which scopes a call
rather than naming a subject, and the default image answers without it. Over
`mcp`, each Pharo tool takes the same `image` argument. Starting an image other
than the default, from the terminal or over `mcp`, says to pass its name to its
tools.

## When an image exits

An image can exit without being stopped: it crashes, or its window is closed.
`image list` then shows it as not running, and the `mcp` server lists its own
tools without the image's. `image start` starts it again. Its source
projection unmounts on its own a few seconds after the image exits: the
daemon serving it watches the image. An image that `image stop --save` stops
is left to unmount the same way, so that one whose save fails keeps its
source.

## Where the source projection works

An image and its Pharo tools run anywhere Node does. Projecting its source as
files works on macOS, with nothing to install, and on Linux with FUSE 3. A
start that mounts says where, from the project root when the mount is inside
it, and `image list` gives the same path as the image's `mount=`:

```text
Started image dev as it was last saved.
mount: .pharo-agent/mounts/dev
```

When PIFS cannot mount, `image start` keeps the image and passes on why:

```text
Started image dev as it was last saved.
Warning: No source is mounted: pharo-image-fs daemon exited before mounting /home/me/project/.pharo-agent/mounts/dev. The daemon logged: FUSE needs fusermount3, which the fuse3 package installs. Set PHARO_AGENT_PROJECTION=off to start images without trying to mount. Read and edit its code through its tools.
```

The image is running and fully usable. A start without a mount answers no
`mount` line, its record in `image list` has no `mount=`, and `image stop` has
nothing extra to unmount. A start whose outcome PIFS does not report, such as
a call that fails, stops the image instead, since its projection may have
mounted anyway, and says so.

Setting `PHARO_AGENT_PROJECTION=off` in the environment starts every image
without asking PIFS, wherever it runs, and so does a system PIFS has no daemon
for: the answer has neither a `mount` line nor a warning. Any other value of
the variable mounts nothing either, and its warning says the variable takes
only `off`.

## An image made with another MCP

An image keeps the MCP it was created with. Once this plugin pins another
release, `image list` and `image start` say so for an image created before,
and a `-32601` from that image repeats it: a tool that is plainly in the
catalogue, and answers that it does not exist, is otherwise a puzzle. To get
the pinned release, stop the image, delete it and create it again.

The image tools cover a range of Pharo versions. On a version the pinned MCP
does not load on, `image create` fails with the load's own error; an image
made with a script of your own brings its tools another way
([Tools](tools.md#a-different-mcp-in-the-image)).

## Where things live

The images are in PLexus's store. `.pharo-agent/config.json` holds the
project's scope, its default image and its mount root. `.pharo-agent/mounts`
holds the projections, and `.pharo-agent/runtime` the record of which VM this
project mounted where. All three describe this checkout and are git-ignored.
Pass `--mount-root <path>` to `init` to project somewhere else.
