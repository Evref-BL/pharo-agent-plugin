import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  isToolName,
  positionalProperty,
  resultText,
  toolArguments,
  toolListing,
  toolUsage,
} from "../src/toolCommand.js";

const schemaOf = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/tool-contracts/${name}.json`, import.meta.url), "utf8"));
const testRun = schemaOf("test_run");
const methodCompile = schemaOf("method_compile");
const methodSearch = schemaOf("method_search");
const noStdin = () => assert.fail("stdin was read");

test("a tool is a snake_case word, a command is not", () => {
  for (const word of ["class_get", "test_run", "method_reference_search"]) assert.ok(isToolName(word), word);
  for (const word of ["list", "image", "init", "mcp", "help", "--help", "Class_get", "class-get"]) {
    assert.equal(isToolName(word), false, word);
  }
});

test("flags take their type from the schema", () => {
  assert.deepEqual(
    toolArguments("test_run", ["--classes", "PointTest", "--classes", "RectangleTest", "--timeoutSeconds", "120"], testRun, noStdin),
    { classes: ["PointTest", "RectangleTest"], timeoutSeconds: 120 },
  );
});

test("a property is also its kebab-case flag, and a value may follow =", () => {
  assert.deepEqual(
    toolArguments("test_run", ["--timeout-seconds=30", "--packages=Kernel-Tests"], testRun, noStdin),
    { timeoutSeconds: 30, packages: ["Kernel-Tests"] },
  );
});

test("a boolean flag is true alone, false negated or spelled out", () => {
  const schema = { properties: { force: { type: "boolean" }, name: { type: "string" } } };
  assert.deepEqual(toolArguments("probe", ["--force"], schema, noStdin), { force: true });
  assert.deepEqual(toolArguments("probe", ["--no-force"], schema, noStdin), { force: false });
  assert.deepEqual(toolArguments("probe", ["--force", "false", "--name", "x"], schema, noStdin), { force: false, name: "x" });
});

test("an argument that is a string or a list is a string once and a list when repeated", () => {
  assert.deepEqual(
    toolArguments("method_compile", ["--class", "Point", "--source", "x ^ x"], methodCompile, noStdin),
    { class: "Point", source: "x ^ x" },
  );
  assert.deepEqual(
    toolArguments("method_compile", ["--class", "Point", "--source", "x ^ x", "--source", "y ^ y"], methodCompile, noStdin),
    { class: "Point", source: ["x ^ x", "y ^ y"] },
  );
});

test("an object argument takes JSON", () => {
  assert.deepEqual(
    toolArguments("method_search", ["--scope", "{\"classes\":[\"Point\"]}", "--selector", "norm"], methodSearch, noStdin),
    { scope: { classes: ["Point"] }, selector: "norm" },
  );
  assert.throws(() => toolArguments("method_search", ["--scope", "Point"], methodSearch, noStdin), /--scope takes a JSON object/);
});

test("- reads the value from stdin, without the heredoc's last line end", () => {
  const source = "x\n\t^ x\n";
  assert.deepEqual(
    toolArguments("method_compile", ["--class", "Point", "--source", "-"], methodCompile, () => source),
    { class: "Point", source: "x\n\t^ x" },
  );
  assert.throws(
    () => toolArguments("method_compile", ["--class", "-", "--source", "-"], methodCompile, () => "x"),
    /reads one value from stdin/,
  );
});

test("a bare value fills the one required argument, or the only one", () => {
  const classGet = { properties: { name: { type: ["string", "array"] }, includeComment: { type: "boolean" } }, required: ["name"] };
  const toolSearch = { properties: { query: { type: "string" } } };
  assert.equal(positionalProperty(classGet), "name");
  assert.equal(positionalProperty(toolSearch), "query");
  assert.equal(positionalProperty(testRun), undefined);
  assert.deepEqual(toolArguments("class_get", ["Point"], classGet, noStdin), { name: "Point" });
  assert.deepEqual(toolArguments("class_get", ["Point", "Rectangle"], classGet, noStdin), { name: ["Point", "Rectangle"] });
  assert.deepEqual(toolArguments("tool_search", ["repository", "commit"], toolSearch, noStdin), { query: "repository commit" });
  assert.throws(() => toolArguments("test_run", ["PointTest"], testRun, noStdin), /takes its arguments as flags: --classes/);
});

test("a flag the tool does not have is refused with the ones it has", () => {
  assert.throws(
    () => toolArguments("test_run", ["--class", "PointTest"], testRun, noStdin),
    /test_run has no argument --class\. Its arguments: .*--classes/,
  );
  assert.throws(() => toolArguments("test_run", ["--timeoutSeconds", "soon"], testRun, noStdin), /takes a number/);
  assert.throws(() => toolArguments("test_run", ["--timeoutSeconds"], testRun, noStdin), /needs a value/);
});

test("the answer is its text, the structured content only when there is none", () => {
  assert.equal(resultText({ content: [{ type: "text", text: "Got method Point>>x.\nsource:\nx\n\t^ x" }] }), "Got method Point>>x.\nsource:\nx\n\t^ x");
  assert.equal(resultText({ structuredContent: { count: 1 } }), JSON.stringify({ count: 1 }, null, 2));
});

test("the listing is a line per tool, its first sentence", () => {
  const listing = toolListing([
    { name: "class_get", description: "Get metadata for classes. Use class_search to discover names." },
    { name: "test_run", description: "Run tests and return a summary." },
  ]);
  assert.match(listing, /^class_get  Get metadata for classes\.$/m);
  assert.match(listing, /^test_run   Run tests and return a summary\.$/m);
  assert.match(listing, /tool_search <words> finds the rest/);
});

test("a tool's usage lists its flags from its schema", () => {
  const usage = toolUsage({ name: "test_run", description: "Run tests.", inputSchema: testRun });
  assert.match(usage, /pharo-agent test_run \[--<argument> <value>\]\.\.\. \[--image <id>\] \[--json\]/);
  assert.match(usage, /--classes <string>, repeatable +Run these test classes\./);
  assert.match(usage, /--timeoutSeconds <integer>/);
  assert.match(usage, /A value of - is read from stdin/);
  const classGet = toolUsage({
    name: "class_get",
    description: "Get classes.",
    inputSchema: { properties: { name: { type: "string" }, includeComment: { type: "boolean" } }, required: ["name"] },
  });
  assert.match(classGet, /pharo-agent class_get \[<name>\]/);
  assert.match(classGet, /--name <string> \(required\)/);
  assert.match(classGet, /A bare value is --name\. A flag without a type is true alone/);
});
