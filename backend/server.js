import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { Server } from "socket.io";

// Import Prisma
import { prisma } from "./prisma/client.js";


// Import Routes
import authRoutes from "./modules/auth/authRoutes.js";
import userRoutes from "./modules/users/userRoutes.js";
import referralRoutes from "./modules/referrals/referralRoutes.js";
import callRoutes from "./modules/calls/callRoutes.js";
import messagingRoutes from "./modules/messages/messagingRoutes.js";
import voiceRoomRoutes from "./modules/voiceRooms/voiceRoomRoutes.js";
import localeRoutes from "./modules/locale/localeRoutes.js";
import webrtcRoutes from "./modules/webrtc/webrtcRoutes.js";
import plansRoutes from "./modules/plans/plansRoutes.js";
import paymentRoutes from "./modules/payment/paymentRoutes.js";
import paymentMethodsRoutes from "./modules/payment/paymentMethodsRoutes.js";
import adminRoutes from "./modules/admin/adminRoutes.js";
import { setSocketIo } from "./socket/ioInstance.js";
import { attachChatSocket } from "./socket/chatSocket.js";
import * as callBilling from "./modules/calls/callBillingService.js";
import { normalizePhoneE164 } from "./modules/auth/authService.js";
import {
  resolveReceiverUserIdForPush,
  sendIncomingCallPushIfOffer,
} from "./modules/push/incomingCallPush.js";

dotenv.config();
const app = express();

/** Comma-separated browser origins allowed to call /api/admin (e.g. https://admin.example.com). */
function adminCorsAllowedList() {
  const raw = (process.env.ADMIN_APP_ORIGINS || "").trim();
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["http://localhost:3001"];
  return list;
}

const adminOrigins = adminCorsAllowedList();

app.use((req, res, next) => {
  const p = req.path || "";
  if (p.startsWith("/api/admin")) {
    return cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (adminOrigins.includes(origin)) return cb(null, true);
        cb(new Error("Not allowed by CORS for admin API"));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "x-admin-trace-token"],
    })(req, res, next);
  }
  return cors()(req, res, next);
});

app.use(express.json({ limit: "4mb" }));

// API Routes
app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/referrals", referralRoutes);
app.use("/api/calls", callRoutes);
app.use("/api/messages", messagingRoutes);
app.use("/api/voice-rooms", voiceRoomRoutes);
app.use("/api/locale", localeRoutes);
app.use("/api/webrtc", webrtcRoutes);
app.use("/api/plans", plansRoutes);
app.use("/api/payment", paymentRoutes);      // legacy compatibility
app.use("/api/payments", paymentRoutes);     // stable contract
app.use("/api/payment-methods", paymentMethodsRoutes);

// Health check
app.get("/", (req, res) => res.json({ status: "GTN backend running" }));

// --- Socket.io ---
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

setSocketIo(io);
attachChatSocket(io);

const onlineUsers = new Map();

io.on("connection", async (socket) => {
  console.log("User connected:", socket.id);

  /** WebRTC dialer: map E.164 phone → socket id (JWT users auto-registered). */
  if (socket.userId) {
    try {
      const u = await prisma.user.findUnique({ where: { id: socket.userId } });
      if (u) {
        const rawPhone = u.phone || `+256${u.subscriberId}`;
        const phone = normalizePhoneE164(rawPhone);
        onlineUsers.set(phone, socket.id);
        socket.gtnCallPhone = phone;
      }
    } catch (e) {
      console.error("Failed to register phone for WebRTC:", e);
    }
  }

  const getPhoneBySocketId = () => {
    for (const [phone, id] of onlineUsers.entries()) {
      if (id === socket.id) return phone;
    }
    return null;
  };

  socket.on("register", (userId) => {
    onlineUsers.set(userId, socket.id);
    console.log("User online:", userId);
  });

  // Messaging
  socket.on("send_message", async ({ fromUserId, toUserId, content, type }) => {
    try {
      const message = await prisma.message.create({
        data: { fromUserId, toUserId, content, type },
      });
      const receiverSocket = onlineUsers.get(toUserId);
      if (receiverSocket) io.to(receiverSocket).emit("receive_message", message);
    } catch (err) {
      console.error(err);
    }
  });

  // Call signaling (WebRTC offer/answer/ICE via simple-peer)
  // callId: DB row from POST /api/calls/start (forwarded so callee can POST /calls/end)
  socket.on("call_user", async ({ fromUserId, toUserId, toUserDbId, signal, callId }) => {
    // Prefer routing by authenticated db id room when available (avoids phone formatting mismatches).
    const toDbId = Number(toUserDbId);
    if (Number.isFinite(toDbId) && toDbId > 0) {
      try {
        const room = `user:${toDbId}`;
        const sockets = await io.in(room).fetchSockets();
        if (Array.isArray(sockets) && sockets.length > 0) {
          io.to(room).emit("incoming_call", {
            fromUserId,
            fromUserDbId: socket.userId ?? null,
            signal,
            callId,
          });
          socket.emit("call_routed", { ok: true, route: "user_room", toUserDbId: toDbId });
          return;
        }
        // Fall through to phone-map routing if the user room has no sockets.
        socket.emit("call_routed", { ok: false, route: "user_room_empty", toUserDbId: toDbId });
        socket.emit("call_failed", { reason: "offline", toUserId: `user:${toDbId}` });
      } catch (e) {
        socket.emit("call_routed", { ok: false, route: "user_room_error", toUserDbId: toDbId });
        socket.emit("call_failed", { reason: "offline", toUserId: `user:${toDbId}` });
      }
    }
    let toKey = toUserId;
    try {
      toKey = normalizePhoneE164(toUserId);
    } catch {
      /* keep raw */
    }
    const receiverSocket = onlineUsers.get(toKey);
    if (!receiverSocket) {
      const pushUserId = await resolveReceiverUserIdForPush(toDbId, toKey);
      if (pushUserId) {
        await sendIncomingCallPushIfOffer(pushUserId, {
          fromUserId,
          fromUserDbId: socket.userId ?? null,
          callId,
          signal,
        });
      }
      socket.emit("call_failed", { reason: "offline", toUserId: toKey });
      socket.emit("call_routed", { ok: false, route: "phone_map_offline", toUserId: toKey });
      return;
    }
    io.to(receiverSocket).emit("incoming_call", {
      fromUserId,
      fromUserDbId: socket.userId ?? null,
      signal,
      callId,
    });
    socket.emit("call_routed", { ok: true, route: "phone_map", toUserId: toKey });
  });

  socket.on("answer_call", ({ toUserId, toUserDbId, signal }) => {
    const toDbId = Number(toUserDbId);
    if (Number.isFinite(toDbId) && toDbId > 0) {
      io.to(`user:${toDbId}`).emit("call_answered", signal);
    } else {
    let toKey = toUserId;
    try {
      toKey = normalizePhoneE164(toUserId);
    } catch {
      /* keep raw */
    }
    const callerSocket = onlineUsers.get(toKey);
    if (callerSocket) io.to(callerSocket).emit("call_answered", signal);
    }

    // Persist answered status for missed-call history.
    // Assumption: Socket `register` stores `userId` keys as E.164 phone strings.
    const receiverPhone = getPhoneBySocketId();
    const callerPhone = toKey;
    if (callerPhone && receiverPhone) {
      prisma.call
        .findFirst({
          where: {
            callerPhone: String(callerPhone),
            receiverPhone: String(receiverPhone),
            status: "started",
          },
          orderBy: { createdAt: "desc" },
        })
        .then((call) => {
          if (!call) return;
          return prisma.call.update({
            where: { id: call.id },
            data: { status: "answered", answeredAt: new Date() },
          });
        })
        .catch((err) => console.error("Failed to mark call answered:", err));
    }
  });

  socket.on("end_call", ({ toUserId, toUserDbId }) => {
    const toDbId = Number(toUserDbId);
    if (Number.isFinite(toDbId) && toDbId > 0) {
      io.to(`user:${toDbId}`).emit("call_ended");
      return;
    }
    let toKey = toUserId;
    try {
      toKey = normalizePhoneE164(toUserId);
    } catch {
      /* keep raw */
    }
    const receiverSocket = onlineUsers.get(toKey);
    if (receiverSocket) io.to(receiverSocket).emit("call_ended");
  });

  socket.on("reject_call", ({ toUserId, toUserDbId }) => {
    const toDbId = Number(toUserDbId);
    if (Number.isFinite(toDbId) && toDbId > 0) {
      io.to(`user:${toDbId}`).emit("call_rejected");
      return;
    }
    let toKey = toUserId;
    try {
      toKey = normalizePhoneE164(toUserId);
    } catch {
      /* keep raw */
    }
    const callerSocket = onlineUsers.get(toKey);
    if (callerSocket) io.to(callerSocket).emit("call_rejected");
  });

  /** Per-minute P2P billing — caller must match JWT (socket.userId). */
  socket.on("call_billing_tick", async ({ callId, minuteIndex }) => {
    if (socket.userId == null || callId == null || minuteIndex == null) return;
    try {
      const id = parseInt(callId, 10);
      const mi = parseInt(minuteIndex, 10);
      if (!Number.isFinite(id) || !Number.isFinite(mi)) return;
      const result = await callBilling.processBillingTick(id, socket.userId, mi);
      if (!result.ok) {
        socket.emit("call_billing_failed", result);
        return;
      }
      socket.emit("call_billing_ok", {
        minuteIndex: mi,
        balance: result.balance,
        freeMinutes: result.freeMinutes,
        usedFree: result.usedFree,
      });
    } catch (e) {
      console.error("call_billing_tick", e);
      socket.emit("call_billing_failed", { error: e.message || "billing_error" });
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    for (const [userId, id] of onlineUsers.entries()) {
      if (id === socket.id) onlineUsers.delete(userId);
    }
    console.log("User disconnected:", socket.id);
  });
});

// Missed-call status updater (timeout-based)
// Any call still in `started` state after 30 seconds becomes `missed`.
const missedInterval = setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 1000);
    const stale = await prisma.call.findMany({
      where: { status: "started", createdAt: { lte: cutoff } },
      select: { id: true, callerUserId: true },
    });
    for (const c of stale) {
      await prisma.call.update({
        where: { id: c.id },
        data: { status: "missed" },
      });
      if (c.callerUserId) {
        callBilling.unregisterBillingSession(c.id, c.callerUserId);
      }
    }
  } catch (err) {
    // If DB migration hasn't been applied yet, avoid spamming logs.
    if (err?.code === "P2021") {
      console.warn("Skipping missed-call updater (Call table missing). Apply DB migrations.");
      clearInterval(missedInterval);
      return;
    }
    console.error("Failed to update missed calls:", err);
  }
}, 5000);

// Start server
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => console.log(`🚀 GTN backend running on port ${PORT}`));
