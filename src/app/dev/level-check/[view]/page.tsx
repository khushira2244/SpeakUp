import { notFound } from "next/navigation";
import { LevelCheckGallery } from "./gallery";

// Developer gallery of the level-check screens with sample data. Not available in production builds.
export default async function DevLevelCheckPage({ params }: { params: Promise<{ view: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { view } = await params;
  return <LevelCheckGallery view={view} />;
}
