import { prisma } from "../../prisma/client.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import * as referralService from "../referrals/referralService.js";
import {
  normalizeBackupHashesArray,
  tryConsumeBackupCode,
  verifyTotpToken,
} from "./twoFactorHelpers.js";
import { getClientIp } from "./clientIp.js";
import { createUserSession } from "./sessionService.js";
import { detectCountryPrefixFromRequest } from "./geoIpCountryPrefix.js";

export { getClientIp } from "./clientIp.js";

const DEFAULT_SUBSCRIBER_START = (() => {
  const n = Number(process.env.SUBSCRIBER_ID_START);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 691000001;
})();

/**
 * Next GTN subscriber number from Counter (row id=1). Creates the row if the table was never seeded.
 */
async function allocateSubscriberId() {
  return prisma.$transaction(async (tx) => {
    let counter = await tx.counter.findUnique({ where: { id: 1 } });
    if (!counter) {
      counter = await tx.counter.create({
        data: { id: 1, nextId: DEFAULT_SUBSCRIBER_START },
      });
    }
    const subscriberId = counter.nextId;
    await tx.counter.update({
      where: { id: counter.id },
      data: { nextId: counter.nextId + 1 },
    });
    return subscriberId;
  });
}

export function normalizePhoneE164(input) {
  let s = String(input || "").trim().replace(/\s/g, "");
  if (!s) throw new Error("Phone is required");
  if (!s.startsWith("+")) s = `+${s.replace(/^\+/, "")}`;
  return s.slice(0, 20);
}

/**
 * Create DB user (password hashed). Phone may be generated if missing.
 */
export async function createUserAccount(
  { name, email, phone, password, signupDeviceKey, signupIpHash },
  req
) {
  const hashedPassword = await bcrypt.hash(password, 10);

  const subscriberId = await allocateSubscriberId();
  let finalPhone = phone ? normalizePhoneE164(phone) : null;

  if (!finalPhone) {
    const countryPrefix = req ? await detectCountryPrefixFromRequest(req) : "+256";
    finalPhone = `${countryPrefix}${subscriberId}`;
  }

  const user = await prisma.user.create({
    data: {
      name,
      email: email ? String(email).trim().toLowerCase() : null,
      phone: finalPhone,
      subscriberId,
      password: hashedPassword,
      signupDeviceKey: signupDeviceKey ? String(signupDeviceKey).slice(0, 128) : null,
      signupIpHash: signupIpHash || null,
    },
  });
  return user;
}

/**
 * Verify OTP and complete registration (returns user + JWT).
 * Optional `ref` = referrer's subscriberId (from invite link).
 */
export async function completeRegistration(
  {
    name,
    email,
    password,
    ref,
    deviceKey,
    referralSource,
    referralSourceMeta,
    referralClickedAt,
  },
  req
) {
  const cleanName = String(name || "").trim();
  const cleanEmail = String(email || "").trim().toLowerCase();

  if (!cleanName) throw new Error("Name is required");
  if (!cleanEmail) throw new Error("Email is required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error("Invalid email address");
  }
  if (!password || String(password).length < 6) throw new Error("Password must be at least 6 characters");

  const exists = await prisma.user.findUnique({ where: { email: cleanEmail } });
  if (exists) throw new Error("This email is already registered");

  const signupIpHash = referralService.hashIp(getClientIp(req));

  const user = await createUserAccount(
    {
      name: cleanName,
      email: cleanEmail,
      phone: null,
      password,
      signupDeviceKey: deviceKey,
      signupIpHash,
    },
    req
  );

  if (ref != null && String(ref).trim() !== "") {
    try {
      let clickedAt = null;
      if (referralClickedAt) {
        const d = new Date(referralClickedAt);
        if (!Number.isNaN(d.getTime())) clickedAt = d;
      }
      await referralService.recordSignupReferral(ref, user, {
        source: referralSource,
        sourceMeta: referralSourceMeta,
        deviceKey,
        signupIpHash,
        clickedAt,
      });
    } catch (e) {
      console.warn("[GTN] Referral not recorded:", e?.message || e);
    }
  }

  const jti = await createUserSession(user, req);
  const token = signAuthToken(user, jti);
  return { user: sanitizeAuthUser(user), token };
}

/** @param {import("@prisma/client").User} user @param {string} jti */
export function signAuthToken(user, jti) {
  const tv = user.tokenVersion ?? 0;
  const jid = String(jti || "").trim();
  if (!jid) throw new Error("Session id missing");
  return jwt.sign({ id: user.id, tv, jti: jid }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

/** Short-lived token after password OK; exchange for session JWT via POST /auth/login/2fa. */
export function signTwoFactorPendingToken(user) {
  const tv = user.tokenVersion ?? 0;
  return jwt.sign(
    { id: user.id, purpose: "2fa_login", tv },
    process.env.JWT_SECRET,
    { expiresIn: "10m" }
  );
}

/** Strip secrets before returning user to client. */
export function sanitizeAuthUser(user) {
  if (!user) return user;
  const {
    password: _p,
    twoFactorSecret: _ts,
    twoFactorPendingSecret: _tp,
    twoFactorBackupHashes: _tb,
    ...safe
  } = user;
  return safe;
}

export async function login({ email, password }, req) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: cleanEmail } });
  if (!user) throw new Error("User not found");

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw new Error("Invalid password");

  if (user.twoFactorEnabled && user.twoFactorSecret) {
    return {
      twoFactorRequired: true,
      twoFactorToken: signTwoFactorPendingToken(user),
    };
  }

  const jti = await createUserSession(user, req);
  const token = signAuthToken(user, jti);
  return { user: sanitizeAuthUser(user), token };
}

/**
 * Complete login after TOTP or backup code.
 * @param {{ twoFactorToken: string, code: string }} input
 */
export async function completeTwoFactorLogin({ twoFactorToken, code }, req) {
  let decoded;
  try {
    decoded = jwt.verify(String(twoFactorToken || ""), process.env.JWT_SECRET);
  } catch {
    throw new Error("Verification expired. Sign in again.");
  }
  if (decoded.purpose !== "2fa_login" || decoded.id == null) {
    throw new Error("Invalid verification step.");
  }

  const user = await prisma.user.findUnique({ where: { id: Number(decoded.id) } });
  if (!user) throw new Error("User not found");
  if (Number(decoded.tv ?? 0) !== (user.tokenVersion ?? 0)) {
    throw new Error("Session revoked. Sign in again.");
  }
  if (!user.twoFactorEnabled || !user.twoFactorSecret) {
    throw new Error("Two-factor sign-in is not active for this account.");
  }

  const totpOk = await verifyTotpToken(user.twoFactorSecret, code);
  if (totpOk) {
    const jti = await createUserSession(user, req);
    const token = signAuthToken(user, jti);
    return { user: sanitizeAuthUser(user), token };
  }

  const hashes = normalizeBackupHashesArray(user.twoFactorBackupHashes);
  const consumed = await tryConsumeBackupCode(hashes, code);
  if (!consumed.ok) {
    throw new Error("Invalid authenticator or backup code.");
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorBackupHashes: consumed.remaining },
  });

  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  const u = fresh || user;
  const jti = await createUserSession(u, req);
  const token = signAuthToken(u, jti);
  return { user: sanitizeAuthUser(u), token };
}
