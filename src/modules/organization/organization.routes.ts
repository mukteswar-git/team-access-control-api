import { Router } from "express";
import { requireAuth } from "../../middleware/require-auth.js";
import validate from "../../middleware/validate.js";
import validateParams from "../../middleware/validate-params.js";
import {
  organizationIdParamsSchema,
  membershipParamsSchema,
  createOrganizationBodySchema,
  transferOwnershipBodySchema,
  changeMembershipRoleBodySchema,
  updateReportingAssignmentBodySchema,
} from "./organization.schema.js";
import {
  createOrganization,
  getOrganization,
  transferOwnership,
  listMemberships,
  getMembership,
  getOrganizationStructureController,
  changeRole,
  updateReportingAssignment,
  removeMembershipController,
} from "./organization.controller.js";

const router = Router();

router.post(
  "/",
  requireAuth,
  validate(createOrganizationBodySchema),
  createOrganization,
);

router.get(
  "/:organizationId",
  requireAuth,
  validateParams(organizationIdParamsSchema),
  getOrganization,
);

router.post(
  "/:organizationId/transfer-ownership",
  requireAuth,
  validateParams(organizationIdParamsSchema),
  validate(transferOwnershipBodySchema),
  transferOwnership,
);

router.get(
  "/:organizationId/memberships",
  requireAuth,
  validateParams(organizationIdParamsSchema),
  listMemberships,
);

router.get(
  "/:organizationId/memberships/:membershipId",
  requireAuth,
  validateParams(membershipParamsSchema),
  getMembership,
);

router.get(
  "/:organizationId/structure",
  requireAuth,
  validateParams(organizationIdParamsSchema),
  getOrganizationStructureController,
);

router.patch(
  "/:organizationId/memberships/:membershipId/role",
  requireAuth,
  validateParams(membershipParamsSchema),
  validate(changeMembershipRoleBodySchema),
  changeRole,
);

router.patch(
  "/:organizationId/memberships/:membershipId/reporting-assignment",
  requireAuth,
  validateParams(membershipParamsSchema),
  validate(updateReportingAssignmentBodySchema),
  updateReportingAssignment,
);

router.delete(
  "/:organizationId/memberships/:membershipId",
  requireAuth,
  validateParams(membershipParamsSchema),
  removeMembershipController,
);

export default router;
