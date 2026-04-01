import admin from "firebase-admin";

let initialized = false;

/**
 * @returns {import("firebase-admin/messaging").Messaging | null}
 */
export function getFirebaseMessaging() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return null;
  if (!initialized) {
    try {
      const sa = JSON.parse(raw);
      if (!sa.project_id || !sa.client_email || !sa.private_key) {
        console.error("[GTN push] FIREBASE_SERVICE_ACCOUNT_JSON missing project_id / client_email / private_key");
        return null;
      }
      admin.initializeApp({
        credential: admin.credential.cert(sa),
      });
      initialized = true;
    } catch (e) {
      console.error("[GTN push] Firebase init failed:", e?.message || e);
      return null;
    }
  }
  return admin.messaging();
}
