"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { apiCall } from "@/lib/api";
import { isDemo } from "@/lib/supabase";
import { demoCallDetail } from "@/lib/data";

export default function CallDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any>(isDemo ? demoCallDetail : null);
  const [loading, setLoading] = useState(!isDemo);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    apiCall(`/agent/calls/${id}`).then(setData).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <div className="banner banner-error">{error}</div>;
  if (!data) return null;

  const { call } = data;
  const transcript = data.transcript ?? [];   // never let a missing list white-screen the page

  return (
    <div>
      <Link href="/calls" className="hint">← Calls</Link>
      <h1 className="page-title" style={{ marginTop: 8 }}>{call.customers?.full_name ?? "Call"}</h1>
      <p className="page-sub">
        {call.outcome?.replace(/_/g, " ")} · {new Date(call.created_at).toLocaleString()}
        {call.duration_sec ? ` · ${Math.floor(call.duration_sec / 60)}m ${call.duration_sec % 60}s` : ""}
      </p>
      {isDemo && <div className="banner banner-warn" style={{ marginBottom: 16 }}>Demo data — no audio in demo mode.</div>}

      <div className="card card-pad">
        <div className="row-between" style={{ marginBottom: 10 }}>
          <div className="section-label" style={{ marginBottom: 0 }}>Recording</div>
          {call.recording_url && (
            <a href={call.recording_url} download className="hint"
              style={{ color: "var(--accent-deep)", fontWeight: 600 }}>Download</a>
          )}
        </div>
        {call.recording_url
          ? <AudioPlayer src={call.recording_url} duration={call.duration_sec ?? 0} />
          : <div className="muted hint">No recording available.</div>}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-pad section-label" style={{ marginBottom: 0 }}>Transcript</div>
        <div className="thread">
          {transcript.length === 0 && <div className="muted hint">No transcript.</div>}
          {transcript.map((t: any, i: number) => (
            <div key={i} className={`bubble bubble-${t.role === "ai" ? "ai" : t.role === "customer" ? "customer" : "system"}`}>
              {t.content}
              {t.ts && <time>{new Date(t.ts).toLocaleTimeString()}</time>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


/**
 * Recording player with a waveform scrubber.
 *
 * The waveform is decoded from the actual audio, not faked — a decorative shape that doesn't match
 * the sound is worse than none, because you'd scrub to a peak and hear silence. Decoding is
 * progressive: controls work immediately and the bars fill in when the buffer arrives.
 */
function AudioPlayer({ src, duration }: { src: string; duration: number }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [len, setLen] = useState(duration);
  const [rate, setRate] = useState(1);
  const [peaks, setPeaks] = useState<{ agent: number[]; customer: number[] | null } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer();
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const audio = await ctx.decodeAudioData(buf);
        const N = 200;
        const envelope = (ch: Float32Array) => {
          const block = Math.floor(ch.length / N), out: number[] = [];
          for (let i = 0; i < N; i++) {
            let sum = 0;
            for (let j = 0; j < block; j++) sum += Math.abs(ch[i * block + j] || 0);
            out.push(sum / block);
          }
          return out;
        };
        // Vapi's stereo mix puts the assistant on channel 0 and the caller on channel 1.
        const agentRaw = envelope(audio.getChannelData(0));
        const custRaw = audio.numberOfChannels > 1 ? envelope(audio.getChannelData(1)) : null;
        // Normalize both against the SAME peak, otherwise a quiet speaker looks as loud as a
        // shouting one and the comparison is meaningless.
        const max = Math.max(...agentRaw, ...(custRaw ?? []), 0.0001);
        if (!cancelled) {
          setPeaks({ agent: agentRaw.map((v) => v / max), customer: custRaw?.map((v) => v / max) ?? null });
          setLen(audio.duration);
        }
        ctx.close();
      } catch { if (!cancelled) setFailed(true); }   // fall back to a plain progress bar
    })();
    return () => { cancelled = true; };
  }, [src]);

  const pct = len ? Math.min(1, t / len) : 0;

  function toggle() {
    const a = audioRef.current; if (!a) return;
    if (a.paused) { a.play(); setPlaying(true); } else { a.pause(); setPlaying(false); }
  }
  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const a = audioRef.current; if (!a || !len) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * len;
    setT(a.currentTime);
  }
  function cycleRate() {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  return (
    <div>
      <audio ref={audioRef} src={src} preload="metadata"
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => { if (isFinite(e.currentTarget.duration)) setLen(e.currentTarget.duration); }}
        onEnded={() => { setPlaying(false); setT(0); }} />

      <div onClick={seek} style={{
        cursor: "pointer", padding: "10px 8px", background: "var(--bg)",
        borderRadius: "var(--radius)", position: "relative",
      }}>
        <Track bars={peaks?.agent ?? null} pct={pct} color="var(--hot)" label="Agent" />
        {peaks?.customer && (
          <Track bars={peaks.customer} pct={pct} color="var(--accent)" label="Caller" />
        )}
        {/* Playhead spans both tracks so the two are read as one timeline. */}
        <div style={{
          position: "absolute", top: 6, bottom: 6, left: `calc(8px + ${pct * 100}% * 0.985)`,
          width: 1.5, background: "var(--ink)", opacity: 0.55, pointerEvents: "none",
        }} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        <button onClick={toggle} aria-label={playing ? "Pause" : "Play"} style={{
          width: 38, height: 38, borderRadius: "50%", border: "none", cursor: "pointer",
          background: "var(--accent)", color: "#fff", fontSize: 14, lineHeight: 1,
          display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        }}>{playing ? "❚❚" : "▶"}</button>

        <button onClick={cycleRate} className="btn" style={{ padding: "6px 12px" }}>{rate}x</button>

        <span className="hint" style={{ fontVariantNumeric: "tabular-nums" }}>
          {fmtT(t)} / {fmtT(len)}
        </span>
        {failed && <span className="hint">Waveform unavailable — playback still works.</span>}
      </div>
    </div>
  );
}

/** One speaker's waveform. Played bars are solid; the rest are ghosted. */
function Track({ bars, pct, color, label }:
  { bars: number[] | null; pct: number; color: string; label: string }) {
  const data = bars ?? Array.from({ length: 200 }, () => 0.08);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="hint" style={{ width: 46, fontSize: 11, color, fontWeight: 700, flexShrink: 0 }}>
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 1, height: 34, flex: 1 }}>
        {data.map((v, i) => (
          <div key={i} style={{
            flex: 1,
            height: `${Math.max(2, v * 100)}%`,
            borderRadius: 1,
            background: color,
            opacity: i / data.length <= pct ? 1 : 0.22,
          }} />
        ))}
      </div>
    </div>
  );
}

const fmtT = (s: number) =>
  `${Math.floor((s || 0) / 60)}:${String(Math.floor(s || 0) % 60).padStart(2, "0")}`;
