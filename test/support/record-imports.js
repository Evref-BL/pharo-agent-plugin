// Loaded with --import into a pharo-agent process a test spawns: records
// every OpenTelemetry module, and this package's SDK module, that the
// process resolves, and writes the list last on stderr, so a test can say
// what a run loaded.
import module from "node:module";

/** @type {Set<string>} */
const resolved = new Set();

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    const answer = nextResolve(specifier, context);
    if (/@opentelemetry\/|telemetrySdk\.js$/.test(answer.url)) resolved.add(answer.url);
    return answer;
  },
});

process.on("exit", () => {
  process.stderr.write(`\nresolved: ${JSON.stringify([...resolved])}`);
});
