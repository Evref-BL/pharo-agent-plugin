// Loaded with the PLexus hook, before any test and before each pharo-agent
// process a test spawns: a test sends no traces anywhere unless it says so.
// The OTEL_* and trace context of the shell that runs the tests are dropped,
// and the settings file is looked for where there is none, and the
// reachability of collectors is kept in a directory of the run's own. Once, in the
// process that starts the tests: the processes it spawns inherit the result,
// and keep whatever settings a test gives them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const marker = "PHARO_AGENT_TESTS_WITHOUT_TELEMETRY";

if (process.env[marker] === undefined) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OTEL_") || ["TRACEPARENT", "TRACESTATE", "BAGGAGE", "PLEXUS_TELEMETRY"].includes(key)) {
      delete process.env[key];
    }
  }
  const nowhere = path.join(os.tmpdir(), "pharo-agent-tests-have-no-settings");
  process.env.XDG_CONFIG_HOME = nowhere;
  process.env.APPDATA = nowhere;
  // Which collectors were unreachable is kept per test run, never in the
  // user's own cache.
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "pharo-agent-tests-cache-"));
  process.env.XDG_CACHE_HOME = cache;
  process.env.LOCALAPPDATA = cache;
  process.env[marker] = "1";
}
