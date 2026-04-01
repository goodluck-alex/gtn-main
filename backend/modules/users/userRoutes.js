import express from "express";
import {
  getUser,
  listUsers,
  getMe,
  patchMe,
  changePassword,
  deleteAccount,
  searchContacts,
  matchContacts,
  logoutAllDevices,
  getMySessions,
  deleteMySession,
  getMyBlocks,
  postMyBlock,
  deleteMyBlock,
  postMyPushToken,
  deleteMyPushToken,
} from "./userController.js";
import { post2faSetup, post2faEnable, post2faDisable } from "./userTwoFactorController.js";
import { authenticate } from "../../middleware/authMiddleware.js";

const router = express.Router();

router.get("/", authenticate, listUsers);
router.get("/me", authenticate, getMe);
router.patch("/me", authenticate, patchMe);
router.get("/me/sessions", authenticate, getMySessions);
router.delete("/me/sessions/:sessionId", authenticate, deleteMySession);
router.get("/me/blocks", authenticate, getMyBlocks);
router.post("/me/blocks", authenticate, postMyBlock);
router.delete("/me/blocks/:blockedId", authenticate, deleteMyBlock);
router.post("/me/2fa/setup", authenticate, post2faSetup);
router.post("/me/2fa/enable", authenticate, post2faEnable);
router.post("/me/2fa/disable", authenticate, post2faDisable);
router.post("/me/password", authenticate, changePassword);
router.post("/me/delete", authenticate, deleteAccount);
router.post("/me/logout-all-devices", authenticate, logoutAllDevices);
router.post("/me/push-token", authenticate, postMyPushToken);
router.delete("/me/push-token", authenticate, deleteMyPushToken);
router.get("/contacts/search", authenticate, searchContacts);
router.post("/contacts/match", authenticate, matchContacts);
router.get("/:id", authenticate, getUser);

export default router;