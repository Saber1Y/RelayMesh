import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop, C, Mark, Panel, Tag, mono, panelShadow, sans, usePop, useProgress } from "./brand";
import manifest from "../public/voiceover/manifest.json";

/**
 * RelayMesh motion intro at 30 fps. Scene lengths are worked out from the voiceover itself
 * (public/voiceover/manifest.json): each scene opens, its line starts LEAD frames later, and the
 * next scene follows TAIL frames after the line ends, so the narration stays compact. Each scene
 * also has a minimum length so its animation always has room to play.
 *
 * Every figure on screen is real: the 10 tPOT transfer of intent 0x6a5230a3...b193 (block #291963,
 * anchored in block #291968) and bridge deposit 860457-1, as served by the live API.
 */
export const FPS = 30;
const LEAD = 8;
const TAIL = 10;
/** How long the logo holds after the last line. */
const HOLD = 70;

const ORDER = [
  { name: "blackbox", vo: "intro-01", min: 110 },
  { name: "hope", vo: "intro-02", min: 80 },
  { name: "reveal", vo: "intro-03", min: 80 },
  { name: "quote", vo: "intro-04", min: 150 },
  { name: "timeline", vo: "intro-05", min: 125 },
  { name: "receipt", vo: "intro-06", min: 140 },
  { name: "bridge", vo: "intro-07", min: 110 },
  { name: "api", vo: "intro-08", min: 110 },
  { name: "logo", vo: "intro-09", min: 0 },
] as const;

type SceneName = (typeof ORDER)[number]["name"];
type Timing = { from: number; to: number; vo: { id: string; at: number } };

function timeline(): { scenes: Record<SceneName, Timing>; duration: number } {
  const scenes = {} as Record<SceneName, Timing>;
  let t = 0;
  for (const s of ORDER) {
    const line = (manifest as Record<string, { seconds: number }>)[s.vo];
    if (!line) throw new Error(`voiceover line ${s.vo} is missing; run pnpm voiceover`);
    const vo = Math.ceil(line.seconds * FPS);
    const length = Math.max(s.min, LEAD + vo + (s.name === "logo" ? HOLD : TAIL));
    scenes[s.name] = { from: t, to: t + length, vo: { id: s.vo, at: t + LEAD } };
    t += length;
  }
  return { scenes, duration: t };
}

const { scenes: SCENES, duration } = timeline();
export const DURATION = duration;

/** Layout helpers: everything is sized in units of the short side, so 16:9, 1:1 and 9:16 all work. */
function useLayout() {
  const { width, height } = useVideoConfig();
  const u = Math.min(width, height) / 1080;
  return { width, height, u, wide: width / height > 1.3, tall: height / width > 1.3 };
}

function Center({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", ...style }}>{children}</AbsoluteFill>;
}

/**
 * A feature scene: the headline on the left and the product on the right in 16:9, stacked in
 * 1:1 and 9:16. The headline is the scene's idea in a few words, so the film reads with the sound off.
 */
function Feature({ kicker, title, children }: { kicker: string; title: ReactNode; children: ReactNode }) {
  const { u, wide, tall } = useLayout();
  const k = usePop(2);
  const h = usePop(8);
  const body = usePop(16);
  return (
    <Center style={{ flexDirection: wide ? "row" : "column", gap: (wide ? 110 : tall ? 80 : 56) * u, padding: `0 ${70 * u}px` }}>
      <div style={{ width: wide ? 640 * u : 940 * u, display: "flex", flexDirection: "column", gap: 20 * u, alignItems: wide ? "flex-start" : "center", textAlign: wide ? "left" : "center" }}>
        <div style={{ ...k.style, fontFamily: mono, fontSize: 28 * u, color: C.accent, letterSpacing: 1 * u, whiteSpace: "nowrap" }}>{kicker}</div>
        <div style={{ ...h.style, fontFamily: sans, fontWeight: 600, fontSize: (tall ? 84 : 76) * u, lineHeight: 1.04, letterSpacing: -2.4 * u, color: C.ink }}>{title}</div>
      </div>
      <div style={{ ...body.style, width: 900 * u, flexShrink: 0 }}>{children}</div>
    </Center>
  );
}

const Accent = ({ children }: { children: ReactNode }) => <span style={{ color: C.accent }}>{children}</span>;

/** A green tick in a soft circle, drawn on as `p` goes 0..1. */
function Tick({ size, p, color = C.positive, soft = C.positiveSoft }: { size: number; p: number; color?: string; soft?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="12" fill={p > 0 ? soft : C.raised} />
      <path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="16" strokeDashoffset={16 * (1 - p)} />
    </svg>
  );
}

/** A spinning ring for "waiting" states. */
function Spinner({ size, color = C.caution }: { size: number; color?: string }) {
  const frame = useCurrentFrame();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${frame * 9}deg)`, flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" fill="none" stroke={`${color}33`} strokeWidth="3" />
      <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Text that types itself out between two frames. */
function Typed({ text, start, end }: { text: string; start: number; end: number }) {
  const frame = useCurrentFrame();
  const n = Math.round(interpolate(frame, [start, end], [0, text.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  return <>{text.slice(0, n)}</>;
}

// ---------------------------------------------------------------------------
// 1. "Moving tokens across chains usually means trusting a black box."
// ---------------------------------------------------------------------------
function SceneBlackBox() {
  const { u, wide, tall: portrait } = useLayout();
  const tall = !wide;
  const frame = useCurrentFrame();
  const from = usePop(4);
  const box = usePop(14);
  const to = usePop(26);
  const title = usePop(40);
  // The token travels from the source into the box, then is gone.
  const travel = useProgress(48, 86);
  const gap = 300 * u;
  const wobble = frame > 80 && frame < 100 ? Math.sin((frame - 80) / 2) * 2.5 * (1 - (frame - 80) / 20) : 0;
  const chainPill = (label: string, sub: string, style: CSSProperties) => (
    <div style={{ ...style, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 * u, width: 300 * u }}>
      <Panel u={u} style={{ padding: `${18 * u}px ${30 * u}px`, fontFamily: sans, fontWeight: 600, fontSize: 34 * u, color: C.ink, whiteSpace: "nowrap" }}>
        {label}
      </Panel>
      <div style={{ fontFamily: mono, fontSize: 26 * u, color: C.muted, whiteSpace: "nowrap" }}>{sub}</div>
    </div>
  );
  return (
    <Center style={{ flexDirection: "column", gap: (portrait ? 140 : wide ? 90 : 56) * u }}>
      <div style={{ position: "relative", display: "flex", flexDirection: tall ? "column" : "row", alignItems: "center", gap: (portrait ? 70 : wide ? 60 : 34) * u }}>
        {chainPill("Chain A", "you send", from.style)}
        <div style={{ ...box.style, transform: `${box.style.transform} rotate(${wobble}deg)`, width: 280 * u, height: 280 * u, borderRadius: 40 * u, background: C.ink, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 ${30 * u}px ${60 * u}px -${24 * u}px rgb(23 19 31 / 0.55)` }}>
          <span style={{ fontFamily: sans, fontWeight: 600, fontSize: 150 * u, color: "#ffffff22" }}>?</span>
        </div>
        {chainPill("Chain B", "you receive?", to.style)}
        {/* The token: starts over Chain A and slides into the box. */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            opacity: interpolate(travel, [0, 0.1, 0.8, 1], [0, 1, 1, 0]) * from.p,
            transform: tall
              ? `translate(-50%, -50%) translateY(${-gap * 1.15 * (1 - travel)}px) scale(${1 - 0.4 * travel})`
              : `translate(-50%, -50%) translateX(${-gap * 1.2 * (1 - travel)}px) translateY(${-110 * u * (1 - travel)}px) scale(${1 - 0.4 * travel})`,
          }}
        >
          <Tag u={u} color="#ffffff" soft={C.accent} style={{ fontSize: 30 * u, boxShadow: `0 ${10 * u}px ${24 * u}px -${8 * u}px rgb(99 67 224 / 0.6)` }}>
            10 tPOT
          </Tag>
        </div>
      </div>
      <div style={{ ...title.style, fontFamily: sans, fontWeight: 600, fontSize: 64 * u, letterSpacing: -1.8 * u, color: C.ink, textAlign: "center", whiteSpace: "nowrap" }}>
        Cross-chain is a <span style={{ background: C.ink, color: "#fff", borderRadius: 14 * u, padding: `0 ${16 * u}px` }}>black box.</span>
      </div>
    </Center>
  );
}

// ---------------------------------------------------------------------------
// 2. "You sign, you wait, and you hope it lands."
// ---------------------------------------------------------------------------
function SceneHope() {
  const { u, wide } = useLayout();
  const frame = useCurrentFrame();
  const words = ["You sign.", "You wait.", "You hope."];
  const pill = usePop(6);
  const secs = Math.floor(interpolate(frame, [6, 90], [3, 41], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  return (
    <Center style={{ flexDirection: "column", gap: 70 * u }}>
      <div style={{ display: "flex", flexDirection: wide ? "row" : "column", gap: (wide ? 44 : 18) * u, alignItems: "center" }}>
        {words.map((w, i) => (
          <Word key={w} delay={4 + i * 16} last={i === words.length - 1}>
            {w}
          </Word>
        ))}
      </div>
      <div style={pill.style}>
        <Panel u={u} style={{ display: "flex", alignItems: "center", gap: 18 * u, padding: `${18 * u}px ${34 * u}px`, borderRadius: 999 }}>
          <Spinner size={40 * u} />
          <span style={{ fontFamily: sans, fontWeight: 500, fontSize: 34 * u, color: C.caution, whiteSpace: "nowrap" }}>Pending</span>
          <span style={{ fontFamily: mono, fontSize: 32 * u, color: C.muted, whiteSpace: "nowrap" }}>0:{String(secs).padStart(2, "0")}</span>
          <span style={{ fontFamily: sans, fontSize: 32 * u, color: C.muted, whiteSpace: "nowrap" }}>· no status, no proof</span>
        </Panel>
      </div>
    </Center>
  );
}

function Word({ children, delay, last }: { children: ReactNode; delay: number; last: boolean }) {
  const { u } = useLayout();
  const pop = usePop(delay);
  return <div style={{ ...pop.style, fontFamily: sans, fontWeight: 600, fontSize: 104 * u, letterSpacing: -3.4 * u, color: last ? C.ink : C.muted, whiteSpace: "nowrap" }}>{children}</div>;
}

// ---------------------------------------------------------------------------
// 3. "RelayMesh opens the box, right on Portal Dot."
// ---------------------------------------------------------------------------
function SceneReveal() {
  const { u } = useLayout();
  const open = useProgress(4, 30);
  const mark = usePop(16, { damping: 11 });
  const word = usePop(26);
  const tag = usePop(42);
  return (
    <Center style={{ flexDirection: "column", gap: 44 * u }}>
      <div style={{ position: "relative", width: 260 * u, height: 260 * u }}>
        {/* The black box splits open and fades, leaving the mark. */}
        <div style={{ position: "absolute", inset: 0, opacity: 1 - open, transform: `translateX(${-120 * u * open}px) rotate(${-14 * open}deg)`, clipPath: "inset(0 50% 0 0)", background: C.ink, borderRadius: 40 * u, filter: `blur(${5 * open}px)` }} />
        <div style={{ position: "absolute", inset: 0, opacity: 1 - open, transform: `translateX(${120 * u * open}px) rotate(${14 * open}deg)`, clipPath: "inset(0 0 0 50%)", background: C.ink, borderRadius: 40 * u, filter: `blur(${5 * open}px)` }} />
        <div style={{ ...mark.style, position: "absolute", inset: 0, filter: `drop-shadow(0 ${24 * u}px ${36 * u}px rgb(99 67 224 / 0.45))` }}>
          <Mark size={260 * u} />
        </div>
      </div>
      <div style={{ ...word.style, fontFamily: sans, fontWeight: 600, fontSize: 132 * u, letterSpacing: -4.6 * u, color: C.ink, whiteSpace: "nowrap" }}>RelayMesh</div>
      <div style={tag.style}>
        <Tag u={u} color={C.accent} soft={C.accentSoft} style={{ fontSize: 32 * u, padding: `${10 * u}px ${26 * u}px` }}>
          Live on PortalDot
        </Tag>
      </div>
    </Center>
  );
}

// ---------------------------------------------------------------------------
// 4. "Choose where it goes, and see each fee before you pay. Then sign once."
// ---------------------------------------------------------------------------
function SceneQuote() {
  const { u } = useLayout();
  const frame = useCurrentFrame();
  const rows: [string, string, boolean?][] = [
    ["You send", "10 tPOT"],
    ["They receive", "10 tPOT"],
    ["Network fee", "0.0195 tPOT"],
    ["RelayMesh fee", "0.2 tPOT", true],
    ["Estimated time", "18 s"],
  ];
  // The button is pressed, then turns into a signed state.
  const press = frame > 128 && frame < 136 ? 0.96 : 1;
  const signed = useProgress(134, 146);
  return (
    <Feature kicker="01 · quote" title={<>Every fee, <Accent>before you pay.</Accent></>}>
      <Panel u={u} style={{ padding: 40 * u, display: "flex", flexDirection: "column", gap: 8 * u }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 * u, marginBottom: 18 * u }}>
          <Tag u={u} color={C.ink} soft={C.raised}>PortalDot Substrate</Tag>
          <span style={{ fontFamily: sans, fontSize: 34 * u, color: C.accent }}>→</span>
          <Tag u={u} color={C.ink} soft={C.raised}>PortalDot EVM</Tag>
        </div>
        {rows.map(([k, v, hi], i) => (
          <QuoteRow key={k} delay={22 + i * 14} label={k} value={v} highlight={hi} />
        ))}
        <div
          style={{
            marginTop: 26 * u,
            transform: `scale(${press})`,
            borderRadius: 999,
            padding: `${22 * u}px 0`,
            textAlign: "center",
            fontFamily: sans,
            fontWeight: 600,
            fontSize: 36 * u,
            color: "#fff",
            background: interpolateColor(signed),
            boxShadow: `0 ${10 * u}px ${26 * u}px -${10 * u}px ${signed > 0.5 ? "rgb(18 112 69 / 0.5)" : "rgb(99 67 224 / 0.6)"}`,
            position: "relative",
          }}
        >
          <span style={{ opacity: 1 - signed, filter: `blur(${5 * signed}px)` }}>Sign once</span>
          <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", opacity: signed, filter: `blur(${5 * (1 - signed)}px)` }}>Signed · one signature</span>
        </div>
      </Panel>
    </Feature>
  );
}

/** Accent violet to positive green, for the button's signed state. */
function interpolateColor(t: number) {
  const a = [0x63, 0x43, 0xe0];
  const b = [0x12, 0x70, 0x45];
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(" ")})`;
}

function QuoteRow({ delay, label, value, highlight }: { delay: number; label: string; value: string; highlight?: boolean }) {
  const { u } = useLayout();
  const pop = usePop(delay);
  return (
    <div
      style={{
        ...pop.style,
        transform: `translateY(${12 * u * (1 - pop.p)}px)`,
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: `${16 * u}px ${20 * u}px`,
        borderRadius: 14 * u,
        background: highlight ? C.accentSoft : "transparent",
        fontFamily: sans,
        fontSize: 34 * u,
      }}
    >
      <span style={{ color: highlight ? C.accent : C.muted, fontWeight: highlight ? 600 : 400 }}>{label}</span>
      <span style={{ fontFamily: mono, color: C.ink, fontWeight: 500 }}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. "Watch each step settle live, until the funds arrive on the other side."
// ---------------------------------------------------------------------------
function SceneTimeline() {
  const { u } = useLayout();
  const frame = useCurrentFrame();
  const steps: [string, string][] = [
    ["Included in block #291963", "0 s"],
    ["Finalized on Substrate", "17 s"],
    ["Funds seen on EVM", "19 s"],
    ["Settled", "22 s"],
  ];
  const first = 30;
  const every = 26;
  const balanceStart = first + every * 2;
  // The destination's measured balance change, the figure RelayMesh settles on.
  const received = interpolate(frame, [balanceStart, balanceStart + 30], [0, 10], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const settled = frame >= first + every * 3;
  return (
    <Feature kicker="02 · settle" title={<>Every step, <Accent>live.</Accent></>}>
      <Panel u={u} style={{ padding: `${34 * u}px ${40 * u}px`, display: "flex", flexDirection: "column", gap: 4 * u }}>
        {steps.map(([label, at], i) => (
          <Step key={label} start={first + i * every} label={label} at={at} last={i === steps.length - 1} />
        ))}
        <div style={{ marginTop: 22 * u, padding: `${20 * u}px ${24 * u}px`, borderRadius: 16 * u, background: settled ? C.positiveSoft : C.raised, display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: sans, fontSize: 32 * u }}>
          <span style={{ color: C.muted, whiteSpace: "nowrap" }}>Received on EVM</span>
          <span style={{ fontFamily: mono, fontWeight: 500, color: settled ? C.positive : C.ink, whiteSpace: "nowrap" }}>+{received.toFixed(1)} tPOT</span>
        </div>
      </Panel>
    </Feature>
  );
}

function Step({ start, label, at, last }: { start: number; label: string; at: string; last: boolean }) {
  const { u } = useLayout();
  const frame = useCurrentFrame();
  const p = useProgress(start, start + 12);
  const waiting = frame >= start - 22 && frame < start;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 22 * u, padding: `${13 * u}px 0`, opacity: 0.45 + 0.55 * Math.max(p, waiting ? 0.6 : 0) }}>
      {waiting ? <Spinner size={44 * u} color={C.info} /> : <Tick size={44 * u} p={p} />}
      <span style={{ flex: 1, fontFamily: sans, fontWeight: last ? 600 : 500, fontSize: 34 * u, color: last && p > 0 ? C.positive : C.ink, whiteSpace: "nowrap" }}>{label}</span>
      <span style={{ fontFamily: mono, fontSize: 30 * u, color: C.muted, opacity: p }}>{at}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. "You get a receipt, and its hash is anchored on chain. Anyone can check it."
// ---------------------------------------------------------------------------
function SceneReceipt() {
  const { u } = useLayout();
  const stamp = usePop(112, { damping: 10, stiffness: 200 });
  const anchored = usePop(70);
  const rows: [string, ReactNode][] = [
    ["Intent", "0x6a5230a3…b193"],
    ["Receipt hash", <Typed key="h" text="0x1cddcc06cfe6…bb3b" start={30} end={64} />],
    ["Anchored", "block #291968 · 0.0186 tPOT"],
  ];
  return (
    <Feature kicker="03 · prove" title={<>A receipt <Accent>anyone can check.</Accent></>}>
      <div style={{ position: "relative" }}>
        <Panel u={u} style={{ padding: `${36 * u}px ${40 * u}px`, display: "flex", flexDirection: "column", gap: 6 * u }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 * u }}>
            <span style={{ fontFamily: sans, fontWeight: 600, fontSize: 38 * u, color: C.ink }}>Receipt</span>
            <Tag u={u} color={C.positive} soft={C.positiveSoft}>Settled</Tag>
          </div>
          {rows.map(([k, v], i) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: `${16 * u}px 0`, borderTop: `${1.5 * u}px solid ${C.line}`, fontSize: 32 * u, opacity: i === 2 ? anchored.p : 1 }}>
              <span style={{ fontFamily: sans, color: C.muted, whiteSpace: "nowrap" }}>{k}</span>
              <span style={{ fontFamily: mono, color: C.ink, whiteSpace: "nowrap" }}>{v}</span>
            </div>
          ))}
          <div style={{ ...anchored.style, marginTop: 12 * u, display: "flex", alignItems: "center", gap: 14 * u, fontFamily: sans, fontSize: 30 * u, color: C.accent }}>
            <Mark size={36 * u} />
            <span style={{ whiteSpace: "nowrap" }}>Written on PortalDot V3 by ReceiptBatchLog</span>
          </div>
        </Panel>
        <div
          style={{
            ...stamp.style,
            transform: `${stamp.style.transform} rotate(-5deg)`,
            position: "absolute",
            right: -24 * u,
            bottom: -46 * u,
            display: "flex",
            alignItems: "center",
            gap: 14 * u,
            padding: `${18 * u}px ${30 * u}px`,
            borderRadius: 999,
            background: C.positive,
            color: "#fff",
            fontFamily: sans,
            fontWeight: 600,
            fontSize: 34 * u,
            whiteSpace: "nowrap",
            boxShadow: `0 ${14 * u}px ${30 * u}px -${10 * u}px rgb(18 112 69 / 0.55)`,
          }}
        >
          <Tick size={40 * u} p={1} color={C.positive} soft="#fff" />
          Matches the chain
        </div>
      </div>
    </Feature>
  );
}

// ---------------------------------------------------------------------------
// 7. "It also checks the bridge to B N B Chain, one payout at a time."
// ---------------------------------------------------------------------------
function SceneBridge() {
  const { u } = useLayout();
  const left = usePop(20);
  const arrow = useProgress(36, 60);
  const right = usePop(52);
  const verdict = usePop(84);
  const side = (chain: string, amount: string, note: string, style: CSSProperties) => (
    <div style={{ ...style, flex: 1 }}>
      <Panel u={u} style={{ padding: `${30 * u}px ${32 * u}px`, display: "flex", flexDirection: "column", gap: 10 * u }}>
        <span style={{ fontFamily: sans, fontSize: 28 * u, color: C.muted, whiteSpace: "nowrap" }}>{chain}</span>
        <span style={{ fontFamily: mono, fontWeight: 500, fontSize: 46 * u, color: C.ink, whiteSpace: "nowrap" }}>{amount}</span>
        <span style={{ fontFamily: mono, fontSize: 26 * u, color: C.muted, whiteSpace: "nowrap" }}>{note}</span>
      </Panel>
    </div>
  );
  return (
    <Feature kicker="04 · bridge check" title={<>Bridge payouts, <Accent>verified.</Accent></>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 34 * u }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 * u }}>
          {side("PortalDot mainnet", "44 POT", "deposit 860457-1", left.style)}
          <svg width={70 * u} height={30 * u} viewBox="0 0 70 30" style={{ flexShrink: 0 }}>
            <path d="M2 15h60M50 4l12 11-12 11" fill="none" stroke={C.accent} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="100" strokeDashoffset={100 * (1 - arrow)} />
          </svg>
          {side("BNB Chain", "42.68 WPOT", "after the 3% bridge fee", right.style)}
        </div>
        <div style={{ ...verdict.style, display: "flex", gap: 16 * u, justifyContent: "center", flexWrap: "wrap" }}>
          <Tag u={u} color={C.positive} soft={C.positiveSoft} style={{ fontSize: 30 * u, padding: `${12 * u}px ${26 * u}px` }}>
            <Tick size={34 * u} p={1} soft="#fff" /> Payout verified
          </Tag>
          <Tag u={u} color={C.accent} soft={C.accentSoft} style={{ fontSize: 30 * u, padding: `${12 * u}px ${26 * u}px` }}>
            Check anchored on V3
          </Tag>
        </div>
      </div>
    </Feature>
  );
}

// ---------------------------------------------------------------------------
// 8. "And developers get it all through an open API."
// ---------------------------------------------------------------------------
function SceneApi() {
  const { u } = useLayout();
  const frame = useCurrentFrame();
  const cmd = "curl $BASE/api/intents/0x6a52…b193/receipt";
  const typedEnd = 52;
  const out: [string, string][] = [
    ['"status"', '"SETTLED"'],
    ['"verifiedBy"', '"evm_balance_delta"'],
    ['"verificationMode"', '"destination_rpc_state"'],
    ['"receiptHash"', '"0x1cdd…bb3b"'],
  ];
  const caret = Math.floor(frame / 15) % 2 === 0 && frame < typedEnd + 6;
  return (
    <Feature kicker="05 · developers" title={<>All of it, <Accent>one open API.</Accent></>}>
      <div style={{ background: C.ink, borderRadius: 26 * u, padding: `${30 * u}px ${36 * u}px`, boxShadow: panelShadow(u), fontFamily: mono, fontSize: 28 * u, lineHeight: 1.6 }}>
        <div style={{ display: "flex", gap: 10 * u, marginBottom: 20 * u }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <span key={c} style={{ width: 16 * u, height: 16 * u, borderRadius: 99, background: c, opacity: 0.85 }} />
          ))}
        </div>
        <div style={{ color: "#fff", whiteSpace: "nowrap" }}>
          <span style={{ color: C.accentTint }}>$ </span>
          <Typed text={cmd} start={14} end={typedEnd} />
          <span style={{ opacity: caret ? 1 : 0, color: C.accentTint }}>▍</span>
        </div>
        <div style={{ color: "#ffffff88" }}>{frame > typedEnd + 6 ? "{" : " "}</div>
        {out.map(([k, v], i) => {
          const show = interpolate(frame, [typedEnd + 10 + i * 8, typedEnd + 18 + i * 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <div key={k} style={{ opacity: show, transform: `translateY(${8 * u * (1 - show)}px)`, paddingLeft: 30 * u, whiteSpace: "nowrap" }}>
              <span style={{ color: C.accentTint }}>{k}</span>
              <span style={{ color: "#ffffff88" }}>: </span>
              <span style={{ color: "#8fe3b5" }}>{v}</span>
            </div>
          );
        })}
        <div style={{ color: "#ffffff88", opacity: frame > typedEnd + 50 ? 1 : 0 }}>{"}"}</div>
      </div>
    </Feature>
  );
}

// ---------------------------------------------------------------------------
// 9. "RelayMesh. Cross-chain transfers you can prove."
// ---------------------------------------------------------------------------
function SceneLogo() {
  const { u, wide } = useLayout();
  const tall = !wide;
  const icon = usePop(0, { damping: 11 });
  const word = usePop(8);
  const line = usePop(24);
  const url = usePop(44);
  return (
    <Center style={{ flexDirection: "column", gap: 36 * u, textAlign: "center" }}>
      <div style={{ display: "flex", flexDirection: tall ? "column" : "row", alignItems: "center", gap: 34 * u }}>
        <div style={{ ...icon.style, filter: `drop-shadow(0 ${20 * u}px ${30 * u}px rgb(99 67 224 / 0.4))` }}>
          <Mark size={170 * u} />
        </div>
        <div style={{ ...word.style, fontFamily: sans, fontWeight: 600, fontSize: 150 * u, letterSpacing: -5.2 * u, color: C.ink, whiteSpace: "nowrap" }}>RelayMesh</div>
      </div>
      <div style={{ ...line.style, fontFamily: sans, fontWeight: 500, fontSize: (wide ? 60 : 54) * u, letterSpacing: -1.6 * u, color: C.ink, whiteSpace: "nowrap" }}>
        Cross-chain transfers <Accent>you can prove.</Accent>
      </div>
      <div style={{ ...url.style, display: "flex", flexDirection: tall ? "column" : "row", alignItems: "center", gap: 18 * u, marginTop: 14 * u }}>
        <Tag u={u} color={C.accent} soft={C.accentSoft} style={{ fontSize: 30 * u, padding: `${12 * u}px ${28 * u}px` }}>
          Built on PortalDot
        </Tag>
        <span style={{ fontFamily: mono, fontSize: 30 * u, color: C.muted, whiteSpace: "nowrap" }}>github.com/Saber1Y/RelayMesh</span>
      </div>
    </Center>
  );
}

// ---------------------------------------------------------------------------

/** A scene with a short fade at each end, so cuts never feel like jumps. */
function Scene({ from, to, children }: { from: number; to: number; children: ReactNode }) {
  return (
    <Sequence from={from} durationInFrames={to - from} layout="none">
      <FadeEdges length={to - from}>{children}</FadeEdges>
    </Sequence>
  );
}

function FadeEdges({ length, children }: { length: number; children: ReactNode }) {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 6, length - 6, length], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // A slow drift so nothing sits perfectly still.
  const scale = interpolate(frame, [0, length], [1, 1.015]);
  return <AbsoluteFill style={{ opacity, transform: `scale(${scale})` }}>{children}</AbsoluteFill>;
}

export function Intro({ withVoiceover = true }: { withVoiceover?: boolean }) {
  return (
    <AbsoluteFill style={{ background: C.canvas, overflow: "hidden" }}>
      <Backdrop />
      <Scene {...SCENES.blackbox}>
        <SceneBlackBox />
      </Scene>
      <Scene {...SCENES.hope}>
        <SceneHope />
      </Scene>
      <Scene {...SCENES.reveal}>
        <SceneReveal />
      </Scene>
      <Scene {...SCENES.quote}>
        <SceneQuote />
      </Scene>
      <Scene {...SCENES.timeline}>
        <SceneTimeline />
      </Scene>
      <Scene {...SCENES.receipt}>
        <SceneReceipt />
      </Scene>
      <Scene {...SCENES.bridge}>
        <SceneBridge />
      </Scene>
      <Scene {...SCENES.api}>
        <SceneApi />
      </Scene>
      <Scene {...SCENES.logo}>
        <SceneLogo />
      </Scene>
      {withVoiceover &&
        Object.values(SCENES).map(({ vo }) => (
          <Sequence key={vo.id} from={vo.at} layout="none">
            <Audio src={staticFile(`voiceover/${vo.id}.wav`)} />
          </Sequence>
        ))}
    </AbsoluteFill>
  );
}
