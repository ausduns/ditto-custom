import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { collectPage, type RawNode, type RawChild } from "../src/capture/walker.js";

function isText(c: RawChild): c is { text: string } {
  return (c as { text?: string }).text !== undefined;
}

function findByTag(root: RawNode, tag: string): RawNode | null {
  if (root.tag === tag) return root;
  for (const c of root.children) {
    if (isText(c)) continue;
    const hit = findByTag(c, tag);
    if (hit) return hit;
  }
  return null;
}

function textRun(node: RawNode): string {
  let out = "";
  for (const c of node.children) out += isText(c) ? c.text : textRun(c);
  return out;
}

describe("walker whitespace-only text nodes", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  after(async () => {
    await browser.close();
  });

  const capture = async (html: string) => {
    await page.setContent(html);
    // tsx/esbuild wraps functions with a __name() helper for stack traces; the
    // serialized collectPage carries those calls, so shim it (same as capture.ts).
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    return page.evaluate(collectPage);
  };

  it("keeps the lone space that is the only child of an inline element", async () => {
    // Real case (ooni.com): the space between "of" and "the" lives alone inside
    // <strong>; dropping it fuses the adjacent text runs ("ofthe").
    const snap = await capture("<p>Creator of<strong> </strong><em><strong>the world's</strong></em></p>");
    const p = findByTag(snap.root, "p")!;
    const strong = p.children.find((c) => !isText(c) && c.tag === "strong") as RawNode;
    assert.deepEqual(strong.children, [{ text: " " }]);
    assert.equal(textRun(p), "Creator of the world's");
  });

  it("still keeps the single space between inline elements", async () => {
    const snap = await capture("<p><em>a</em> <em>b</em></p>");
    const p = findByTag(snap.root, "p")!;
    assert.equal(textRun(p), "a b");
  });

  it("does not emit a space inside an empty block container", async () => {
    const snap = await capture("<main><section>\n   \n</section></main>");
    const section = findByTag(snap.root, "section")!;
    assert.deepEqual(section.children, []);
  });
});

function findByClass(root: RawNode, cls: string): RawNode | null {
  if ((root.attrs?.class ?? "").split(/\s+/).includes(cls)) return root;
  for (const c of root.children) {
    if (isText(c)) continue;
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

describe("walker off-screen visibility", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 375, height: 768 });
  });
  after(async () => {
    await browser.close();
  });

  const capture = async (html: string) => {
    await page.setContent(html);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    return page.evaluate(collectPage);
  };

  it("marks a fixed off-screen-left drawer's un-hidden inner content invisible", async () => {
    // Real case (ooni.com): a slide-in search drawer is a position:fixed box parked at
    // x:-375 (right edge at 0) with visibility:hidden; its inner content sets
    // visibility:visible (so getComputedStyle reports it visible) but the whole box is
    // still off the left edge. The drawer must not leak into the clone's DOM text.
    const snap = await capture(`
      <div class="drawer" style="position:fixed;left:0;top:0;width:375px;height:768px;
           transform:translateX(-100%);visibility:hidden;">
        <div class="inner" style="visibility:visible;width:343px;">
          <h2 class="drawer-title">Popular Searches</h2>
        </div>
      </div>
      <p class="onscreen">Hello</p>`);
    const title = findByClass(snap.root, "drawer-title")!;
    assert.equal(title.visible, false, "off-screen-left drawer title should be invisible");
    // The genuinely on-screen paragraph is still visible (sanity that the gate isn't over-broad).
    const onscreen = findByClass(snap.root, "onscreen")!;
    assert.equal(onscreen.visible, true, "on-screen content stays visible");
  });

  it("keeps a partially-overlapping negative-margin decoration visible", async () => {
    // A decoration pulled left by a negative margin so it straddles the left edge
    // (x:-40, width:200 -> right edge +160) still paints and must stay visible.
    const snap = await capture(`
      <div style="overflow:hidden;width:375px;">
        <div class="deco" style="width:200px;height:40px;margin-left:-40px;background:red;">peek</div>
      </div>`);
    const deco = findByClass(snap.root, "deco")!;
    assert.ok(deco.bbox.x < 0, "decoration starts off-screen left");
    assert.ok(deco.bbox.x + deco.bbox.width > 0, "but its right edge is on-screen");
    assert.equal(deco.visible, true, "partially-overlapping decoration stays visible");
  });

  it("keeps normal in-flow content below the fold visible", async () => {
    // The page scrolls vertically, so content below the viewport is reachable and must
    // NOT be marked invisible (only position:fixed boxes are pinned).
    const snap = await capture(`
      <div style="height:2000px;"></div>
      <p class="belowfold" style="height:40px;">Below the fold</p>`);
    const below = findByClass(snap.root, "belowfold")!;
    assert.ok(below.bbox.y > 768, "content is below the 768px viewport");
    assert.equal(below.visible, true, "below-fold in-flow content stays visible");
  });

  it("marks a computed-visibility:hidden subtree invisible", async () => {
    // A subtree whose computed visibility is actually hidden (and does not set
    // visibility:visible on any descendant) is not painted.
    const snap = await capture(`
      <div style="visibility:hidden;width:300px;">
        <span class="hidden-child">secret</span>
      </div>`);
    const child = findByClass(snap.root, "hidden-child")!;
    assert.equal(child.visible, false, "computed-hidden child is invisible");
  });

  it("rejects a fixed box parked entirely below the viewport", async () => {
    // A position:fixed banner pinned below the viewport bottom never scrolls into view.
    const snap = await capture(`
      <div class="fixedlow" style="position:fixed;left:0;top:900px;width:375px;height:60px;">
        <span>hidden banner</span>
      </div>`);
    const fixed = findByClass(snap.root, "fixedlow")!;
    assert.equal(fixed.visible, false, "fixed box below the viewport is invisible");
  });
});

describe("walker font-metric probe tagging (fix 4)", () => {
  let browser: Browser;
  let page: Page;
  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.setViewportSize({ width: 375, height: 768 });
  });
  after(async () => {
    await browser.close();
  });

  const capture = async (html: string) => {
    await page.setContent(html);
    await page.evaluate("globalThis.__name = globalThis.__name || ((fn) => fn);");
    return page.evaluate(collectPage);
  };

  it("tags a far-off-screen, non-painting measurement scratch node as a probe", async () => {
    // The classic font-metric probe pattern (WordPress/typography libs): absolutely positioned,
    // parked ~100000px off-screen, visibility:hidden, holding measurement text.
    const snap = await capture(`
      <p class="real">Real content</p>
      <div class="probe" style="position:absolute;top:-99999px;left:-99999px;
           visibility:hidden;white-space:nowrap;">Mgy</div>`);
    const probe = findByClass(snap.root, "probe")!;
    assert.equal(probe.probe, true, "far-off-screen hidden scratch node is a probe");
    const real = findByClass(snap.root, "real")!;
    assert.ok(!real.probe, "real content is not a probe");
  });

  it("does NOT tag a near-off-screen hidden drawer (real content) as a probe", async () => {
    // A slide-in drawer parked just off the left edge (x:-375, visibility:hidden) is real
    // content that a controller can reveal — it must NOT be mistaken for a measurement probe.
    const snap = await capture(`
      <div class="drawer" style="position:fixed;left:0;top:0;width:375px;height:768px;
           transform:translateX(-100%);visibility:hidden;">
        <h2 class="dtitle">Menu</h2>
      </div>`);
    const drawer = findByClass(snap.root, "drawer")!;
    assert.ok(!drawer.probe, "a near-off-screen drawer is not a probe");
  });

  it("does NOT tag an sr-only (visible, on-screen-adjacent) accessibility label as a probe", async () => {
    // Screen-reader-only text stays visibility:visible so AT can read it; even parked far off
    // via left:-9999px it must survive (and 9999px is under the 10000px probe threshold anyway).
    const snap = await capture(`
      <a href="/"><span class="sr" style="position:absolute;left:-9999px;">Skip to content</span>Home</a>`);
    const sr = findByClass(snap.root, "sr")!;
    assert.ok(!sr.probe, "sr-only accessible text is not a probe");
  });
});
