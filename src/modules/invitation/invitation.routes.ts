import { Router } from "express";
import { requireAuth } from "../../middleware/require-auth.js";
import validate from "../../middleware/validate.js";
import validateParams from "../../middleware/validate-params.js";
import {
  organizationInvitationParamsSchema,
  invitationParamsSchema,
  createInvitationBodySchema,
  acceptInvitationBodySchema,
} from "./invitation.schema.js";
import {
  createInvitationController,
  revokeInvitationController,
  acceptInvitationController,
} from "./invitation.controller.js";

const router = Router();

router.post(
  "/organizations/:organizationId/invitations",
  requireAuth,
  validateParams(organizationInvitationParamsSchema),
  validate(createInvitationBodySchema),
  createInvitationController,
);

router.delete(
  "/organizations/:organizationId/invitations/:invitationId",
  requireAuth,
  validateParams(invitationParamsSchema),
  revokeInvitationController,
);

router.post(
  "/invitations/accept",
  requireAuth,
  validate(acceptInvitationBodySchema),
  acceptInvitationController,
);

export default router;
