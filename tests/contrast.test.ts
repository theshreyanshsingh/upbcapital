import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { composite, contrastRatio, inSrgbGamut, parseColor, readTheme, type Rgb } from "../lib/contrast";

// Every text and background pair the app uses, in both themes, against WCAG 2.2 AA: 4.5:1 for text,
// 3:1 for field edges, focus rings and chart marks. The values come straight from app/globals.css.

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const themes = {
  light: readTheme(css, [":root"]),
  dark: readTheme(css, [":root", ".dark"]),
};

const TEXT = 4.5;
const UI = 3;

// A surface is a token, or a token tinted over another at an opacity: "good/10 card" is `bg-good/10`
// on a card. A foreground can carry an opacity too: "foreground/80" is `text-foreground/80`.
type Pair = { fg: string; bg: string; min: number; where: string };

const pairs: Pair[] = [];
const text = (fg: string, bgs: string[], where: string) => bgs.forEach((bg) => pairs.push({ fg, bg, min: TEXT, where }));
const ui = (fg: string, bgs: string[], where: string) => bgs.forEach((bg) => pairs.push({ fg, bg, min: UI, where }));

const surfaces = ["background", "card", "popover", "muted", "secondary", "accent", "hover", "active", "sidebar", "field"];

text("foreground", surfaces, "body text on every surface");
text("card-foreground", ["card"], "card text");
text("popover-foreground", ["popover"], "menus and dialogs");
text("secondary-foreground", ["secondary"], "secondary buttons");
text("accent-foreground", ["accent"], "focused menu items");
text("sidebar-foreground", ["sidebar", "sidebar-accent"], "sidebar text");
text("muted-foreground", surfaces, "secondary text, eyebrows, labels");
text("faint", ["background", "card", "popover", "field", "sidebar", "muted"], "placeholders, sidebar section labels");
text("nav", ["sidebar", "hover"], "sidebar items and their hover");
text("link", ["background", "card", "popover", "muted", "sidebar", "active"], "links");
text("link", ["link/5 card", "link/10 card", "link/10 sidebar"], "links inside notice boxes and pills, nav counts");
text("foreground", ["link/10 card", "link/5 card", "link/5 background"], "text inside notice boxes");
text("muted-foreground", ["link/5 card"], "hints inside notice boxes");
text("foreground/80", ["card", "background"], "quoted messages and bios");
text("primary-foreground", ["primary"], "primary buttons");
text("primary-foreground/75", ["primary"], "secondary copy on the ink panel");
text("primary", ["primary-foreground", "card", "background"], "inverted buttons, ink text");
text("brand-foreground", ["brand"], "text on a solid accent fill");
text("sidebar-primary-foreground", ["sidebar-primary"], "sidebar primary");
for (const tone of ["good", "warn", "bad", "destructive"]) {
  text(tone, ["background", "card", "popover"], `${tone} text`);
}
text("good", ["good/10 card", "good/12 card", "good/10 background"], "status pills");
text("warn", ["warn/10 card", "warn/12 card", "warn/12 background"], "status pills");
text("bad", ["bad/10 card", "bad/10 background"], "status pills and error notices");
text("destructive", ["destructive/10 card", "destructive/15 card", "destructive/20 card"], "destructive buttons, rest and hover");
text("link", ["link/10 card", "link/10 background"], "the under-review pill");
text("background", ["destructive", "destructive/90 card", "good"], "confirm-to-cancel button and its hover, done ticks");
text("muted-foreground", ["muted"], "inactive tabs");

ui("input", ["card", "background", "popover", "field", "sidebar"], "field and checkbox edges");
ui("ring", ["card", "background", "popover", "sidebar", "muted", "field"], "focus ring");
ui("link", ["sidebar", "card"], "the active nav marker and icon");
for (const mark of ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "good", "warn", "bad"]) {
  ui(mark, ["card", "background"], "chart marks");
}

function color(tokens: Record<string, string>, spec: string): Rgb {
  const [layer, under] = spec.split(" ");
  const [name, percent] = layer.split("/");
  const value = tokens[`--${name}`];
  assert.ok(value, `--${name} is not defined`);
  const top = parseColor(value);
  if (!percent && !under) return top;
  const base = under ? color(tokens, under) : top;
  return composite(top, base, percent ? Number(percent) / 100 : 1);
}

for (const [theme, tokens] of Object.entries(themes)) {
  test(`${theme} theme: every named pair meets WCAG 2.2 AA`, () => {
    const failures: string[] = [];
    for (const pair of pairs) {
      const bg = color(tokens, pair.bg);
      // A translucent foreground lays over its own surface.
      const fg = pair.fg.includes("/") ? color(tokens, `${pair.fg} ${pair.bg.split(" ")[0]}`) : color(tokens, pair.fg);
      const ratio = contrastRatio(fg, bg);
      if (ratio < pair.min) failures.push(`${pair.fg} on ${pair.bg}: ${ratio.toFixed(2)} < ${pair.min} (${pair.where})`);
    }
    assert.deepEqual(failures, []);
  });

  test(`${theme} theme: every OKLCH token sits inside sRGB`, () => {
    const outside: string[] = [];
    for (const [name, value] of Object.entries(tokens)) {
      const match = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/[^)]*)?\)$/);
      if (match && !inSrgbGamut(Number(match[1]), Number(match[2]), Number(match[3]))) outside.push(name);
    }
    assert.deepEqual(outside, []);
  });
}

test("the neutrals are warm, quiet greys and the accent is one blue", () => {
  for (const tokens of Object.values(themes)) {
    for (const name of ["--background", "--card", "--muted", "--border", "--foreground", "--muted-foreground", "--sidebar"]) {
      const [, , chroma, hue] = tokens[name].match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)/) ?? [];
      assert.ok(Number(chroma) <= 0.012, `${name} chroma ${chroma} is too strong for a neutral`);
      assert.ok(Number(hue) >= 60 && Number(hue) <= 95, `${name} hue ${hue} is not a warm grey`);
    }
    assert.equal(tokens["--link"], tokens["--brand"]);
    assert.equal(tokens["--ring"], tokens["--brand"]);
  }
});

test("the colour maths matches known values", () => {
  const white = parseColor("#ffffff");
  const black = parseColor("#000000");
  assert.equal(contrastRatio(white, black).toFixed(2), "21.00");
  // #767676 on white is the classic 4.54:1 grey.
  assert.equal(contrastRatio(parseColor("#767676"), white).toFixed(2), "4.54");
  // OKLCH pure white and a mid grey round-trip to their sRGB hex.
  const near = (a: Rgb, b: Rgb) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) < 0.002;
  assert.ok(near(parseColor("oklch(1 0 0)"), white));
  assert.ok(near(parseColor("oklch(0.6279 0.2577 29.23)"), parseColor("#ff0000")));
  assert.ok(near(parseColor("oklch(0.4520 0.3132 264.05)"), parseColor("#0000ff")));
  // Ten percent of black over white composites in sRGB.
  assert.ok(near(composite(black, white, 0.1), { r: 0.9, g: 0.9, b: 0.9 }));
});
