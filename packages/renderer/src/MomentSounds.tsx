import { createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js";
import type { SoundCue, Theme, View } from "@quiz/schema";
import { detectMoments } from "./moments.ts";

/**
 * Theme sound pack (doc 06): plays the sound of each detected moment. Embedded in the output (captured by OBS / vMix as
 * the browser source audio) only when the output link asks for it (`?sound=on`), so the control room can choose.
 * Audio elements are created up front (preload) so the first cue does not wait for the network.
 */
export function MomentSounds(p: { readonly view: View | null; readonly serverNow: () => number; readonly theme: Theme; readonly mediaUrl: (hash: string) => string }): JSX.Element {
  /** `blocked`: the browser refused autoplay (no user gesture) — visible to diagnosis as `[data-sound]`, never on air. */
  const [state, setState] = createSignal<"ready" | "played" | "blocked">("ready");
  const players = createMemo(() => {
    const m = new Map<SoundCue, HTMLAudioElement>();
    for (const [cue, hash] of Object.entries(p.theme.sounds) as [SoundCue, string][]) { // oxlint-disable-line typescript/no-unsafe-type-assertion -- keys of a partialRecord(SoundCue)
      const a = new Audio(p.mediaUrl(hash));
      a.preload = "auto";
      m.set(cue, a);
    }
    return m;
  });
  createEffect(
    on(
      () => p.view,
      (next, prev) => {
        if (next === null) return;
        for (const moment of detectMoments(prev ?? null, next, p.serverNow())) {
          const a = players().get(moment.kind);
          if (a === undefined) continue;
          a.volume = p.theme.volume;
          a.currentTime = 0;
          // Autoplay may be refused outside OBS / vMix (no user gesture): never break the output for a sound.
          a.play().then(() => setState("played"), () => setState("blocked"));
        }
      },
    ),
  );
  onCleanup(() => {
    for (const a of players().values()) a.pause();
  });
  return <span hidden data-sound={state()} />;
}
