import { detectCountryPrefixFromRequest } from "../auth/geoIpCountryPrefix.js";

/**
 * Get an E.164-ish phone identity for the current user.
 * If the account has no explicit phone, we fall back to +<geoCallingCode><subscriberId>.
 * @param {import("express").Request} req
 */
export async function getUserPhoneIdentity(req) {
  const u = req.user;
  if (!u) return null;
  if (u.phone) return String(u.phone);
  if (!u.subscriberId) return null;
  const prefix = await detectCountryPrefixFromRequest(req);
  return `${prefix}${u.subscriberId}`;
}

