"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen } from "@/components/ui";
import { DEMO_VIDEO_URL } from "@/lib/landing";

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const MicCheckIcon = () => (
  <Svg>
    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
    <path d="M9 7.5l1.5 1.5L15 5" />
  </Svg>
);
const LabIcon = () => (
  <Svg>
    <path d="M6 3h12M9 3v5l-5 9.5A2 2 0 0 0 5.7 21h12.6a2 2 0 0 0 1.7-3.5L15 8V3" />
  </Svg>
);
const RoomsIcon = () => (
  <Svg>
    <circle cx="9" cy="8" r="3" />
    <path d="M2.5 20v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1" />
    <circle cx="18" cy="9" r="2.3" />
    <path d="M21.5 20v-.8a4 4 0 0 0-3-3.87" />
  </Svg>
);
const PlayIcon = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5.5v13l11-6.5-11-6.5Z" />
  </svg>
);

/** Public landing page — signed-in visitors are sent straight to their usual flow. */
export default function LandingPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { isAuthenticated } = useConvexAuth();

  useEffect(() => {
    if (isAuthenticated) router.replace("/start");
  }, [isAuthenticated, router]);

  const features: Array<{ icon: ReactNode; label: string }> = [
    { icon: <MicCheckIcon />, label: t("landing.feature.speakingCheck") },
    { icon: <LabIcon />, label: t("landing.feature.dailyLabs") },
    { icon: <RoomsIcon />, label: t("landing.feature.liveRooms") },
  ];

  return (
    <Screen>
      <BrandHeader />
      <p className="mt-3 text-center text-base text-muted">{t("landing.subline")}</p>

      <div className="mt-6 aspect-video w-full overflow-hidden rounded-2xl border border-line bg-surface">
        {DEMO_VIDEO_URL ? (
          <iframe
            src={DEMO_VIDEO_URL}
            title={t("landing.video.title")}
            className="size-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-muted">
            <span className="grid size-14 place-items-center rounded-full bg-surface-2 text-accent">
              <PlayIcon />
            </span>
            <p className="text-base">{t("landing.video.placeholder")}</p>
          </div>
        )}
      </div>

      <ul className="mt-6 flex flex-col gap-3">
        {features.map((f, i) => (
          <li key={i} className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
            <span className="shrink-0 text-accent">{f.icon}</span>
            <span className="text-base font-semibold">{f.label}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex flex-col items-center gap-4 pt-8">
        <PrimaryButton type="button" onClick={() => router.push("/language")}>
          {t("landing.getStarted")}
        </PrimaryButton>
        <p className="text-base text-muted">
          {t("landing.haveAccount")}{" "}
          <button type="button" onClick={() => router.push("/auth")} className="font-semibold text-accent underline-offset-2 hover:underline">
            {t("auth.tabLogIn")}
          </button>
        </p>
        <p className="text-[13px] text-muted">{t("landing.footer")}</p>
      </div>
    </Screen>
  );
}
