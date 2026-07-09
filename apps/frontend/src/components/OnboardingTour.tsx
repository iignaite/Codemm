"use client";

import { useEffect, useMemo, useState } from "react";

export type TourStep = {
  id: string;
  selector: string;
  title: string;
  body: string;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function safeRect(target: Element | null): DOMRect | null {
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

type Highlight = {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
};

export function OnboardingTour(props: {
  open: boolean;
  steps: TourStep[];
  onClose: () => void;
}) {
  const { open, steps, onClose } = props;
  const [index, setIndex] = useState(0);
  const [highlight, setHighlight] = useState<Highlight | null>(null);

  // Restart from the first step whenever the tour is (re)opened. Adjusting
  // state during render avoids the extra effect-driven render pass.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setIndex(0);
  }

  const active = steps[index] ?? null;

  const isLast = index >= steps.length - 1;

  useEffect(() => {
    if (!open || !active) return;

    let raf = 0;
    const measure = () => {
      const el = document.querySelector(active.selector);
      const rect = safeRect(el);
      if (!rect) {
        setHighlight(null);
        return;
      }

      const pad = 10;
      const next: Highlight = {
        left: clamp(rect.left - pad, 8, window.innerWidth - 8),
        top: clamp(rect.top - pad, 8, window.innerHeight - 8),
        width: clamp(rect.width + pad * 2, 0, window.innerWidth - 16),
        height: clamp(rect.height + pad * 2, 0, window.innerHeight - 16),
        radius: 16,
      };
      setHighlight(next);
    };

    const scrollToTarget = () => {
      const el = document.querySelector(active.selector);
      if (!el) return;
      try {
        (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
      } catch {
        // ignore
      }
    };

    scrollToTarget();
    raf = window.requestAnimationFrame(measure);

    const onResize = () => {
      window.requestAnimationFrame(measure);
    };
    const onScroll = () => {
      window.requestAnimationFrame(measure);
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, active?.selector, active?.id]);

  const tooltipStyle = useMemo(() => {
    if (!highlight) return { left: 24, top: 24 } as const;

    const preferTop = highlight.top + highlight.height + 220 > window.innerHeight;
    const top = preferTop ? highlight.top - 12 : highlight.top + highlight.height + 12;
    const left = highlight.left;

    const maxWidth = 360;
    const safeLeft = clamp(left, 16, window.innerWidth - maxWidth - 16);
    const safeTop = clamp(top, 16, window.innerHeight - 240);

    return { left: safeLeft, top: safeTop } as const;
  }, [highlight]);

  if (!open || steps.length === 0 || !active) return null;

  return (
    <div
      ref={(el) => {
        // Move focus into the dialog so keyboard users interact with the tour,
        // not the page behind the overlay.
        if (el && !el.contains(document.activeElement)) el.focus();
      }}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="fixed inset-0 z-[100] flex items-start justify-start outline-none"
      role="dialog"
      aria-modal="true"
      aria-label="Tutorial"
    >
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {highlight && (
        <div
          className="pointer-events-none absolute border border-white/70"
          style={{
            left: highlight.left,
            top: highlight.top,
            width: highlight.width,
            height: highlight.height,
            borderRadius: highlight.radius,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
          }}
        />
      )}

      <div
        className="absolute w-[360px] max-w-[calc(100vw-32px)] rounded-2xl border border-white/10 bg-slate-950/90 p-4 text-slate-50 shadow-2xl backdrop-blur"
        style={tooltipStyle}
      >
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
          Tutorial • Step {index + 1} of {steps.length}
        </div>
        <div className="mt-2 text-sm font-semibold text-white">{active.title}</div>
        <div className="mt-1 text-sm text-slate-200">{active.body}</div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
              className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-white/10 disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => {
                if (isLast) onClose();
                else setIndex((i) => Math.min(steps.length - 1, i + 1));
              }}
              className="rounded-full bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
            >
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

