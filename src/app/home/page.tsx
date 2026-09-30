"use client";

import { Component, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen, Spinner } from "@/components/ui";
import { BottomNav, HomeHeader, TABS, TabBar, TabPanel, type Tab } from "@/components/home/home-shell";
import { ModeSwitch } from "@/components/partner/mode-switch";
import { PronunciationTab } from "@/components/home/pronunciation-tab";
import { UnitsTab } from "@/components/home/units-tab";
import { WordsTab } from "@/components/home/words-tab";
import { errorCode } from "@/components/home/use-saved-words";
import { useAuthGuard } from "@/lib/use-auth-guard";

const TAB_KEY = "speakup.home.tab";
const DAY_MS = 24 * 60 * 60 * 1000;

function BoundaryFallback() {
  const { t } = useI18n();
  return (
    <div className="mt-10 flex flex-col items-center gap-4 text-center">
      <p role="alert" className="text-base text-danger">
        {t("home.error")}
      </p>
      <PrimaryButton type="button" onClick={() => window.location.reload()}>
        {t("mic.tryAgain")}
      </PrimaryButton>
    </div>
  );
}

/** If the pass ends while Home is open, the server refuses the data: send the learner to renew. */
class HomeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    if (errorCode(error) === "no_active_pass") window.location.assign("/pay/ended");
  }
  override render() {
    return this.state.failed ? <BoundaryFallback /> : this.props.children;
  }
}

export default function HomePage() {
  const router = useRouter();
  const { t } = useI18n();
  const signedIn = useAuthGuard();
  const me = useQuery(api.users.me, signedIn ? {} : "skip");
  const pass = useQuery(api.passes.activePass, signedIn ? {} : "skip");

  const [tab, setTab] = useState<Tab>("units");
  const [now] = useState(() => Date.now());

  // Remember the section across reloads (read after mount so the first paint matches the server).
  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(TAB_KEY);
      if (TABS.includes(saved as Tab)) setTab(saved as Tab);
    } catch {
      // storage blocked: start on the default section
    }
  }, []);

  function changeTab(next: Tab) {
    setTab(next);
    try {
      window.sessionStorage.setItem(TAB_KEY, next);
    } catch {
      // ignored
    }
  }

  // Nothing here is free: no pass sends the learner to pay, an ended pass to renew.
  useEffect(() => {
    if (pass === undefined) return;
    if (pass === null) router.replace("/level-check");
    else if (!pass.isActive) router.replace("/pay/ended");
  }, [pass, router]);

  if (pass === undefined || pass === null || !pass.isActive) {
    return (
      <Screen>
        <BrandHeader />
        <div className="mt-16 flex flex-col items-center gap-3 text-muted" role="status">
          <span className="scale-150">
            <Spinner />
          </span>
          <p className="text-base">{t("common.loading")}</p>
        </div>
      </Screen>
    );
  }

  const daysLeft = Math.max(0, Math.ceil((pass.endsAt - now) / DAY_MS));

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[440px] flex-col px-5 pt-5 pb-28">
      <HomeHeader name={me?.name ?? null} daysLeft={daysLeft} />
      <div className="mt-3 flex justify-end">
        <ModeSwitch mode="learner" />
      </div>
      <TabBar tab={tab} onChange={changeTab} />
      <TabPanel tab={tab}>
        <HomeBoundary>
          {tab === "pron" ? <PronunciationTab /> : tab === "words" ? <WordsTab /> : <UnitsTab />}
        </HomeBoundary>
      </TabPanel>
      <BottomNav />
    </main>
  );
}
