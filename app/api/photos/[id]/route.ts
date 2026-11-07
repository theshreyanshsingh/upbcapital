import { getApiUser } from "@/lib/auth";
import { PHOTO_MIMES, photoForViewer } from "@/lib/photos";
import { getBytes } from "@/lib/storage";

export const runtime = "nodejs";

// A listing photo, to whoever may see that loan's street address. Shown inline, never as a download, and only as
// one of the three image types, so a stored file can't be served as a page.
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getApiUser();
  if (!user) return new Response("Sign in required.", { status: 401 });
  const found = await photoForViewer(user, id);
  if (!found.photo) return new Response(found.status === 404 ? "Not found." : "This photo opens with the street address.", { status: found.status });
  const mime = PHOTO_MIMES.has(found.photo.mime) ? found.photo.mime : null;
  if (!mime) return new Response("Not found.", { status: 404 });
  try {
    const bytes = await getBytes(found.photo.storedName);
    return new Response(bytes, {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": "inline",
        // Private and short, so a photo that closes when the listing goes to contract doesn't linger in a cache.
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Photo missing.", { status: 404 });
  }
}
