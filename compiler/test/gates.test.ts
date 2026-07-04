import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { letterSpacingEquivalent } from "../src/validate/gates.js";

// Chromium serializes a computed `letter-spacing: 0` back as the keyword `normal`. The emitter, after
// snapping a sub-0.1px authored tracking to 0, ships `letter-spacing: 0px` — which the CLONE then
// reports as `normal` too, but a source that authored an explicit near-zero px can land on either
// spelling. Gate 4 must treat `normal` and `0px` as equal, or every such node fails on spelling alone.
describe("gate4 letterSpacing normal ↔ 0px normalization", () => {
  it("treats `normal` and `0px` as equivalent", () => {
    assert.ok(letterSpacingEquivalent("normal", "0px"));
    assert.ok(letterSpacingEquivalent("0px", "normal"));
  });

  it("treats `normal` and `normal` as equivalent", () => {
    assert.ok(letterSpacingEquivalent("normal", "normal"));
  });

  it("treats a sub-2px authored tracking vs `normal` as equivalent (within ±2px)", () => {
    // source computed `-0.08px`, clone serialized `normal` — a 0.08px delta, well within tolerance.
    assert.ok(letterSpacingEquivalent("-0.08px", "normal"));
    assert.ok(letterSpacingEquivalent("normal", "-0.0375px"));
  });

  it("still equates two close real px values (−0.24px vs −0.2px)", () => {
    assert.ok(letterSpacingEquivalent("-0.24px", "-0.2px"));
  });

  it("still FAILS a genuine tracking difference beyond ±2px", () => {
    assert.ok(!letterSpacingEquivalent("4px", "normal"));
    assert.ok(!letterSpacingEquivalent("normal", "-3px"));
    assert.ok(!letterSpacingEquivalent("6px", "2px"));
  });

  it("passes when the source did not constrain the property (undefined)", () => {
    assert.ok(letterSpacingEquivalent(undefined, "0px"));
  });
});
