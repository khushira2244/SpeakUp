import { notFound } from "next/navigation";
import { RoomPreviewClient } from "./room-preview-client";

// Developer-only visual check for the live-room screens with mock data — the
// built-in preview browser cannot grant microphone access, so the real
// join -> LiveKit -> AssemblyAI flow can't be driven end to end here. Not
// available in production builds.
export default function DevRoomPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <RoomPreviewClient />;
}
