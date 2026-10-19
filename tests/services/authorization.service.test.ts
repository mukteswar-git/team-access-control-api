import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import {
  canManageMembership,
  canPerformMembershipAction,
  canChangeMembershipRole,
  hasOrganizationMembership,
  hasPermission,
} from "../../src/services/authorization.service.js";

describe("Authorization service", () => {
  afterAll(async () => {
    await disconnectTestDatabase();
  });

  async function createTestUser() {
    return prisma.user.create({
      data: {
        email: `authorization-${randomUUID()}@example.com`,
        passwordHash: "test-hash",
      },
    });
  }

  async function createTestOrganization() {
    return prisma.organization.create({
      data: {
        name: `Organization ${randomUUID()}`,
      },
    });
  }

  async function getRoleId(code: string) {
    const role = await prisma.role.findUnique({
      where: { code },
    });

    if (!role) {
      throw new Error(
        `Role "${code}" not found. Ensure the test database is seeded.`,
      );
    }

    return role.id;
  }

  test("confirms membership in the requested organization", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
        },
      });

      await expect(
        hasOrganizationMembership(user.id, organization.id),
      ).resolves.toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies membership validation when the user has no membership", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await expect(
        hasOrganizationMembership(user.id, organization.id),
      ).resolves.toBe(false);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies membership validation for a different organization", async () => {
    const user = await createTestUser();
    const organizationA = await createTestOrganization();
    const organizationB = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organizationA.id,
          roleId: await getRoleId("member"),
        },
      });

      await expect(
        hasOrganizationMembership(user.id, organizationB.id),
      ).resolves.toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.organization.deleteMany({
        where: {
          id: { in: [organizationA.id, organizationB.id] },
        },
      });
    }
  });

  test("grants a permission assigned to the user's role", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();
    const roleId = await getRoleId("member");

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId,
        },
      });

      const result = await hasPermission(
        user.id,
        organization.id,
        "organization.read",
      );

      expect(result).toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies a permission not assigned to the user's role", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();
    const roleId = await getRoleId("member");

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId,
        },
      });

      const result = await hasPermission(
        user.id,
        organization.id,
        "organization.manage",
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies an unknown permission code", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();
    const roleId = await getRoleId("member");

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId,
        },
      });

      const result = await hasPermission(
        user.id,
        organization.id,
        "permission.that.does.not.exist",
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies access when the user has no membership in the organization", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const result = await hasPermission(
        user.id,
        organization.id,
        "organization.read",
      );

      expect(result).toBe(false);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows an Admin to manage a Manager assigned to them", async () => {
    const admin = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const adminMembership = await prisma.membership.create({
        data: {
          userId: admin.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
          adminMembershipId: adminMembership.id,
        },
      });

      const result = await canManageMembership(
        admin.id,
        organization.id,
        managerMembership.id,
      );

      expect(result).toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [admin.id, manager.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies an Admin access to another Admin's Manager", async () => {
    const admin1 = await createTestUser();
    const admin2 = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: admin1.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const admin2Membership = await prisma.membership.create({
        data: {
          userId: admin2.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
          adminMembershipId: admin2Membership.id,
        },
      });

      const result = await canManageMembership(
        admin1.id,
        organization.id,
        managerMembership.id,
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [admin1.id, admin2.id, manager.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies an Admin access to another Admin's Member", async () => {
    const adminOne = await createTestUser();
    const adminTwo = await createTestUser();
    const manager = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: adminOne.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const adminTwoMembership = await prisma.membership.create({
        data: {
          userId: adminTwo.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
          adminMembershipId: adminTwoMembership.id,
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
          managerMembershipId: managerMembership.id,
        },
      });

      await expect(
        canManageMembership(adminOne.id, organization.id, memberMembership.id),
      ).resolves.toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: {
          id: {
            in: [adminOne.id, adminTwo.id, manager.id, member.id],
          },
        },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows an Admin to manage a Member assigned to their Manager", async () => {
    const admin = await createTestUser();
    const manager = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const adminMembership = await prisma.membership.create({
        data: {
          userId: admin.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
          adminMembershipId: adminMembership.id,
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
          managerMembershipId: managerMembership.id,
        },
      });

      await expect(
        canManageMembership(admin.id, organization.id, memberMembership.id),
      ).resolves.toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: {
          id: { in: [admin.id, manager.id, member.id] },
        },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows an Admin to manage an unassigned Member", async () => {
    const admin = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: admin.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
          adminMembershipId: null,
          managerMembershipId: null,
        },
      });

      const result = await canManageMembership(
        admin.id,
        organization.id,
        memberMembership.id,
      );

      expect(result).toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [admin.id, member.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies a Manager access to an unassigned Member", async () => {
    const manager = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
          adminMembershipId: null,
          managerMembershipId: null,
        },
      });

      const result = await canManageMembership(
        manager.id,
        organization.id,
        memberMembership.id,
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [manager.id, member.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows a Manager to manage a directly assigned Member", async () => {
    const manager = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
          managerMembershipId: managerMembership.id,
        },
      });

      const result = await canManageMembership(
        manager.id,
        organization.id,
        memberMembership.id,
      );

      expect(result).toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [manager.id, member.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies access to a membership in another organization", async () => {
    const admin = await createTestUser();
    const targetUser = await createTestUser();
    const organizationA = await createTestOrganization();
    const organizationB = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: admin.id,
          organizationId: organizationA.id,
          roleId: await getRoleId("admin"),
        },
      });

      const targetMembership = await prisma.membership.create({
        data: {
          userId: targetUser.id,
          organizationId: organizationB.id,
          roleId: await getRoleId("member"),
        },
      });

      const result = await canManageMembership(
        admin.id,
        organizationA.id,
        targetMembership.id,
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: {
          organizationId: {
            in: [organizationA.id, organizationB.id],
          },
        },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [admin.id, targetUser.id] } },
      });

      await prisma.organization.deleteMany({
        where: {
          id: { in: [organizationA.id, organizationB.id] },
        },
      });
    }
  });

  test("denies an Admin's action when the target is outside their scope", async () => {
    const admin1 = await createTestUser();
    const admin2 = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: admin1.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const admin2Membership = await prisma.membership.create({
        data: {
          userId: admin2.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
          adminMembershipId: admin2Membership.id,
        },
      });

      const result = await canPerformMembershipAction(
        admin1.id,
        organization.id,
        managerMembership.id,
        "membership.remove",
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: {
          id: { in: [admin1.id, admin2.id, manager.id] },
        },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies an Admin's action when they lack the required permission", async () => {
    const admin = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: admin.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
        },
      });

      const result = await canPerformMembershipAction(
        admin.id,
        organization.id,
        memberMembership.id,
        "permission.that.does.not.exist",
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [admin.id, member.id] } },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows a Super User to manage an Admin in the same organization", async () => {
    const superUser = await createTestUser();
    const admin = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: superUser.id,
          organizationId: organization.id,
          roleId: await getRoleId("super_user"),
        },
      });

      const adminMembership = await prisma.membership.create({
        data: {
          userId: admin.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const result = await canManageMembership(
        superUser.id,
        organization.id,
        adminMembership.id,
      );

      expect(result).toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [superUser.id, admin.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows a Super User to manage an unassigned Manager", async () => {
    const superUser = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: superUser.id,
          organizationId: organization.id,
          roleId: await getRoleId("super_user"),
        },
      });

      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
          adminMembershipId: null,
        },
      });

      const result = await canManageMembership(
        superUser.id,
        organization.id,
        managerMembership.id,
      );

      expect(result).toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [superUser.id, manager.id] } },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies a Super User from managing their own membership", async () => {
    const superUser = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const membership = await prisma.membership.create({
        data: {
          userId: superUser.id,
          organizationId: organization.id,
          roleId: await getRoleId("super_user"),
        },
      });

      const result = await canManageMembership(
        superUser.id,
        organization.id,
        membership.id,
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.delete({
        where: { id: superUser.id },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies an Admin access to an unassigned Manager", async () => {
    const admin = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: admin.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
          adminMembershipId: null,
        },
      });

      const result = await canManageMembership(
        admin.id,
        organization.id,
        managerMembership.id,
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [admin.id, manager.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies a Manager access to a Member assigned to another Manager", async () => {
    const managerOne = await createTestUser();
    const managerTwo = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerRoleId = await getRoleId("manager");
      const memberRoleId = await getRoleId("member");

      const managerOneMembership = await prisma.membership.create({
        data: {
          userId: managerOne.id,
          organizationId: organization.id,
          roleId: managerRoleId,
        },
      });

      const managerTwoMembership = await prisma.membership.create({
        data: {
          userId: managerTwo.id,
          organizationId: organization.id,
          roleId: managerRoleId,
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: memberRoleId,
          managerMembershipId: managerTwoMembership.id,
        },
      });

      const result = await canManageMembership(
        managerOne.id,
        organization.id,
        memberMembership.id,
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: {
          id: { in: [managerOne.id, managerTwo.id, member.id] },
        },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies a Member from managing another membership", async () => {
    const memberOne = await createTestUser();
    const memberTwo = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const memberRoleId = await getRoleId("member");

      await prisma.membership.create({
        data: {
          userId: memberOne.id,
          organizationId: organization.id,
          roleId: memberRoleId,
        },
      });

      const targetMembership = await prisma.membership.create({
        data: {
          userId: memberTwo.id,
          organizationId: organization.id,
          roleId: memberRoleId,
        },
      });

      const result = await canManageMembership(
        memberOne.id,
        organization.id,
        targetMembership.id,
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [memberOne.id, memberTwo.id] } },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies an Admin from promoting a Manager to Admin", async () => {
    const admin = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const adminMembership = await prisma.membership.create({
        data: {
          userId: admin.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
          adminMembershipId: adminMembership.id,
        },
      });

      const result = await canChangeMembershipRole(
        admin.id,
        organization.id,
        managerMembership.id,
        "admin",
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [admin.id, manager.id] } },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows a Super User to promote a Manager to Admin", async () => {
    const superUser = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const superUserMembership = await prisma.membership.create({
        data: {
          userId: superUser.id,
          organizationId: organization.id,
          roleId: await getRoleId("super_user"),
        },
      });

      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
        },
      });

      const result = await canChangeMembershipRole(
        superUser.id,
        organization.id,
        managerMembership.id,
        "admin",
      );

      expect(result).toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [superUser.id, manager.id] } },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies a Super User from changing their own role", async () => {
    const superUser = await createTestUser();
    const target = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const superUserMembership = await prisma.membership.create({
        data: {
          userId: superUser.id,
          organizationId: organization.id,
          roleId: await getRoleId("super_user"),
        },
      });

      // The database permits only one Super User per organization.
      // Test the current Super User's own membership instead.
      const result = await canChangeMembershipRole(
        superUser.id,
        organization.id,
        superUserMembership.id,
        "admin",
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [superUser.id, target.id] } },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies a Manager from promoting a Member to Manager", async () => {
    const manager = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
          managerMembershipId: managerMembership.id,
        },
      });

      const result = await canChangeMembershipRole(
        manager.id,
        organization.id,
        memberMembership.id,
        "manager",
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });

      await prisma.user.deleteMany({
        where: { id: { in: [manager.id, member.id] } },
      });

      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows a Super User to promote a Member to Admin", async () => {
    const superUser = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: superUser.id,
          organizationId: organization.id,
          roleId: await getRoleId("super_user"),
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
        },
      });

      const result = await canChangeMembershipRole(
        superUser.id,
        organization.id,
        memberMembership.id,
        "admin",
      );

      expect(result).toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [superUser.id, member.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows an Admin to promote an in-scope Member to Manager", async () => {
    const admin = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const adminMembership = await prisma.membership.create({
        data: {
          userId: admin.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
        },
      });

      const result = await canChangeMembershipRole(
        admin.id,
        organization.id,
        memberMembership.id,
        "manager",
      );

      expect(result).toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [admin.id, member.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("allows an Admin to demote an in-scope Manager to Member", async () => {
    const admin = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const adminMembership = await prisma.membership.create({
        data: {
          userId: admin.id,
          organizationId: organization.id,
          roleId: await getRoleId("admin"),
        },
      });

      const managerMembership = await prisma.membership.create({
        data: {
          userId: manager.id,
          organizationId: organization.id,
          roleId: await getRoleId("manager"),
          adminMembershipId: adminMembership.id,
        },
      });

      const result = await canChangeMembershipRole(
        admin.id,
        organization.id,
        managerMembership.id,
        "member",
      );

      expect(result).toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [admin.id, manager.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies a role change to an invalid role code", async () => {
    const superUser = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: superUser.id,
          organizationId: organization.id,
          roleId: await getRoleId("super_user"),
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
        },
      });

      const result = await canChangeMembershipRole(
        superUser.id,
        organization.id,
        memberMembership.id,
        "invalid_role",
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [superUser.id, member.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("denies changing a Member's role to Member", async () => {
    const superUser = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    try {
      await prisma.membership.create({
        data: {
          userId: superUser.id,
          organizationId: organization.id,
          roleId: await getRoleId("super_user"),
        },
      });

      const memberMembership = await prisma.membership.create({
        data: {
          userId: member.id,
          organizationId: organization.id,
          roleId: await getRoleId("member"),
        },
      });

      const result = await canChangeMembershipRole(
        superUser.id,
        organization.id,
        memberMembership.id,
        "member",
      );

      expect(result).toBe(false);
    } finally {
      await prisma.membership.deleteMany({
        where: { organizationId: organization.id },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [superUser.id, member.id] } },
      });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });
});
