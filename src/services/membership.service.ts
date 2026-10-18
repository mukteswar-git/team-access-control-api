import { prisma } from "../lib/prisma.js";
import { canChangeMembershipRole } from "./authorization.service.js";

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
