import { markImage } from "@/app/icons/mark";

// /icons/maskable is the manifest's maskable icon: Android crops it to its own shape, so it is full bleed.
// /icons/badge is the small monochrome mark Android shows in the status bar next to a push notice.
const ICONS = {
  maskable: { size: 512, shape: "square" },
  badge: { size: 96, shape: "glyph" },
} as const;

export async function GET(_request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  if (!Object.prototype.hasOwnProperty.call(ICONS, name)) return new Response("Not found.", { status: 404 });
  const icon = ICONS[name as keyof typeof ICONS];
  return markImage(icon.size, icon.shape, { "Cache-Control": "public, max-age=86400" });
}
