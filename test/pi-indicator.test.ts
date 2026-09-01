import { strict as assert } from "node:assert";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CaffeinateIndicator, COFFEE_FRAMES } from "../pi-indicator.js";

const theme = {
  fg: (_color: string, text: string) => `\u001b[31m${text}\u001b[39m`,
} as never;

test("renders every ASCII coffee frame within the requested width", () => {
  let renders = 0;
  const indicator = new CaffeinateIndicator(
    { requestRender: () => renders++ },
    theme,
  );

  for (let frame = 0; frame < COFFEE_FRAMES.length; frame++) {
    const lines = indicator.render(8);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((line) => visibleWidth(line) <= 8));
    indicator.advance();
  }

  assert.equal(renders, COFFEE_FRAMES.length);
  indicator.dispose();
});

test("clips the indicator for narrow overlays and invalidates its cache", () => {
  const indicator = new CaffeinateIndicator({ requestRender() {} }, theme);
  const lines = indicator.render(3);
  assert.ok(lines.every((line) => visibleWidth(line) <= 3));
  assert.strictEqual(indicator.render(3), lines);
  indicator.invalidate();
  assert.notStrictEqual(indicator.render(3), lines);
  indicator.dispose();
});
