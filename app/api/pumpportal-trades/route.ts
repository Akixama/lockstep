import { NextRequest, NextResponse } from "next/server";
import { pumpPortalRelay } from "./relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const STREAM_LIFETIME_MS = 285_000;
const HEARTBEAT_MS = 15_000;
const MAX_ACTIVE_STREAMS = 128;
const MAX_STREAMS_PER_IP = 8;
const MAX_STARTS_PER_MINUTE = 24;
const MAX_TRACKED_IPS = 2_048;

type IpUsage = { active: number; starts: number[] };

declare global {
  var lockstepPumpPortalUsage: Map<string, IpUsage> | undefined;
  var lockstepPumpPortalActiveStreams: number | undefined;
}

const usageByIp = globalThis.lockstepPumpPortalUsage ?? new Map<string, IpUsage>();
globalThis.lockstepPumpPortalUsage = usageByIp;

function requestIp(request: NextRequest) {
  return (request.headers.get("x-forwarded-for")?.split(",")[0] || request.headers.get("x-real-ip") || "unknown").trim().slice(0, 80);
}

function sameSiteRequest(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "same-site";
}

function reserveStream(ip: string) {
  const now = Date.now();
  if (!usageByIp.has(ip) && usageByIp.size >= MAX_TRACKED_IPS) {
    usageByIp.forEach((usage, trackedIp) => {
      if (usage.active === 0 && usage.starts.every((startedAt) => now - startedAt >= 60_000)) usageByIp.delete(trackedIp);
    });
    if (usageByIp.size >= MAX_TRACKED_IPS) return null;
  }
  const usage = usageByIp.get(ip) ?? { active: 0, starts: [] };
  usage.starts = usage.starts.filter((startedAt) => now - startedAt < 60_000);
  const activeStreams = globalThis.lockstepPumpPortalActiveStreams ?? 0;
  if (activeStreams >= MAX_ACTIVE_STREAMS || usage.active >= MAX_STREAMS_PER_IP || usage.starts.length >= MAX_STARTS_PER_MINUTE) return null;
  usage.active += 1;
  usage.starts.push(now);
  usageByIp.set(ip, usage);
  globalThis.lockstepPumpPortalActiveStreams = activeStreams + 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    usage.active = Math.max(0, usage.active - 1);
    globalThis.lockstepPumpPortalActiveStreams = Math.max(0, (globalThis.lockstepPumpPortalActiveStreams ?? 1) - 1);
    if (usage.active === 0 && usage.starts.every((startedAt) => Date.now() - startedAt >= 60_000)) usageByIp.delete(ip);
  };
}

export async function GET(request: NextRequest) {
  const mint = request.nextUrl.searchParams.get("mint") ?? "";
  if (!MINT_PATTERN.test(mint)) return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  if (!sameSiteRequest(request)) return NextResponse.json({ error: "Cross-site access is not allowed" }, { status: 403 });
  if (!process.env.PUMPPORTAL_API_KEY?.trim()) return NextResponse.json({ error: "Live trade feed is unavailable" }, { status: 503 });

  const releaseStream = reserveStream(requestIp(request));
  if (!releaseStream) return NextResponse.json({ error: "Live trade feed is busy; backup polling remains active" }, { status: 429 });

  const encoder = new TextEncoder();
  let cleanup = () => releaseStream();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (value: string) => {
        if (!closed) controller.enqueue(encoder.encode(value));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(expiry);
        unsubscribe();
        releaseStream();
        try { controller.close(); } catch { /* already disconnected */ }
      };
      let unsubscribe: () => void;
      try {
        unsubscribe = pumpPortalRelay.subscribe(mint, (frame) => write(`data: ${JSON.stringify(frame)}\n\n`));
      } catch {
        releaseStream();
        controller.error(new Error("Live trade feed is busy"));
        return;
      }
      const heartbeat = setInterval(() => write(": keepalive\n\n"), HEARTBEAT_MS);
      const expiry = setTimeout(finish, STREAM_LIFETIME_MS);
      request.signal.addEventListener("abort", finish, { once: true });
      write(": connected\n\n");
      cleanup = finish;
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store, no-cache, must-revalidate, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
