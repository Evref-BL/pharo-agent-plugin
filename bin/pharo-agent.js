#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { hosts, install, Refusal, skillsDirectory, thisRelease } from "../src/install.js";

const usage = `Usage: pharo-agent install --host <codex|opencode>

Writes into the project in the current directory what a host without the
plugin needs: the skills, into ${skillsDirectory}, and the pharo server entry,
into .codex/config.toml or opencode.json. Run a later release's to update
them. Claude Code installs the plugin from its marketplace instead.`;

/** Exits 0 on success, 1 on a refusal and 2 on a command line it cannot read. */
function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage);
    return 0;
  }
  if (argv.length === 1 && argv[0] === "--version") {
    console.log(thisRelease().version);
    return 0;
  }

  const [command, ...options] = argv;
  if (command !== "install") {
    return unreadable(command === undefined ? "Missing the command" : `Unknown command ${command}`);
  }
  let host;
  for (let index = 0; index < options.length; index++) {
    const [option, inline] = options[index].split(/=(.*)/s, 2);
    if (option !== "--host") {
      return unreadable(`Unknown option ${option}`);
    }
    host = inline ?? options[++index];
    if (host === undefined || host.trim() === "") {
      return unreadable("--host needs a value");
    }
  }
  if (host === undefined) {
    return unreadable("Missing --host");
  }

  const key = host.trim().toLowerCase();
  if (key === "claude" || key === "claude-code") {
    console.error(
      "pharo-agent: Claude Code installs the plugin itself: /plugin marketplace add Evref-BL/pharo-agent-plugin, then /plugin install pharo-agent@evref-bl.",
    );
    return 1;
  }
  if (!Object.hasOwn(hosts, key)) {
    return unreadable(`--host is ${Object.keys(hosts).join(" or ")}`);
  }

  try {
    const done = install({ host: key, project: process.cwd() });
    const lines = [
      `Installed pharo-agent ${done.release.version} for ${done.host} in ${process.cwd()}:`,
      `  ${skillsDirectory}: ${done.skills.join(", ")}`,
      ...(done.removed.length > 0 ? [`  removed from ${skillsDirectory}: ${done.removed.join(", ")}`] : []),
      `  ${done.config}: the pharo server, running PLexus ${done.release.plexus}`,
      fetchPlexus(done.release.plexus),
      key === "codex"
        ? "Codex reads .codex/config.toml in a trusted project only. A new session loads both."
        : "A new session loads both.",
    ];
    console.log(lines.join("\n"));
    return 0;
  } catch (error) {
    if (error instanceof Refusal) {
      console.error(`pharo-agent: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

/**
 * Fetches the server's PLexus into npx's cache now, as the host's first
 * session would. A session that ended during that fetch left the next one
 * without the server until its lock went stale.
 */
function fetchPlexus(version) {
  // An npx that ran this passes its own package down, which would replace
  // the one asked for here.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^npm_config_(package|call)$/i.test(name)),
  );
  const fetched = spawnSync("npx", ["--yes", `@evref-bl/plexus@${version}`, "--version"], {
    encoding: "utf8",
    env,
    timeout: 300_000,
    // npx is a .cmd file on Windows, which Node runs only through a shell.
    shell: process.platform === "win32",
  });
  return fetched.status === 0
    ? `  npx: PLexus ${version} fetched, so the first session starts at once`
    : `  npx: PLexus ${version} could not be fetched now; the first session fetches it`;
}

function unreadable(message) {
  console.error(`pharo-agent: ${message}\n\n${usage}`);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
