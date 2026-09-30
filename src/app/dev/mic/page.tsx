import { notFound } from "next/navigation";
import { MicDevClient } from "./mic-dev";

// Developer test page for <LiveMic>. Not available in production builds.
export default function DevMicPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <MicDevClient />;
}
