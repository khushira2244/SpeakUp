"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { BrandHeader, Screen, Spinner } from "@/components/ui";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { usePartnerProfile } from "@/components/partner/use-partner-profile";
import { PartnerTestFlow } from "@/components/partner/test-flow";

function Loading() {
  return (
    <Screen>
      <BrandHeader tagline={false} />
      <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
        <span className="scale-150">
          <Spinner />
        </span>
      </div>
    </Screen>
  );
}

export default function PartnerTestPage() {
  const router = useRouter();
  const signedIn = useAuthGuard();
  const { status, profile } = usePartnerProfile();

  const shouldRedirectHome = signedIn && status === "ready" && profile === null;
  const shouldRedirectSetup = signedIn && status === "ready" && profile !== null && profile.status !== "pending";

  useEffect(() => {
    if (shouldRedirectHome) router.replace("/partner");
    else if (shouldRedirectSetup) router.replace("/partner/setup");
  }, [shouldRedirectHome, shouldRedirectSetup, router]);

  if (!signedIn || status === "loading" || shouldRedirectHome || shouldRedirectSetup || profile === null) {
    return <Loading />;
  }

  return (
    <PartnerTestFlow
      goalId={profile.testGoalId!}
      onBack={() => router.push("/partner")}
      onDone={() => router.replace("/partner/setup")}
    />
  );
}
