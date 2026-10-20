import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";
import { prisma, type DatabaseClient } from "../lib/prisma.js";
import {
  createOrganization,
  findOrganizationById,
} from "../repositories/organization.repository.js";
import { hasPermission } from "./authorization.service.js";
import { OrganizationError } from "./organization.errors.js";

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1, "Organization name is required"),
});

const organizationIdSchema = z
  .string()
  .uuid("Organization ID must be a valid UUID");
const userIdSchema = z.string().uuid("User ID must be a valid UUID");

type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

/**
 * Creates an organization and its initial Super User membership atomically.
 * Organization creation is available to any authenticated user with a verified email.
 */
export async function createOrganizationForUser(
  actorUserId: string,
  input: CreateOrganizationInput,
  db: PrismaClient = prisma,
) {
  const parsedUserId = userIdSchema.safeParse(actorUserId);
  const parsedInput = createOrganizationSchema.safeParse(input);

  if (!parsedUserId.success || !parsedInput.success) {
    throw new OrganizationError(
      "INVALID_INPUT",
      "Organization creation input is invalid",
    );
  }

  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: parsedUserId.data },
      select: { id: true, emailVerifiedAt: true },
    });

    if (!user || user.emailVerifiedAt === null) {
      throw new OrganizationError(
        "EMAIL_NOT_VERIFIED",
        "A verified account is required to create an organization",
      );
    }

    const superUserRole = await tx.role.findUnique({
      where: { code: "super_user" },
      select: { id: true },
    });

    if (!superUserRole) {
      throw new OrganizationError(
        "SUPER_USER_ROLE_NOT_CONFIGURED",
        "The Super User role is not configured",
      );
    }

    const organization = await createOrganization(
      { name: parsedInput.data.name },
      tx,
    );

    const membership = await tx.membership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        roleId: superUserRole.id,
      },
    });

    await tx.auditLog.create({
      data: {
        organizationId: organization.id,
        actorUserId: user.id,
        actorMembershipId: membership.id,
        action: "organization.created",
        result: "success",
        targetType: "organization",
        targetId: organization.id,
        metadata: {},
      },
    });

    return organization;
  });
}

/**
 * Returns basic organization information only when the actor has organization.read.
 * A missing membership and a missing organization both produce FORBIDDEN to avoid
 * disclosing whether an inaccessible organization exists.
 */
export async function getOrganizationForUser(
  actorUserId: string,
  organizationId: string,
  db: DatabaseClient = prisma,
) {
  const parsedUserId = userIdSchema.safeParse(actorUserId);
  const parsedOrganizationId = organizationIdSchema.safeParse(organizationId);

  if (!parsedUserId.success || !parsedOrganizationId.success) {
    throw new OrganizationError(
      "INVALID_INPUT",
      "Organization lookup input is invalid",
    );
  }

  const permitted = await hasPermission(
    parsedUserId.data,
    parsedOrganizationId.data,
    "organization.read",
    db,
  );

  if (!permitted) {
    throw new OrganizationError(
      "FORBIDDEN",
      "You do not have access to this organization",
    );
  }

  const organization = await findOrganizationById(
    parsedOrganizationId.data,
    db,
  );

  if (!organization) {
    throw new OrganizationError(
      "ORGANIZATION_NOT_FOUND",
      "Organization not found",
    );
  }

  return organization;
}
