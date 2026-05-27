import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageLimitSnapshot } from '../types.js';

// Out-of-band Grok (xAI / SuperGrok) usage fetch, mirroring steipete/codexbar's
// GrokWebBillingFetcher. The xAI billing surface is a Connect/gRPC-web RPC
// (NOT REST, NOT api.x.ai), and there's no generated proto — so, like codexbar,
// we send the empty gRPC-web frame and brute-force-scan the framed protobuf
// response for a percent float + a unix reset timestamp. Everything fails safe
// to null (badge shows "—") so a parse miss never shows garbage.
//
// NOTE: this is a heuristic parser validated against codexbar's algorithm, not a
// live response on every machine — sanity-check the number against grok's own
// usage display after first run.

const GROK_BILLING_URL =
  'https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig';
// 5-byte gRPC-web frame: 1 flags byte + 4-byte big-endian length (0 → empty msg).
const EMPTY_GRPC_FRAME = new Uint8Array([0, 0, 0, 0, 0]);
const GROK_OIDC_PREFIX = 'https://auth.x.ai::';
const GROK_SESSION_SCOPE = 'https://accounts.x.ai/sign-in';

interface GrokCred {
  token: string;
  authMode: string | null;
}

// ~/.grok/auth.json is a MAP keyed by scope URL. Prefer the OIDC (SuperGrok)
// entry, fall back to the legacy session entry, then any entry with a `key`.
function readGrokBearer(): GrokCred | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(readFileSync(join(homedir(), '.grok', 'auth.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const entries = Object.entries(obj) as [string, { key?: unknown; auth_mode?: unknown }][];
  const hasKey = (v: { key?: unknown }) => typeof v?.key === 'string' && v.key.length > 0;
  const pick =
    entries.find(([k, v]) => k.startsWith(GROK_OIDC_PREFIX) && hasKey(v)) ??
    entries.find(([k, v]) => k === GROK_SESSION_SCOPE && hasKey(v)) ??
    entries.find(([, v]) => hasKey(v));
  if (!pick) return null;
  const v = pick[1];
  return {
    token: v.key as string,
    authMode: typeof v.auth_mode === 'string' ? v.auth_mode : null,
  };
}

// codexbar labels the bar by how far out the reset is.
function grokWindowLabel(resetsAt: number | null): string {
  if (resetsAt == null) return 'Usage';
  const days = (resetsAt - Date.now()) / 86_400_000;
  if (days >= 4 && days <= 12) return 'Weekly';
  if (days >= 20 && days <= 45) return 'Monthly';
  return 'Usage';
}

// Read a base-128 varint. Returns [value, nextOffset]; nextOffset = -1 on EOF/overflow.
function readVarint(buf: Uint8Array, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let i = start;
  while (i < buf.length) {
    const b = buf[i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, i];
    shift += 7n;
    if (shift > 70n) return [0n, -1];
  }
  return [0n, -1];
}

interface PercentCandidate {
  percent: number;
  depth: number;
  lastField: number;
}

// Recursively walk a protobuf message, collecting percent candidates (32-bit
// floats / 64-bit doubles in 0..100) tagged with their field number + depth,
// and varints that look like unix-seconds timestamps.
function scanProto(
  buf: Uint8Array,
  depth: number,
  cands: PercentCandidate[],
  resets: number[],
): void {
  let i = 0;
  while (i < buf.length) {
    const [tag, ni] = readVarint(buf, i);
    if (ni < 0) return;
    i = ni;
    const fieldNo = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const [v, nj] = readVarint(buf, i);
      if (nj < 0) return;
      i = nj;
      const num = Number(v);
      if (num > 1_700_000_000 && num < 2_100_000_000) resets.push(num);
    } else if (wire === 1) {
      if (i + 8 > buf.length) return;
      const d = new DataView(buf.buffer, buf.byteOffset + i, 8).getFloat64(0, true);
      if (Number.isFinite(d) && d >= 0 && d <= 100) cands.push({ percent: d, depth, lastField: fieldNo });
      i += 8;
    } else if (wire === 2) {
      const [len, nj] = readVarint(buf, i);
      if (nj < 0) return;
      i = nj;
      const l = Number(len);
      if (i + l > buf.length) return;
      scanProto(buf.subarray(i, i + l), depth + 1, cands, resets);
      i += l;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return;
      const f = new DataView(buf.buffer, buf.byteOffset + i, 4).getFloat32(0, true);
      if (Number.isFinite(f) && f >= 0 && f <= 100) cands.push({ percent: f, depth, lastField: fieldNo });
      i += 4;
    } else {
      return; // unknown wire type — stop scanning this (likely non-proto) chunk
    }
  }
}

// Pull the first non-trailer data frame out of a gRPC-web response and scan it.
function parseGrokBilling(bytes: Uint8Array): { usedPercent: number | null; resetsAt: number | null } | null {
  let off = 0;
  let message: Uint8Array | null = null;
  while (off + 5 <= bytes.length) {
    const flags = bytes[off];
    const len = (bytes[off + 1] << 24) | (bytes[off + 2] << 16) | (bytes[off + 3] << 8) | bytes[off + 4];
    const start = off + 5;
    const end = start + len;
    if (end > bytes.length) break;
    if ((flags & 0x80) === 0) {
      message = bytes.subarray(start, end);
      break;
    }
    off = end; // trailer frame (grpc-status) — skip
  }
  if (!message) return null;

  const cands: PercentCandidate[] = [];
  const resets: number[] = [];
  scanProto(message, 1, cands, resets);

  // usedPercent: prefer the shallowest candidate at field #1; else shallowest overall.
  const byField1 = cands.filter((c) => c.lastField === 1).sort((a, b) => a.depth - b.depth);
  const fallback = [...cands].sort((a, b) => a.depth - b.depth);
  const usedPercent = (byField1[0] ?? fallback[0])?.percent ?? null;

  // resetsAt: earliest future unix-seconds timestamp → ms.
  const nowSec = Date.now() / 1000;
  const future = resets.filter((t) => t > nowSec).sort((a, b) => a - b);
  const resetsAt = future.length ? future[0] * 1000 : null;

  if (usedPercent == null && resetsAt == null) return null;
  return { usedPercent, resetsAt };
}

/**
 * Fetch the current Grok (SuperGrok) usage snapshot from xAI's gRPC-web billing
 * RPC. Returns null silently on missing creds / auth failure / parse miss.
 */
export async function fetchGrokUsage(): Promise<UsageLimitSnapshot | null> {
  const cred = readGrokBearer();
  if (!cred) return null;
  let bytes: Uint8Array;
  try {
    const res = await fetch(GROK_BILLING_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cred.token}`,
        Origin: 'https://grok.com',
        Referer: 'https://grok.com/?_s=usage',
        Accept: '*/*',
        'Content-Type': 'application/grpc-web+proto',
        'x-grpc-web': '1',
        'x-user-agent': 'connect-es/2.1.1',
        'User-Agent': 'MultiTable',
      },
      body: EMPTY_GRPC_FRAME,
    });
    if (!res.ok) return null; // 401/403 → re-login; handled by next poll
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
  const parsed = parseGrokBilling(bytes);
  if (!parsed) return null;
  return {
    status: 'live',
    source: 'grok',
    windows: [
      {
        label: grokWindowLabel(parsed.resetsAt),
        usedPercent: parsed.usedPercent != null ? Math.round(parsed.usedPercent) : 0,
        resetsAt: parsed.resetsAt,
      },
    ],
    planType: cred.authMode === 'oidc' ? 'SuperGrok' : null,
    capturedAt: Date.now(),
  };
}
