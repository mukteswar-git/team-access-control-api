import {
  hasOrganizationMembership,
  hasPermission,
  canChangeMembershipRole,
} from "./authorization.service.js";
import {
  findMembershipById,
  findMembershipsByOrganizationId,
} from "../repositories/membership.repository.js";
import { MembershipError } from "./membership.errors.js";
import { prisma, type DatabaseClient } from "../lib/prisma.js";

async function assertMembershipReadAccess(
  actorUserId: string,
  organizationId: string,
  db: DatabaseClient,
): Promise<void> {
  if (!actorUserId.trim() || !organizationId.trim()) {
    throw new MembershipError(
      "INVALID_INPUT",
      "User ID and organization ID are required.",
    );
  }

  const isMember = await hasOrganizationMembership(
    actorUserId,
    organizationId,
    db,
  );

  if (!isMember) {
    throw new MembershipError(
      "FORBIDDEN",
      "You do not have access to this organization.",
    );
  }

  const hasReadPermission = await hasPermission(
    actorUserId,
    organizationId,
    "membership.read",
    db,
  );

  if (!hasReadPermission) {
    throw new MembershipError(
      "FORBIDDEN",
      "You do not have permission to read memberships.",
    );
  }
}

export async function getMembershipDetails(
  actorUserId: string,
  organizationId: string,
  targetMembershipId: string,
  db: DatabaseClient = prisma,
) {
  if (!targetMembershipId.trim()) {
    throw new MembershipError("INVALID_INPUT", "Membership ID is required.");
  }

  await assertMembershipReadAccess(actorUserId, organizationId, db);

  const membership = await findMembershipById(
    targetMembershipId,
    organizationId,
    db,
  );

  if (!membership) {
    throw new MembershipError("MEMBERSHIP_NOT_FOUND", "Membership not found.");
  }

  return membership;
}

export async function listOrganizationMemberships(
  actorUserId: string,
  organizationId: string,
  db: DatabaseClient = prisma,
) {
  await assertMembershipReadAccess(actorUserId, organizationId, db);

  return findMembershipsByOrganizationId(organizationId, db);
}

export async function getOrganizationStructure(
  actorUserId: string,
  organizationId: string,
  db: DatabaseClient = prisma,
) {
  await assertMembershipReadAccess(actorUserId, organizationId, db);

  const memberships = await findMembershipsByOrganizationId(organizationId, db);

  const admins = memberships.filter(
    (membership) => membership.role.code === "admin",
  );

  const managers = memberships
    .filter((membership) => membership.role.code === "manager")
    .map((manager) => ({
      ...manager,
      memberCount: memberships.filter(
        (membership) =>
          membership.role.code === "member" &&
          membership.managerMembershipId === manager.id,
      ).length,
    }));

  const members = memberships.filter(
    (membership) => membership.role.code === "member",
  );

  const superUsers = memberships.filter(
    (membership) => membership.role.code === "super_user",
  );

  return {
    organizationId,
    counts: {
      total: memberships.length,
      superUsers: superUsers.length,
      admins: admins.length,
      managers: managers.length,
      members: members.length,
    },
    superUsers,
    admins,
    managers,
    members,
  };
}

export async function changeMembershipRole(
  actorUserId: string,
  organizationId: string,
  targetMembershipId: string,
  newRoleCode: string,
  db = prisma,
) {
  return db.$transaction(async (tx) => {
    // Load the target membership inside the transaction.
    const target = await tx.membership.findFirst({
      where: {
        id: targetMembershipId,
        organizationId,
      },
      include: {
        role: true,
      },
    });

    if (!target) {
      throw new Error("Membership not found.");
    }

    // Resolve the requested role.
    const newRole = await tx.role.findUnique({
      where: {
        code: newRoleCode,
      },
    });

    if (!newRole) {
      throw new Error("Invalid role.");
    }

    // Check authorization using the same transaction client.
    const allowed = await canChangeMembershipRole(
      actorUserId,
      organizationId,
      targetMembershipId,
      newRoleCode,
      tx,
    );

    if (!allowed) {
      throw new Error("Not authorized to change this membership's role.");
    }

    const previousRoleCode = target.role.code;

    // When an Admin changes role, their assigned Managers become unassigned.
    // Those Managers retain their own Member assignments.
    if (previousRoleCode === "admin" && newRoleCode !== "admin") {
      await tx.membership.updateMany({
        where: {
          organizationId,
          adminMembershipId: target.id,
        },
        data: {
          adminMembershipId: null,
        },
      });
    }

    // When a Manager changes role, their directly assigned Members
    // become unassigned.
    if (previousRoleCode === "manager" && newRoleCode !== "manager") {
      await tx.membership.updateMany({
        where: {
          organizationId,
          managerMembershipId: target.id,
        },
        data: {
          managerMembershipId: null,
        },
      });
    }

    // Clear reporting assignments incompatible with the new role.
    if (newRoleCode === "admin") {
      await tx.membership.update({
        where: {
          id: target.id,
        },
        data: {
          adminMembershipId: null,
          managerMembershipId: null,
        },
      });
    } else if (newRoleCode === "manager") {
      await tx.membership.update({
        where: {
          id: target.id,
        },
        data: {
          managerMembershipId: null,
        },
      });
    } else if (newRoleCode === "member") {
      await tx.membership.update({
        where: {
          id: target.id,
        },
        data: {
          adminMembershipId: null,
        },
      });
    }

    // Apply the new role.
    const updatedMembership = await tx.membership.update({
      where: {
        id: target.id,
      },
      data: {
        roleId: newRole.id,
      },
      include: {
        role: true,
      },
    });

    // Record the role change in the same transaction.
    await tx.auditLog.create({
      data: {
        organizationId,
        actorUserId,
        actorMembershipId:
          (
            await tx.membership.findUnique({
              where: {
                userId_organizationId: {
                  userId: actorUserId,
                  organizationId,
                },
              },
              select: {
                id: true,
              },
            })
          )?.id ?? null,
        action: "membership.role_changed",
        result: "success",
        targetType: "membership",
        targetId: target.id,
        metadata: {
          previousRole: previousRoleCode,
          newRole: updatedMembership.role.code,
        },
      },
    });

    return {
      membershipId: updatedMembership.id,
      previousRole: previousRoleCode,
      newRole: updatedMembership.role.code,
    };
  });
}
