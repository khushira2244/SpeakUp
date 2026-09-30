"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";

/** Sends signed-out visitors to /auth. Returns true once signed in. */
export function useAuthGuard(): boolean {
  const router = useRouter();
  const { isLoading, isAuthenticated } = useConvexAuth();
  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/auth");
  }, [isLoading, isAuthenticated, router]);
  return isAuthenticated;
}
