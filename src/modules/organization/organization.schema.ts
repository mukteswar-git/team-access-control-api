import { z } from "zod";

// Route parameters
export const organizationIdParamsSchema = z.object({
  organizationId: z.string().uuid("Organization ID must be a valid UUID"),
});

export const membershipParamsSchema = z.object({
  organizationId: z.string().uuid("Organization ID must be a valid UUID"),
  membershipId: z.string().uuid("Membership ID must be a valid UUID"),
});

export const organizationUserParamsSchema = z.object({
  organizationId: z.string().uuid("Organization ID must be a valid UUID"),
  userId: z.string().uuid("User ID must be a valid UUID"),
});

// Organization request bodies
export const createOrganizationBodySchema = z.object({
  name: z.string().trim().min(1, "Organization name is required"),
});

export const transferOwnershipBodySchema = z.object({
  targetMembershipId: z
    .string()
    .uuid("Target membership ID must be a valid UUID"),
});

// Membership request bodies
export const changeMembershipRoleBodySchema = z.object({
  roleCode: z.enum(["super_user", "admin", "manager", "member"]),
});

export const updateReportingAssignmentBodySchema = z.discriminatedUnion(
  "role",
  [
    z.object({
      role: z.literal("manager"),
      adminMembershipId: z.string().uuid().nullable(),
    }),
    z.object({
      role: z.literal("member"),
      managerMembershipId: z.string().uuid().nullable(),
    }),
  ],
);
