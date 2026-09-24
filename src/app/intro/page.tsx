"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useConvexAuth } from "convex/react";
import type { MessageKey } from "@/i18n/messages";
import { useI18n } from "@/i18n/provider";
import { BrandHeader, PrimaryButton, Screen } from "@/components/ui";

const TOTAL = 3;

type Card = {
  title: MessageKey;
  body: MessageKey;
  visual: ReactNode;
};

export default function IntroPage() {
  const router = useRouter();
  const { t } = useI18n();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/auth");
  }, [isLoading, isAuthenticated, router]);

  const cards: Card[] = [
    {
      title: "intro.1.title",
      body: "intro.1.body",
      visual: (
        <div className="flex flex-wrap gap-2">
          {(["intro.1.chipWork", "intro.1.chipDaily", "intro.1.chipTravel"] as const).map(
            (key) => (
              <span
                key={key}
                className="rounded-full border border-line-strong px-4 py-2 text-base"
              >
                {t(key)}
              </span>
            ),
          )}
        </div>
      ),
    },
    {
      title: "intro.2.title",
      body: "intro.2.body",
      visual: <WaveformBadge />,
    },
    {
      title: "intro.3.title",
      body: "intro.3.body",
      visual: (
        <div className="flex gap-2">
          {[1, 2, 3].map((n) => (
            <span
              key={n}
              className={
                "rounded-xl border px-3 py-2 text-base " +
                (n === 1
                  ? "border-accent bg-accent/10 text-fg"
                  : "border-line-strong text-muted")
              }
            >
              {t("intro.3.day", { n })}
            </span>
          ))}
        </div>
      ),
    },
  ];

  function step(): number {
    const el = scroller.current;
    const first = el?.children[0] as HTMLElement | undefined;
    const second = el?.children[1] as HTMLElement | undefined;
    if (!first) return 0;
    return second ? second.offsetLeft - first.offsetLeft : first.offsetWidth;
  }

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    const s = step();
    setIndex(atEnd ? TOTAL - 1 : s > 0 ? Math.round(el.scrollLeft / s) : 0);
  }

  function goTo(i: number) {
    const el = scroller.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(TOTAL - 1, i));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: clamped * step(), behavior: reduce ? "auto" : "smooth" });
    setIndex(clamped);
  }

  const isLast = index === TOTAL - 1;

  return (
    <Screen>
      <BrandHeader />

      <div
        ref={scroller}
        onScroll={onScroll}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") goTo(index + 1);
          if (e.key === "ArrowLeft") goTo(index - 1);
        }}
        tabIndex={0}
        role="region"
        aria-roledescription="carousel"
        aria-label={t("intro.carouselLabel")}
        className="no-scrollbar mt-8 flex snap-x snap-mandatory gap-3 overflow-x-auto rounded-3xl"
      >
        {cards.map((card, i) => (
          <section
            key={card.title}
            role="group"
            aria-roledescription="slide"
            aria-label={t("intro.cardOf", { n: i + 1, total: TOTAL })}
            className="flex min-h-[380px] w-[86%] shrink-0 snap-start flex-col rounded-3xl border border-line bg-surface p-6"
          >
            <p className="text-base text-muted">
              {i + 1} / {TOTAL}
            </p>
            <h2 className="mt-6 text-[28px] leading-tight font-bold">{t(card.title)}</h2>
            <p className="mt-3 text-base text-muted">{t(card.body)}</p>
            <div className="mt-auto pt-8">{card.visual}</div>
          </section>
        ))}
      </div>

      <div className="mt-5 flex justify-center gap-1">
        {Array.from({ length: TOTAL }, (_, i) => (
          <button
            key={i}
            type="button"
            aria-label={t("intro.goToCard", { n: i + 1 })}
            aria-current={index === i ? "true" : undefined}
            onClick={() => goTo(i)}
            className="grid h-11 w-8 place-items-center"
          >
            <span
              className={
                "h-2.5 rounded-full transition-all " +
                (index === i ? "w-6 bg-accent" : "w-2.5 bg-line-strong")
              }
            />
          </button>
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between gap-4 pt-6">
        <button
          type="button"
          onClick={() => router.push("/goal")}
          className="h-14 rounded-2xl px-4 text-[17px] font-medium text-muted hover:text-fg"
        >
          {t("intro.skip")}
        </button>
        <PrimaryButton
          type="button"
          className="w-auto min-w-40"
          onClick={() => (isLast ? router.push("/goal") : goTo(index + 1))}
        >
          {t(isLast ? "intro.start" : "intro.next")}
        </PrimaryButton>
      </div>
    </Screen>
  );
}

function WaveformBadge() {
  const bars = [10, 22, 34, 18, 28, 12];
  return (
    <div
      aria-hidden="true"
      className="grid size-20 place-items-center rounded-full bg-accent text-accent-ink"
    >
      <svg width="40" height="40" viewBox="0 0 40 40" fill="currentColor">
        {bars.map((h, i) => (
          <rect key={i} x={4 + i * 6} y={20 - h / 2} width="3.5" height={h} rx="1.75" />
        ))}
      </svg>
    </div>
  );
}
