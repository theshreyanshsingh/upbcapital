// Colour maths for the contrast check in CI. The palette in app/globals.css is written in OKLCH; WCAG
// contrast is defined on sRGB luminance, so this converts one to the other and composites tints the way
// the browser does (alpha over the surface underneath, in gamma-encoded sRGB).

export type Rgb = { r: number; g: number; b: number };
export type Rgba = Rgb & { alpha: number };

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function encode(linear: number) {
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

function decode(channel: number) {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

// OKLCH to linear sRGB, per Björn Ottosson's OKLab matrices. Hue is in degrees.
export function oklchToLinear(lightness: number, chroma: number, hue: number): Rgb {
  const angle = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(angle);
  const b = chroma * Math.sin(angle);
  const l = Math.pow(lightness + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(lightness - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(lightness - 0.0894841775 * a - 1.291485548 * b, 3);
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

// True when the colour needs no gamut mapping to show on an sRGB screen (a small tolerance for rounding).
export function inSrgbGamut(lightness: number, chroma: number, hue: number) {
  const { r, g, b } = oklchToLinear(lightness, chroma, hue);
  return [r, g, b].every((channel) => channel >= -0.0005 && channel <= 1.0005);
}

export function oklchToSrgb(lightness: number, chroma: number, hue: number): Rgb {
  const { r, g, b } = oklchToLinear(lightness, chroma, hue);
  return { r: encode(clamp(r)), g: encode(clamp(g)), b: encode(clamp(b)) };
}

function number(token: string, percentOf = 1) {
  const value = token.trim();
  if (value === "none") return 0;
  return value.endsWith("%") ? (Number(value.slice(0, -1)) / 100) * percentOf : Number(value);
}

// Parses the colour forms the stylesheet uses: oklch(L C H [/ A]), #rgb, #rrggbb and rgb()/rgba().
export function parseColor(input: string): Rgba {
  const value = input.trim().toLowerCase();
  const oklch = value.match(/^oklch\(\s*([^\s/]+)\s+([^\s/]+)\s+([^\s/)]+)\s*(?:\/\s*([^\s)]+))?\s*\)$/);
  if (oklch) {
    const rgb = oklchToSrgb(number(oklch[1]), number(oklch[2], 0.4), number(oklch[3]));
    return { ...rgb, alpha: oklch[4] == null ? 1 : number(oklch[4]) };
  }
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    const channel = (index: number) => parseInt(digits.slice(index, index + 2), 16) / 255;
    return { r: channel(0), g: channel(2), b: channel(4), alpha: 1 };
  }
  const rgb = value.match(/^rgba?\(\s*([^,\s]+)[,\s]+([^,\s]+)[,\s]+([^,\s/)]+)\s*(?:[,/]\s*([^\s)]+))?\s*\)$/);
  if (rgb) {
    return {
      r: number(rgb[1], 255) / 255,
      g: number(rgb[2], 255) / 255,
      b: number(rgb[3], 255) / 255,
      alpha: rgb[4] == null ? 1 : number(rgb[4]),
    };
  }
  throw new Error(`Unsupported colour: ${input}`);
}

// A colour at some opacity laid over an opaque surface, as Tailwind's `bg-good/10` renders on a card.
export function composite(top: Rgba, under: Rgb, opacity = 1): Rgb {
  const alpha = clamp(top.alpha * opacity);
  return {
    r: top.r * alpha + under.r * (1 - alpha),
    g: top.g * alpha + under.g * (1 - alpha),
    b: top.b * alpha + under.b * (1 - alpha),
  };
}

export function luminance({ r, g, b }: Rgb) {
  return 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b);
}

export function contrastRatio(one: Rgb, two: Rgb) {
  const [light, dark] = [luminance(one), luminance(two)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

export function toHex({ r, g, b }: Rgb) {
  return `#${[r, g, b].map((channel) => Math.round(clamp(channel) * 255).toString(16).padStart(2, "0")).join("")}`;
}

// The custom properties declared directly inside one rule (`:root`, `.dark`) of a stylesheet, unresolved.
export function readDeclarations(css: string, selector: string) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = source.match(new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{([^}]*)\\}`));
  if (!block) throw new Error(`No ${selector} block in the stylesheet`);
  const declared: Record<string, string> = {};
  for (const match of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) declared[match[1]] = match[2].trim();
  return declared;
}

// A theme as the browser computes it: the rules apply in order (`:root`, then `.dark` on the same element)
// and var() references resolve against the merged set, so `--popover: var(--card)` follows the dark card.
export function readTheme(css: string, selectors: string[]) {
  const merged: Record<string, string> = {};
  for (const selector of selectors) Object.assign(merged, readDeclarations(css, selector));
  const resolve = (value: string, depth = 0): string =>
    depth > 8 ? value : value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => resolve(merged[name] ?? "", depth + 1));
  const tokens: Record<string, string> = {};
  for (const name of Object.keys(merged)) tokens[name] = resolve(merged[name]);
  return tokens;
}
