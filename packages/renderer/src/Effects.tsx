// oxlint-disable-next-line typescript/triple-slash-reference -- untyped pixi.js subpath, needed by every package compiling renderer sources
/// <reference path="./pixi-unsafe-eval.d.ts" />
import { createEffect, createSignal, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import type { View } from "@quiz/schema";
import { PARTICLES, detectMoments, type EffectsLevel, type Moment } from "./moments.ts";

/**
 * WebGL effects layer above the DOM scene (ADR-0005): particles for moments, PixiJS loaded lazily so the
 * `off` level costs nothing. Quality levels full / light / off (AUDIT A11). `bench` keeps emitting and shows
 * the frame rate, to measure inside OBS / vMix before choosing the default (OPEN-QUESTIONS).
 */
type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: number; size: number; spin: number; g: { x: number; y: number; rotation: number; alpha: number; destroy(): void } };

export function Effects(p: { readonly view: View | null; readonly serverNow: () => number; readonly level: EffectsLevel; readonly bench?: boolean; readonly width: number; readonly height: number; readonly accent: string }): JSX.Element {
  let host: HTMLDivElement | undefined;
  const [fps, setFps] = createSignal(0);
  let spawn: ((m: Moment) => void) | null = null;
  let destroy: (() => void) | null = null;

  onMount(() => {
    if (p.level === "off" || host === undefined) return;
    const el = host;
    let cancelled = false;
    void (async () => {
      // Strict CSP (no 'unsafe-eval'): this module swaps Pixi's eval-generated shader sync for polyfills.
      const [PIXI] = await Promise.all([import("pixi.js"), import("pixi.js/unsafe-eval")]);
      if (cancelled) return;
      const app = new PIXI.Application();
      await app.init({ width: p.width, height: p.height, backgroundAlpha: 0, antialias: p.level === "full", preference: "webgl" });
      if (cancelled) {
        app.destroy();
        return;
      }
      el.append(app.canvas);
      Object.assign(app.canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
      const particles: Particle[] = [];
      const accent = Number.parseInt(p.accent.replace("#", "").slice(0, 6), 16) || 0xffcc4d;
      const palette = [accent, 0x22c55e, 0x38bdf8, 0xffffff, 0x7c5cff];
      // Deterministic-enough pseudo random for visuals only (never game logic).
      let seed = 1;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const burst = (count: number, x: number, y: number, spread: number) => {
        for (let i = 0; i < count; i++) {
          const g = new PIXI.Graphics().rect(-6, -3, 12, 6).fill(palette[i % palette.length] ?? accent);
          g.x = x;
          g.y = y;
          app.stage.addChild(g);
          const angle = -Math.PI / 2 + (rnd() - 0.5) * spread;
          const speed = 6 + rnd() * 14;
          particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, color: 0, size: 1, spin: (rnd() - 0.5) * 0.4, g });
        }
      };
      spawn = (m: Moment) => {
        const n = PARTICLES[p.level];
        switch (m.kind) {
          case "answer.correct":
          case "buzzer.won":
          case "ladder.reached":
            burst(n, p.width / 2, p.height * 0.8, Math.PI * 0.9);
            break;
          case "podium":
            burst(n, p.width * 0.25, p.height, Math.PI * 0.5);
            burst(n, p.width * 0.75, p.height, Math.PI * 0.5);
            break;
          case "leader.changed":
            burst(Math.round(n / 3), p.width / 2, p.height * 0.25, Math.PI * 2);
            break;
          case "timer.last5":
          case "answer.wrong":
            break; // timer zone colour / theme sound; no particles
        }
      };
      let frames = 0;
      let last = performance.now();
      let benchClock = 0;
      app.ticker.add((t) => {
        const dt = t.deltaMS / 16.67;
        for (let i = particles.length - 1; i >= 0; i--) {
          const q = particles[i];
          if (q === undefined) continue;
          q.vy += 0.35 * dt;
          q.vx *= 0.99;
          q.x += q.vx * dt;
          q.y += q.vy * dt;
          q.life -= 0.006 * dt;
          q.g.x = q.x;
          q.g.y = q.y;
          q.g.rotation += q.spin * dt;
          q.g.alpha = Math.max(0, q.life);
          if (q.life <= 0 || q.y > p.height + 40) {
            q.g.destroy();
            particles.splice(i, 1);
          }
        }
        if (p.bench === true) {
          benchClock += t.deltaMS;
          if (benchClock > 700) {
            benchClock = 0;
            spawn?.({ kind: "answer.correct" });
          }
        }
        frames++;
        const now = performance.now();
        if (now - last >= 1000) {
          setFps(Math.round((frames * 1000) / (now - last)));
          frames = 0;
          last = now;
        }
      });
      destroy = () => app.destroy(true, { children: true });
    })();
    onCleanup(() => {
      cancelled = true;
      destroy?.();
    });
  });

  // React to view changes only (the server decided; we just celebrate).
  createEffect(
    on(
      () => p.view,
      (next, prev) => {
        if (next === null || spawn === null) return;
        for (const m of detectMoments(prev ?? null, next, p.serverNow())) spawn(m);
      },
    ),
  );

  return (
    <div ref={host} class="q-effects" style={{ position: "absolute", inset: "0", "pointer-events": "none", "z-index": 80 }}>
      <Show when={p.bench === true}>
        <div style={{ position: "absolute", right: "24px", top: "24px", padding: "8px 14px", background: "rgba(0,0,0,.7)", color: "#fff", font: "700 28px ui-monospace, monospace", "border-radius": "8px" }}>
          {fps()} fps · effets {p.level}
        </div>
      </Show>
    </div>
  );
}
