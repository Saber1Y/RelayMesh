import type { CSSProperties, ReactNode } from "react";
import { Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadGeistMono } from "@remotion/google-fonts/GeistMono";

/** The site's tokens (apps/web/src/app/globals.css), so the film and the product look like one thing. */
export const C = {
  canvas: "#f7f6fb",
  surface: "#ffffff",
  raised: "#f1eff8",
  line: "#e6e3ef",
  lineStrong: "#d3cee1",
  ink: "#17131f",
  muted: "#625c72",
  accent: "#6343e0",
  accentSoft: "#efebff",
  accentTint: "#c9bdfb",
  positive: "#127045",
  positiveSoft: "#e5f5ec",
  caution: "#8f5600",
  cautionSoft: "#fdf1dc",
  info: "#2a64c9",
} as const;

export const sans = loadGeist("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] }).fontFamily;
export const mono = loadGeistMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

/** The site's panel shadow, violet-tinted, scaled to the frame. */
export const panelShadow = (u: number) => `0 ${1 * u}px ${2 * u}px rgb(40 24 96 / 0.05), 0 ${24 * u}px ${56 * u}px -${20 * u}px rgb(60 36 150 / 0.28)`;

/**
 * Springy entrance from 92% scale and transparent: never from zero, settles quickly, slight
 * overshoot. Returns 0..1 progress plus ready-made transform/opacity.
 */
export function usePop(delay = 0, config: { damping?: number; stiffness?: number; mass?: number } = {}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 170, mass: 0.7, ...config } });
  return {
    p,
    style: { opacity: interpolate(p, [0, 0.6], [0, 1], { extrapolateRight: "clamp" }), transform: `scale(${0.92 + 0.08 * p})` } as CSSProperties,
  };
}

/** 0..1 over a frame range, eased out (strong ease-out, matching the site's --ease-out). */
export function useProgress(start: number, end: number) {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [start, end], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return 1 - Math.pow(1 - t, 3);
}

/** The site's panel: white surface, hairline border, 18px radius, soft violet shadow. */
export function Panel({ children, style, u }: { children: ReactNode; style?: CSSProperties; u: number }) {
  return (
    <div style={{ background: C.surface, border: `${1.5 * u}px solid ${C.line}`, borderRadius: 26 * u, boxShadow: panelShadow(u), ...style }}>
      {children}
    </div>
  );
}

/** A pill tag, like the status tags on the site. */
export function Tag({ children, color, soft, u, style }: { children: ReactNode; color: string; soft: string; u: number; style?: CSSProperties }) {
  return (
    <span
      style={{
        fontFamily: sans,
        fontWeight: 600,
        fontSize: 26 * u,
        color,
        background: soft,
        borderRadius: 999,
        padding: `${8 * u}px ${20 * u}px`,
        whiteSpace: "nowrap",
        display: "inline-flex",
        alignItems: "center",
        gap: 10 * u,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** The RelayMesh mark, the site's own icon (apps/web/src/app/icon.svg). */
export function Mark({ size }: { size: number }) {
  return <Img src={staticFile("brand/icon.svg")} style={{ width: size, height: size, display: "block" }} />;
}

/** The canvas with the site's violet wash across the top; the glows drift very slowly. */
export function Backdrop() {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 90) * 4;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: `radial-gradient(ellipse 60% 45% at ${18 + drift}% -6%, rgb(99 67 224 / 0.14), transparent 70%), radial-gradient(ellipse 45% 35% at ${88 - drift}% -4%, rgb(140 110 255 / 0.11), transparent 70%), ${C.canvas}`,
      }}
    />
  );
}
