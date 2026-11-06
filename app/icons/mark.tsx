import { ImageResponse } from "next/og";

// The UPB mark from components/logo.tsx: a white "U" on the ink tile. The letter is drawn as a path so it renders
// the same without loading a font. Ink and paper follow the light theme's --primary and --primary-foreground.
export const INK = "#111111";
export const PAPER = "#ffffff";

const U_PATH = "M11.75 9.8V16.6a4.25 4.25 0 0 0 8.5 0V9.8";

type Shape = "rounded" | "square" | "glyph";

// rounded: a browser or desktop icon with transparent corners, like the logo tile.
// square: full bleed, for iOS and for Android's maskable icon, which apply their own mask. The letter sits well
// inside the centre 80% safe zone either way.
// glyph: the letter alone in white on transparent, for Android's monochrome notification badge.
export function markImage(size: number, shape: Shape = "rounded", headers?: Record<string, string>) {
  const radius = shape === "rounded" ? Math.round(size * 0.28) : 0;
  const tile = shape === "glyph" ? "transparent" : INK;
  const stroke = 2.7;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: tile, borderRadius: radius }}>
        <svg width={size} height={size} viewBox={shape === "glyph" ? "6 6 20 20" : "0 0 32 32"} xmlns="http://www.w3.org/2000/svg">
          <path d={U_PATH} fill="none" stroke={PAPER} strokeWidth={shape === "glyph" ? stroke * 1.15 : stroke} />
        </svg>
      </div>
    ),
    { width: size, height: size, ...(headers ? { headers } : {}) },
  );
}
