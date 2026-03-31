import { prisma } from "../../prisma/client.js";
import * as callService from "./callService.js";
import * as referralService from "../referrals/referralService.js";
import * as callBilling from "./callBillingService.js";
import { normalizePhoneE164 } from "../auth/authService.js";
import { isUnlimitedActive } from "../plans/plansService.js";
import { assertCanPlaceVoiceCall } from "./callPolicy.js";
import { getUserPhoneIdentity } from "../users/userPhoneIdentity.js";

export async function canStartCall(req, res) {
  try {
    await referralService.ensureDailyFreeMinutes(req.user.id);
    const u = await prisma.user.findUnique({ where: { id: req.user.id } });
    const canStart = Boolean(u && (isUnlimitedActive(u) || u.freeMinutes >= 1));
    res.json({
      canStart,
      freeMinutes: u?.freeMinutes ?? 0,
      planUnlimited: Boolean(u && isUnlimitedActive(u)),
      ...(!canStart ? { error: "Insufficient free minutes to start call." } : {}),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function startCall(req, res) {
  try {
    const raw = req.body?.receiverPhone;
    if (raw == null || String(raw).trim() === "") {
      return res.status(400).json({ error: "receiverPhone is required" });
    }

    await referralService.ensureDailyFreeMinutes(req.user.id);

    const callerPhone = (await getUserPhoneIdentity(req)) || (req.user.phone || `+256${req.user.subscriberId}`);
    const callerUserId = req.user.id;
    let receiver;
    try {
      receiver = normalizePhoneE164(raw);
    } catch (e) {
      return res.status(400).json({
        error: e.message || "Invalid phone number. Use E.164 with country code (e.g. +256700000000).",
      });
    }

    const receiverRow = await prisma.user.findFirst({
      where: { phone: receiver },
      select: { id: true },
    });

    if (receiverRow?.id != null) {
      await assertCanPlaceVoiceCall(callerUserId, receiverRow.id);
    }

    const call = await callService.startCall({
      callerPhone,
      receiverPhone: receiver,
      callerUserId,
      receiverUserId: receiverRow?.id ?? null,
    });

    void referralService.tryCompleteReferralActivity(req.user.id, "first_call").catch(() => {});

    res.json(call);
  } catch (err) {
    const code = err.code;
    if (code === "INSUFFICIENT_FUNDS" || code === "CONCURRENT_CALL") {
      return res.status(400).json({ error: err.message, code });
    }
    res.status(400).json({ error: err.message });
  }
}

export async function endCall(req, res) {
  try {
    const userPhone = (await getUserPhoneIdentity(req)) || (req.user.phone || `+256${req.user.subscriberId}`);
    const call = await callService.endCallForParticipant(req.body?.callId, req.body?.duration, userPhone);
    res.json(call);
  } catch (err) {
    const msg = err.message || "Failed to end call";
    if (err.code === "FORBIDDEN" || msg === "Forbidden") {
      return res.status(403).json({ error: msg });
    }
    if (msg === "Call not found") {
      return res.status(404).json({ error: msg });
    }
    res.status(400).json({ error: msg });
  }
}

export async function getCalls(req, res) {
  try {
    const userPhone = (await getUserPhoneIdentity(req)) || (req.user.phone || `+256${req.user.subscriberId}`);
    const calls = await callService.getUserCalls(userPhone);
    res.json(calls);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}
