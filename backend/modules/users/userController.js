import * as userService from "./userService.js";
import { localeFromPhone } from "./localeFromPhone.js";
import * as messagingService from "../messages/messagingService.js";
import * as referralService from "../referrals/referralService.js";
import { prisma } from "../../prisma/client.js";
import { isUnlimitedActive } from "../plans/plansService.js";
import {
  deepMergePreferences,
  patchMeBodySchema,
  preferencesFromDb,
} from "./userPreferencesSchema.js";
import { changePasswordBodySchema, deleteAccountBodySchema } from "./userAccountSchemas.js";
import { changeUserPassword, deleteUserAccount } from "./userAccountService.js";
import * as userBlockService from "./userBlockService.js";
import { assert2faForSensitiveAction, loadUserForSensitive2fa } from "../auth/sensitiveAction2fa.js";
import { getUserPhoneIdentity } from "./userPhoneIdentity.js";
import {
  listActiveSessionsForUser,
  revokeAllUserSessions,
  revokeUserSessionById,
} from "../auth/sessionService.js";

export async function getUser(req, res) {
  try {
    const user = await userService.getUserById(parseInt(req.params.id));
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function listUsers(req, res) {
  try {
    const users = await userService.getAllUsers();
    res.json(users);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

/** GET /users/contacts/search?q= — find peers by phone (E.164) or subscriber ID */
export async function searchContacts(req, res) {
  try {
    const q = req.query.q;
    const results = await userService.searchContactsForUser(q, req.user.id);
    res.json(results);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

/** POST /users/contacts/match — which saved contacts are already on GTN */
export async function matchContacts(req, res) {
  try {
    const body = req.body || {};
    let entries = body.contacts;
    if (!Array.isArray(entries) && Array.isArray(body.phones)) {
      entries = body.phones.map((p) => ({ phone: p }));
    }
    if (!Array.isArray(entries)) {
      return res.status(400).json({ error: "Expected contacts: [{ phone, name? }] or phones: []" });
    }
    const result = await userService.matchContactsForUser(entries, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

/**
 * Shared payload for GET /users/me and PATCH /users/me (same shape for client hydration).
 * @param {import("@prisma/client").User} dbUser
 */
async function buildMePayload(dbUser) {
  await referralService.ensureDailyFreeMinutes(dbUser.id);
  const fresh = await prisma.user.findUnique({ where: { id: dbUser.id } });
  const u = fresh || dbUser;

  const phoneId = u.phone || (u.subscriberId ? `+256${u.subscriberId}` : null);
  const region = localeFromPhone(phoneId);
  const hasChats = await messagingService.userHasPeerChats(u.id);
  const planId = u.currentPlanId || "free";
  const planUnlimited = isUnlimitedActive(u);
  const planExpiryIso = u.planExpiry ? u.planExpiry.toISOString() : null;
  const planName =
    planId === "free"
      ? "Free Plan"
      : planId === "daily"
        ? "Daily Unlimited"
        : planId === "weekly"
          ? "Weekly Unlimited"
          : planId === "monthly"
            ? "Monthly Unlimited"
            : "Plan";

  return {
    id: phoneId,
    dbId: u.id,
    username: u.name,
    email: u.email ?? null,
    twoFactorEnabled: Boolean(u.twoFactorEnabled),
    subscriberId: u.subscriberId,
    phone: phoneId,
    preferences: preferencesFromDb(u.preferences),
    freeMinutes: u.freeMinutes ?? 0,
    referralCode: String(u.subscriberId),
    countryIso: region.countryIso,
    countryPrefix: region.countryPrefix,
    currencyCode: region.currencyCode,
    currencySymbol: region.currencySymbol,
    hasChats,
    planId,
    planName,
    planUnlimited,
    planExpiry: planExpiryIso,
  };
}

export async function getMe(req, res) {
  try {
    const user = req.user;
    const fallbackPhone = await getUserPhoneIdentity(req);
    const json = await buildMePayload({ ...user, phone: user.phone || fallbackPhone });
    res.json(json);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

/**
 * PATCH /users/me — partial update: name, bio, preferences (validated + deep-merge).
 */
export async function patchMe(req, res) {
  try {
    const parsed = patchMeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "validation_failed",
        details: parsed.error.flatten(),
      });
    }
    const { name, bio, preferences: prefPatch } = parsed.data;
    if (name === undefined && bio === undefined && prefPatch === undefined) {
      return res.status(400).json({
        error: "empty_patch",
        message: "Send at least one of: name, bio, preferences",
      });
    }

    const fresh = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!fresh) return res.status(404).json({ error: "User not found" });

    /** @type {import("@prisma/client").Prisma.UserUpdateInput} */
    const data = {};
    if (name !== undefined) data.name = name;
    if (bio !== undefined) data.bio = bio === "" ? null : bio;
    if (prefPatch !== undefined) {
      const existing = preferencesFromDb(fresh.preferences);
      data.preferences = deepMergePreferences(existing, prefPatch);
    }

    await prisma.user.update({
      where: { id: req.user.id },
      data,
    });

    const fallbackPhone = await getUserPhoneIdentity(req);
    const json = await buildMePayload({ ...fresh, phone: fresh.phone || fallbackPhone });
    res.json(json);
  } catch (err) {
    res.status(400).json({ error: err.message || "patch_failed" });
  }
}

/**
 * POST /users/me/password — verify current password, set new hash, increment tokenVersion (re-auth everywhere).
 */
export async function changePassword(req, res) {
  try {
    const parsed = changePasswordBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "validation_failed",
        details: parsed.error.flatten(),
      });
    }
    const { currentPassword, newPassword, twoFactorCode } = parsed.data;
    if (currentPassword === newPassword) {
      return res.status(400).json({
        error: "New password must be different from your current password",
      });
    }
    const for2fa = await loadUserForSensitive2fa(req.user.id);
    await assert2faForSensitiveAction(for2fa, twoFactorCode);
    await changeUserPassword(req.user.id, currentPassword, newPassword);
    res.json({ ok: true, sessionEnded: true });
  } catch (err) {
    const msg = err?.message || "password_change_failed";
    if (String(msg).toLowerCase().includes("incorrect")) {
      return res.status(401).json({ error: msg });
    }
    res.status(400).json({ error: msg });
  }
}

/**
 * POST /users/me/delete — password-gated hard delete (messages, audit rows, then user + cascades).
 */
export async function deleteAccount(req, res) {
  try {
    const parsed = deleteAccountBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: "validation_failed",
        details: parsed.error.flatten(),
      });
    }
    const for2fa = await loadUserForSensitive2fa(req.user.id);
    await assert2faForSensitiveAction(for2fa, parsed.data.twoFactorCode);
    await deleteUserAccount(req.user.id, parsed.data.password);
    res.json({ ok: true });
  } catch (err) {
    const msg = err?.message || "delete_failed";
    if (String(msg).toLowerCase().includes("incorrect")) {
      return res.status(401).json({ error: msg });
    }
    res.status(400).json({ error: msg });
  }
}

/** POST /users/me/logout-all-devices — bump tokenVersion; all JWTs (this device included) stop working */
export async function logoutAllDevices(req, res) {
  try {
    const code = typeof req.body?.twoFactorCode === "string" ? req.body.twoFactorCode : undefined;
    const for2fa = await loadUserForSensitive2fa(req.user.id);
    await assert2faForSensitiveAction(for2fa, code);
    await revokeAllUserSessions(req.user.id);
    await prisma.user.update({
      where: { id: req.user.id },
      data: { tokenVersion: { increment: 1 } },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || "logout_all_failed" });
  }
}

/** GET /users/me/sessions — active login sessions for this account */
export async function getMySessions(req, res) {
  try {
    const rows = await listActiveSessionsForUser(req.user.id);
    const currentJti = req.tokenJti || null;
    res.json(
      rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        userAgent: r.userAgent,
        ipHint: r.ipHash ? `${String(r.ipHash).slice(0, 6)}…` : null,
        isCurrent: currentJti != null && r.jti === currentJti,
      }))
    );
  } catch (err) {
    res.status(400).json({ message: err.message || "list_sessions_failed" });
  }
}

/** DELETE /users/me/sessions/:sessionId — revoke one session (may be this device) */
export async function deleteMySession(req, res) {
  try {
    const sessionId = String(req.params.sessionId || "").trim();
    if (!sessionId) {
      return res.status(400).json({ message: "sessionId required" });
    }
    await revokeUserSessionById(req.user.id, sessionId);
    res.json({ ok: true });
  } catch (err) {
    if (String(err?.message || "").includes("not found")) {
      return res.status(404).json({ message: err.message });
    }
    res.status(400).json({ message: err.message || "revoke_session_failed" });
  }
}

/** GET /users/me/blocks — users I have blocked */
export async function getMyBlocks(req, res) {
  try {
    const rows = await userBlockService.listMyBlocks(req.user.id);
    res.json(
      rows.map((r) => ({
        blockedId: r.blocked.id,
        name: r.blocked.name,
        phone: r.blocked.phone,
        subscriberId: r.blocked.subscriberId,
        blockedAt: r.createdAt.toISOString(),
      }))
    );
  } catch (err) {
    res.status(400).json({ message: err.message || "list_blocks_failed" });
  }
}

/** POST /users/me/blocks — body: { blockedId: number } */
export async function postMyBlock(req, res) {
  try {
    const blockedId = parseInt(req.body?.blockedId, 10);
    if (!blockedId || Number.isNaN(blockedId)) {
      return res.status(400).json({ message: "blockedId required" });
    }
    const row = await userBlockService.createBlock(req.user.id, blockedId);
    res.json({
      blockedId: row.blocked.id,
      name: row.blocked.name,
      phone: row.blocked.phone,
      subscriberId: row.blocked.subscriberId,
      blockedAt: row.createdAt.toISOString(),
    });
  } catch (err) {
    res.status(400).json({ message: err.message || "block_failed" });
  }
}

/** POST /users/me/push-token — body: { token: string, platform?: string } (FCM token from native app) */
export async function postMyPushToken(req, res) {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token || token.length < 20) {
      return res.status(400).json({ message: "token required" });
    }
    const platform = String(req.body?.platform || "android").toLowerCase().slice(0, 16);
    await prisma.pushDevice.upsert({
      where: { token },
      create: {
        userId: req.user.id,
        token,
        platform,
      },
      update: {
        userId: req.user.id,
        platform,
      },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ message: err.message || "push_token_failed" });
  }
}

/** DELETE /users/me/push-token — body: { token: string } */
export async function deleteMyPushToken(req, res) {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) {
      return res.status(400).json({ message: "token required" });
    }
    await prisma.pushDevice.deleteMany({
      where: { userId: req.user.id, token },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ message: err.message || "push_token_delete_failed" });
  }
}

/** DELETE /users/me/blocks/:blockedId */
export async function deleteMyBlock(req, res) {
  try {
    const blockedId = parseInt(req.params.blockedId, 10);
    if (!blockedId || Number.isNaN(blockedId)) {
      return res.status(400).json({ message: "blockedId required" });
    }
    await userBlockService.deleteBlock(req.user.id, blockedId);
    res.json({ ok: true });
  } catch (err) {
    if (err?.message === "Not blocked.") {
      return res.status(404).json({ message: err.message });
    }
    res.status(400).json({ message: err.message || "unblock_failed" });
  }
}