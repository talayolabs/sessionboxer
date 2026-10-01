import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const client = new Client({ name: "desktop-description-test", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["packages/computer-use-mcp/dist/index.js"],
  env: { ...process.env, DISPLAY: ":unavailable" },
  stderr: "pipe",
});
const validator = new AjvJsonSchemaValidator();
let tools;
before(async () => {
  await client.connect(transport);
  tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
});
after(async () => {
  await client.close();
  await transport.close();
});

const cases = [
  {
    name: "zoom",
    required: ["region"],
    properties: ["region"],
    mistakes: [{ x: 100, y: 120, width: 400, height: 300 }, { coordinate: [100, 120] }],
    hints: [/region/, /x0.*y0.*x1.*y1/, /not.*width/i, /coordinate/],
  },
  {
    name: "key",
    required: ["text"],
    properties: ["text"],
    mistakes: [{ key: "Return" }],
    hints: [/text/, /not.*key/i, /xdotool/],
  },
  {
    name: "scroll",
    required: ["scroll_direction"],
    properties: ["coordinate", "scroll_amount", "scroll_direction"],
    mistakes: [{ coordinate: [640, 360], direction: "down", amount: 3 }],
    hints: [/scroll_direction/, /scroll_amount/, /not.*direction.*amount/i, /optional.*coordinate|coordinate.*optional/i],
  },
];

for (const fixture of cases) {
  test(`${fixture.name} advertises a valid example and disambiguates the mistaken argument names`, () => {
    const tool = tools.get(fixture.name);
    assert.ok(tool);
    for (const hint of fixture.hints) assert.match(tool.description, hint);
    const match = /Example:\s*(\{[^\n]*?\})/.exec(tool.description);
    assert.ok(match, "the description must include a copyable JSON argument example");
    const example = JSON.parse(match[1]);
    const result = validator.getValidator(tool.inputSchema)(example);
    assert.equal(result.valid, true, result.errorMessage);
    assert.deepEqual([...tool.inputSchema.required].sort(), fixture.required);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), fixture.properties);
    for (const name of fixture.required) assert.ok(tool.inputSchema.properties[name].description);
  });

  test(`${fixture.name} still rejects the historical wrong argument shapes before execution`, async () => {
    const validate = validator.getValidator(tools.get(fixture.name).inputSchema);
    for (const args of fixture.mistakes) {
      assert.equal(validate(args).valid, false);
      const result = await client.callTool({ name: fixture.name, arguments: args });
      assert.equal(result.isError, true);
      assert.match(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), /validation/i);
    }
  });
}

test("descriptions preserve zoom geometry, key shortcuts, and scroll defaults and bounds", () => {
  const zoom = tools.get("zoom");
  const zoomExample = JSON.parse(/Example:\s*(\{[^\n]*?\})/.exec(zoom.description)[1]);
  const [x0, y0, x1, y1] = zoomExample.region;
  assert.ok(x0 >= 0 && y0 >= 0 && x1 > x0 && y1 > y0);
  assert.match(zoom.description, /NOT screen coordinates/);
  const key = tools.get("key");
  assert.match(key.description, /sequential.*spaces/i);
  const scroll = tools.get("scroll");
  const amount = scroll.inputSchema.properties.scroll_amount;
  assert.equal(amount.minimum, 1);
  assert.equal(amount.maximum, 50);
  assert.equal(amount.default, 3);
  assert.equal(validator.getValidator(scroll.inputSchema)({ scroll_direction: "down" }).valid, true);
  assert.deepEqual(scroll.inputSchema.properties.scroll_direction.enum, ["up", "down", "left", "right"]);
});
