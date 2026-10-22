import { z } from "zod";

export const organizationInvitationParamsSchema = z.object({
  organizationId: z.string().uuid("Organization ID must be a valid UUID"),
});

export const invitationParamsSchema = z.object({
  organizationId: z.string().uuid("Organization ID must be a valid UUID"),
  invitationId: z.string().uuid("Invitation ID must be a valid UUID"),
});

export const createInvitationBodySchema = z.object({
  email: z.string().trim().email("A valid email address is required"),
  roleCode: z.enum(["admin", "manager", "member"]),
  adminMembershipId: z.string().uuid().nullable().optional(),
  managerMembershipId: z.string().uuid().nullable().optional(),
});

export const acceptInvitationBodySchema = z.object({
  token: z.string().trim().min(1, "Invitation token is required"),
});
