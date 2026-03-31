import { getClientIp } from "./clientIp.js";

function shouldSkipGeoIpLookup(reqIp) {
  const ip = String(reqIp || "").trim();
  if (!ip) return true;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
  // Typical private / local ranges — no reliable public geo; default dial prefix.
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
  if (ip.startsWith("fe80:") || ip.startsWith("::ffff:127.")) return true;
  return false;
}

/**
 * Best-effort calling-code prefix from request IP.
 * Defaults to +256 when IP is private/unknown/unavailable.
 * @param {import("express").Request} req
 */
export async function detectCountryPrefixFromRequest(req) {
  const ip = getClientIp(req);
  if (shouldSkipGeoIpLookup(ip)) return "+256";

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3500);
  try {
    const endpoint = `https://ipapi.co/${encodeURIComponent(String(ip))}/json/`;
    const r = await fetch(endpoint, {
      headers: { "User-Agent": "GTN-backend" },
      signal: ctrl.signal,
    });
    if (!r.ok) return "+256";
    const data = await r.json();
    const callingCode = data.calling_code || data.callingCode;
    if (!callingCode) return "+256";
    const s = String(callingCode).trim();
    if (s.startsWith("+")) return s;
    if (/^\d+$/.test(s)) return `+${s}`;
    return "+256";
  } catch {
    return "+256";
  } finally {
    clearTimeout(t);
  }
}

