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

export const organizationAuditLogQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    action: z.string().trim().min(1).optional(),
    result: z.string().trim().min(1).optional(),
    actorUserId: z.string().uuid().optional(),
    actorMembershipId: z.string().uuid().optional(),
    targetType: z.string().trim().min(1).optional(),
    targetId: z.string().uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      query.from <= query.to,
    {
      message: "The start date must not be later than the end date",
      path: ["from"],
    },
  );
