import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { toolContractFrom } from "../src/mcpYaml.js";

// Each fixture is tool_get's answer from a live image, beside the same tool's
// schema from tools/list without PLexus's routing handle. Reading the YAML
// must give the schema back exactly.
const fixtures = new URL("./fixtures/tool-contracts/", import.meta.url);

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  }
  return value;
}

for (const name of ["method_search", "method_compile", "test_run", "tool_call"]) {
  test(`tool_get's YAML for ${name} reads as the schema tools/list gives`, () => {
    const yaml = fs.readFileSync(new URL(`${name}.yaml`, fixtures), "utf8");
    const schema = JSON.parse(fs.readFileSync(new URL(`${name}.json`, fixtures), "utf8"));
    const contract = toolContractFrom(yaml);
    assert.equal(contract.name, name);
    assert.deepEqual(sorted(contract.inputSchema), sorted(schema));
  });
}

test("the writer's scalars, lists and nested entries read back", () => {
  const contract = toolContractFrom([
    "Tool probe found.",
    "tool:",
    "  annotations: {}",
    "  count: 3",
    "  enabled: true",
    "  empty: []",
    "  quoted: \"a: b, \\\"c\\\"\"",
    "  words: [one, \"two, three\", 4, false]",
    "  entries:",
    "  - name: first",
    "    kind: one",
    "  - plain",
    "  name: probe",
  ].join("\n"));
  assert.deepEqual(contract, {
    annotations: {},
    count: 3,
    enabled: true,
    empty: [],
    quoted: "a: b, \"c\"",
    words: ["one", "two, three", 4, false],
    entries: [{ name: "first", kind: "one" }, "plain"],
    name: "probe",
  });
});

test("an answer without a contract reads as none", () => {
  assert.equal(toolContractFrom("No tool named nothing."), undefined);
});
