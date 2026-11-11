/**
 * Keeps the tablet screen on without HTTPS (ADR-0012).
 * - Screen Wake Lock when the page happens to be a secure context (localhost / future HTTPS option).
 * - Otherwise a muted, inline, looping video started from the user's tap ("Commencer"). Autoplay of muted inline
 *   video is allowed (https://webkit.org/blog/6784/new-video-policies-for-ios/); that playback prevents display sleep
 *   is NOT officially documented — validated on the real fleet during rehearsal (OPEN-QUESTIONS).
 * Sleeping is not fatal anyway: the client reconnects, resyncs and resends un-acked answers.
 */
export type KeepAwake = { start(): Promise<"wake-lock" | "video" | "none">; readonly active: () => boolean };

async function startWakeLock(): Promise<boolean> {
  if (!window.isSecureContext || !("wakeLock" in navigator)) return false;
  try {
    await navigator.wakeLock.request("screen");
    return true;
  } catch {
    return false;
  }
}

export function createKeepAwake(videoUrl: string): KeepAwake {
  let mode: "wake-lock" | "video" | "none" = "none";
  let video: HTMLVideoElement | null = null;

  const startVideo = async (): Promise<boolean> => {
    if (video === null) {
      video = document.createElement("video");
      video.src = videoUrl;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("muted", "");
      Object.assign(video.style, { position: "fixed", width: "1px", height: "1px", opacity: "0.01", pointerEvents: "none", left: "0", bottom: "0" });
      document.body.append(video);
    }
    try {
      await video.play();
      return true;
    } catch {
      return false;
    }
  };

  // Browsers release both when the page is hidden: re-arm when it comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && mode !== "none") void start();
  });

  async function start(): Promise<"wake-lock" | "video" | "none"> {
    if (await startWakeLock()) mode = "wake-lock";
    else if (await startVideo()) mode = "video";
    else mode = "none";
    return mode;
  }

  return { start, active: () => mode !== "none" };
}

/** Fullscreen on the same tap (allowed over HTTP with a user gesture; ignored where unsupported, e.g. iPhone). */
export async function enterFullscreen(): Promise<void> {
  const el = document.documentElement;
  if (document.fullscreenElement !== null || typeof el.requestFullscreen !== "function") return;
  try {
    await el.requestFullscreen({ navigationUI: "hide" });
  } catch {
    /* not allowed on this device: fine */
  }
}
