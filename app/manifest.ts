import type { MetadataRoute } from "next";

// The installed app. It opens on the notices list, the phone's triage view, and signs in first when needed.
// Colours follow the light theme: the page grey behind the splash, and the white top bar for the status bar.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "UPB Capital",
    short_name: "UPB Capital",
    description: "The UPB Capital note desk: notices, offers, closings and the book.",
    start_url: "/notifications",
    scope: "/",
    display: "standalone",
    background_color: "#f6f5f2",
    theme_color: "#f6f5f2",
    categories: ["finance", "business"],
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Notifications", url: "/notifications" },
      { name: "Inbox", url: "/inbox" },
      { name: "Closings", url: "/closings" },
    ],
  };
}
