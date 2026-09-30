import { notFound } from "next/navigation";
import { LettersPreview } from "./preview";

// Developer preview of the beginner letter-sound grid (English and German). Not available in production builds.
export default function DevLettersPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <LettersPreview />;
}
