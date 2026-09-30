"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { BrandHeader, Screen, Spinner } from "@/components/ui";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { usePartnerProfile } from "@/components/partner/use-partner-profile";
import { BecomePartner } from "@/components/partner/become-partner";

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

export default function PartnerHomePage() {
  const router = useRouter();
  const signedIn = useAuthGuard();
  const { status, profile } = usePartnerProfile();

  const shouldRedirect = signedIn && status === "ready" && profile !== null;

  useEffect(() => {
    if (!shouldRedirect || profile === null) return;
    router.replace(profile.status === "pending" ? "/partner/test" : "/partner/setup");
  }, [shouldRedirect, profile, router]);

  if (!signedIn || status === "loading" || shouldRedirect) return <Loading />;

  return <BecomePartner onBack={() => router.push("/home")} onStarted={() => router.push("/partner/test")} />;
}
