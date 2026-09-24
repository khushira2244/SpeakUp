"use client";

import type { ReactNode } from "react";
import { ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { I18nProvider } from "@/i18n/provider";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!convexUrl) {
  throw new Error(
    "NEXT_PUBLIC_CONVEX_URL is not set. Add it to .env.local (same value as CONVEX_URL).",
  );
}

const convex = new ConvexReactClient(convexUrl);

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthProvider client={convex}>
      <I18nProvider>{children}</I18nProvider>
    </ConvexAuthProvider>
  );
}
