"use client";

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useSettingsStore } from "@/stores/settings-store";
import { mailTextFactor, plainBodyFontSize } from "@/lib/mail-reading";

/**
 * The reading settings as they apply to the message open right now: "follow
 * the system" values resolved against the OS, and the values the body frame
 * and the plain-text body need. Shared by the reader and the conversation
 * view so a message reads the same in both.
 */
export interface MailReading {
  /** Multiplier on the mail's text sizes. */
  textFactor: number;
  /** Smallest text size in the body, CSS px; 0 = none. */
  minFontSize: number;
  /** Font size for a plain-text body of `basePx` at 100 %. */
  plainFontSize: (basePx: number) => string;
  /** Changes whenever the body frame has to be built again. */
  frameKey: string;
}

export function useMailReading(): MailReading {
  const s = useSettingsStore(useShallow((state) => ({
    fontSize: state.fontSize,
    mailTextScale: state.mailTextScale,
    mailMinFontSize: state.mailMinFontSize,
  })));

  return useMemo(() => {
    const textFactor = mailTextFactor(s.mailTextScale, s.fontSize);
    const minFontSize = s.mailMinFontSize || 0;
    return {
      textFactor,
      minFontSize,
      plainFontSize: (basePx: number) => plainBodyFontSize(basePx, s.mailTextScale, s.fontSize, minFontSize),
      frameKey: `${textFactor}/${minFontSize}`,
    };
  }, [s.mailTextScale, s.fontSize, s.mailMinFontSize]);
}
