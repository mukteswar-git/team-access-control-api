import { z } from "zod";
import type { PrismaClient } from "../generated/prisma/client.js";
import { prisma, type DatabaseClient } from "../lib/prisma.js";
import {
  createOrganization,
  findOrganizationById,
} from "../repositories/organization.repository.js";
import { hasPermission } from "./authorization.service.js";
import { OrganizationError } from "./organization.errors.js";
import { createAuditLog } from "./audit-log.service.js";
import { findMembershipsByUserId } from "../repositories/membership.repository.js";

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

    await createAuditLog(tx, {
      organizationId: organization.id,
      actorUserId: user.id,
      actorMembershipId: membership.id,
      action: "organization.created",
      result: "success",
      targetType: "organization",
      targetId: organization.id,
      metadata: {},
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

export async function listOrganizationsForUser(userId: string) {
  return findMembershipsByUserId(userId);
}

export async function transferOrganizationOwnership(
  actorUserId: string,
  organizationId: string,
  targetMembershipId: string,
  db: PrismaClient = prisma,
) {
  const parsedUserId = userIdSchema.safeParse(actorUserId);
  const parsedOrganizationId = organizationIdSchema.safeParse(organizationId);
  const parsedTargetMembershipId = z
    .string()
    .uuid("Target membership ID must be a valid UUID")
    .safeParse(targetMembershipId);

  if (
    !parsedUserId.success ||
    !parsedOrganizationId.success ||
    !parsedTargetMembershipId.success
  ) {
    throw new OrganizationError(
      "INVALID_INPUT",
      "Ownership transfer input is invalid",
    );
  }

  return db.$transaction(async (tx) => {
    // Serialize ownership transfers for this organization.
    const organizations = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM organizations
      WHERE id = ${parsedOrganizationId.data}::uuid
      FOR UPDATE
    `;

    if (organizations.length === 0) {
      throw new OrganizationError(
        "ORGANIZATION_NOT_FOUND",
        "Organization not found",
      );
    }

    const actor = await tx.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: parsedUserId.data,
          organizationId: parsedOrganizationId.data,
        },
      },
      include: { role: true },
    });

    if (!actor || actor.role.code !== "super_user") {
      throw new OrganizationError(
        "FORBIDDEN",
        "Only the current Super User can transfer organization ownership",
      );
    }

    const target = await tx.membership.findFirst({
      where: {
        id: parsedTargetMembershipId.data,
        organizationId: parsedOrganizationId.data,
      },
      include: { role: true },
    });

    if (
      !target ||
      target.id === actor.id ||
      target.role.code === "super_user"
    ) {
      throw new OrganizationError(
        "OWNERSHIP_TRANSFER_TARGET_INVALID",
        "Target must be another eligible member of this organization",
      );
    }

    const roles = await tx.role.findMany({
      where: {
        code: { in: ["super_user", "admin"] },
      },
      select: { id: true, code: true },
    });

    const superUserRole = roles.find((role) => role.code === "super_user");
    const adminRole = roles.find((role) => role.code === "admin");

    if (!superUserRole || !adminRole) {
      throw new OrganizationError(
        "SUPER_USER_ROLE_NOT_CONFIGURED",
        "Required ownership roles are not configured",
      );
    }

    // Remove reporting assignments that become invalid when the target
    // stops being an Admin or Manager.
    if (target.role.code === "admin") {
      await tx.membership.updateMany({
        where: {
          organizationId: parsedOrganizationId.data,
          adminMembershipId: target.id,
        },
        data: { adminMembershipId: null },
      });
    }

    if (target.role.code === "manager") {
      await tx.membership.updateMany({
        where: {
          organizationId: parsedOrganizationId.data,
          managerMembershipId: target.id,
        },
        data: { managerMembershipId: null },
      });
    }

    // Clear assignments incompatible with the target's new Super User role.
    await tx.membership.update({
      where: { id: target.id },
      data: {
        adminMembershipId: null,
        managerMembershipId: null,
      },
    });

    // Demote first because the database has a partial unique index allowing
    // at most one Super User per organization.
    await tx.membership.update({
      where: { id: actor.id },
      data: {
        roleId: adminRole.id,
        adminMembershipId: null,
        managerMembershipId: null,
      },
    });

    await tx.membership.update({
      where: { id: target.id },
      data: { roleId: superUserRole.id },
    });

    await createAuditLog(tx, {
      organizationId: parsedOrganizationId.data,
      actorUserId: parsedUserId.data,
      actorMembershipId: actor.id,
      action: "organization.ownership_transferred",
      result: "success",
      targetType: "organization",
      targetId: parsedOrganizationId.data,
      metadata: {
        previousOwnerMembershipId: actor.id,
        previousOwnerUserId: actor.userId,
        newOwnerMembershipId: target.id,
        newOwnerUserId: target.userId,
      },
    });

    return {
      organizationId: parsedOrganizationId.data,
      previousOwnerMembershipId: actor.id,
      newOwnerMembershipId: target.id,
    };
  });
}
