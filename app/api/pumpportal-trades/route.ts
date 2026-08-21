import { NextRequest, NextResponse } from "next/server";
import { pumpPortalRelay } from "./relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_MINTS_PER_STREAM = 96;
const STREAM_LIFETIME_MS = 285_000;
const HEARTBEAT_MS = 15_000;
const MAX_ACTIVE_STREAMS = 128;
// Replacing the browser's shared mint subscription briefly overlaps the old
// and new SSE requests. Vercel can also take a heartbeat to observe a closed
// downstream request, so a low per-IP cap falsely locked out active users
// during bursts of migrations. The global and start-rate limits still bound
// total usage while this larger allowance absorbs those short-lived leases.
const MAX_STREAMS_PER_IP = 32;
const MAX_STARTS_PER_MINUTE = 120;
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

function persistentRelayConfigured() {
  return Boolean(process.env.PUMPPORTAL_RELAY_URL?.trim() && process.env.PUMPPORTAL_RELAY_SECRET?.trim());
}

function requestMints(request: NextRequest) {
  const mints = [...new Set(request.nextUrl.searchParams.getAll("mint"))];
  if (mints.length === 0 || mints.length > MAX_MINTS_PER_STREAM || mints.some((mint) => !MINT_PATTERN.test(mint))) return null;
  return mints;
}

async function openPersistentRelay(request: NextRequest, mints: string[], releaseStream: () => void) {
  const relayUrl = process.env.PUMPPORTAL_RELAY_URL?.trim();
  const relaySecret = process.env.PUMPPORTAL_RELAY_SECRET?.trim();
  if (!relayUrl || !relaySecret) return null;

  try {
    const upstreamUrl = new URL("/trades", relayUrl);
    mints.forEach((mint) => upstreamUrl.searchParams.append("mint", mint));
    const upstream = await fetch(upstreamUrl, {
      headers: { authorization: `Bearer ${relaySecret}` },
      cache: "no-store",
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      return null;
    }

    const reader = upstream.body.getReader();
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      releaseStream();
      void reader.cancel().catch(() => undefined);
    };
    request.signal.addEventListener("abort", finish, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            finish();
            controller.close();
            return;
          }
          controller.enqueue(result.value);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      cancel() {
        finish();
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
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const mints = requestMints(request);
  if (!mints) return NextResponse.json({ error: "Invalid token list" }, { status: 400 });
  if (!sameSiteRequest(request)) return NextResponse.json({ error: "Cross-site access is not allowed" }, { status: 403 });
  if (!persistentRelayConfigured() && !process.env.PUMPPORTAL_API_KEY?.trim()) return NextResponse.json({ error: "Live trade feed is unavailable" }, { status: 503 });

  const releaseStream = reserveStream(requestIp(request));
  if (!releaseStream) return NextResponse.json({ error: "Live trade feed is busy; backup polling remains active" }, { status: 429 });

  const persistentRelay = await openPersistentRelay(request, mints, releaseStream);
  if (persistentRelay) return persistentRelay;
  if (!process.env.PUMPPORTAL_API_KEY?.trim()) {
    releaseStream();
    return NextResponse.json({ error: "Persistent live trade relay is unavailable; backup polling remains active" }, { status: 503 });
  }

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
      const unsubscribers: Array<() => void> = [];
      try {
        mints.forEach((mint) => unsubscribers.push(pumpPortalRelay.subscribe(mint, (frame) => write(`data: ${JSON.stringify(frame)}\n\n`))));
        unsubscribe = () => unsubscribers.forEach((stop) => stop());
      } catch {
        unsubscribers.forEach((stop) => stop());
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
