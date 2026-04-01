import { prisma } from "../../prisma/client.js";
import { normalizePhoneE164 } from "../auth/authService.js";
import { getFirebaseMessaging } from "./firebaseAdmin.js";

function isInitialOffer(signal) {
  return signal && typeof signal === "object" && signal.type === "offer";
}

/**
 * Resolve DB user id for push when only phone routing key is known.
 * @param {string} phoneKey
 * @returns {Promise<number | null>}
 */
export async function resolveUserIdByPhoneKey(phoneKey) {
  if (!phoneKey) return null;
  try {
    const phone = normalizePhoneE164(String(phoneKey));
    const u = await prisma.user.findFirst({
      where: { phone },
      select: { id: true },
    });
    return u?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {number | typeof NaN} toDbId from request
 * @param {string} phoneKey normalized routing key (E.164)
 * @returns {Promise<number | null>}
 */
export async function resolveReceiverUserIdForPush(toDbId, phoneKey) {
  if (Number.isFinite(toDbId) && toDbId > 0) return toDbId;
  return resolveUserIdByPhoneKey(phoneKey);
}

/**
 * Notify callee devices via FCM (initial offer only — avoids spam on ICE trickle).
 * @param {number} receiverUserId
 * @param {{ fromUserId: string, fromUserDbId: number | null, callId: unknown, signal: unknown }} payload
 */
export async function sendIncomingCallPushIfOffer(receiverUserId, payload) {
  if (!receiverUserId || !isInitialOffer(payload?.signal)) return;
  const messaging = getFirebaseMessaging();
  if (!messaging) return;

  const devices = await prisma.pushDevice.findMany({
    where: { userId: receiverUserId },
    select: { token: true },
  });
  const tokens = devices.map((d) => d.token).filter(Boolean);
  if (!tokens.length) return;

  const fromLabel = String(payload.fromUserId ?? "Unknown").slice(0, 80);
  const title = "Incoming call";
  const body = `From ${fromLabel}`;
  const data = {
    gtnType: "incoming_call",
    callId: String(payload.callId ?? ""),
    fromUserId: fromLabel,
    fromUserDbId: String(payload.fromUserDbId ?? ""),
  };

  try {
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data,
      android: {
        priority: "high",
        notification: {
          sound: "default",
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title, body },
            sound: "default",
          },
        },
      },
    });

    const dead = [];
    res.responses.forEach((r, i) => {
      if (!r.success && r.error?.code === "messaging/registration-token-not-registered") {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) {
      await prisma.pushDevice.deleteMany({ where: { token: { in: dead } } });
    }
  } catch (e) {
    console.error("[GTN push] sendIncomingCallPushIfOffer:", e?.message || e);
  }
}
