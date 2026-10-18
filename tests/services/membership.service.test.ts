import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import { changeMembershipRole } from "../../src/services/membership.service.js";

describe("Membership service", () => {
  afterAll(async () => {
    await disconnectTestDatabase();
  });

  async function createTestUser() {
    return prisma.user.create({
      data: {
        email: `membership-${randomUUID()}@example.com`,
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
      throw new Error(`Role "${code}" not found. Seed the test database.`);
    }

    return role.id;
  }

  async function createMembership(
    userId: string,
    organizationId: string,
    roleCode: string,
    assignments: {
      adminMembershipId?: string | null;
      managerMembershipId?: string | null;
    } = {},
  ) {
    return prisma.membership.create({
      data: {
        userId,
        organizationId,
        roleId: await getRoleId(roleCode),
        ...assignments,
      },
    });
  }

  async function getMembershipRole(membershipId: string) {
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { id: membershipId },
      include: { role: true },
    });

    return membership.role.code;
  }

  async function getRoleChangeAuditLogs(
    organizationId: string,
    targetMembershipId: string,
  ) {
    return prisma.auditLog.findMany({
      where: {
        organizationId,
        action: "membership.role_changed",
        targetType: "membership",
        targetId: targetMembershipId,
      },
    });
  }

  test("allows a Super User to promote a Member to Admin and records an audit log", async () => {
    const superUser = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    const superUserMembership = await createMembership(
      superUser.id,
      organization.id,
      "super_user",
    );

    const memberMembership = await createMembership(
      member.id,
      organization.id,
      "member",
    );

    const result = await changeMembershipRole(
      superUser.id,
      organization.id,
      memberMembership.id,
      "admin",
      prisma,
    );

    expect(result).toEqual({
      membershipId: memberMembership.id,
      previousRole: "member",
      newRole: "admin",
    });

    expect(await getMembershipRole(memberMembership.id)).toBe("admin");

    const auditLogs = await getRoleChangeAuditLogs(
      organization.id,
      memberMembership.id,
    );

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].actorUserId).toBe(superUser.id);
    expect(auditLogs[0].actorMembershipId).toBe(superUserMembership.id);
    expect(auditLogs[0].result).toBe("success");
    expect(auditLogs[0].metadata).toEqual({
      previousRole: "member",
      newRole: "admin",
    });
  });

  test("rejects a Manager attempting to change a Member's role", async () => {
    const manager = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    const managerMembership = await createMembership(
      manager.id,
      organization.id,
      "manager",
    );

    const memberMembership = await createMembership(
      member.id,
      organization.id,
      "member",
      { managerMembershipId: managerMembership.id },
    );

    await expect(
      changeMembershipRole(
        manager.id,
        organization.id,
        memberMembership.id,
        "manager",
        prisma,
      ),
    ).rejects.toThrow("Not authorized to change this membership's role.");

    expect(await getMembershipRole(memberMembership.id)).toBe("member");

    expect(
      await getRoleChangeAuditLogs(organization.id, memberMembership.id),
    ).toHaveLength(0);
  });

  test("unassigns a Manager's Members when a Super User changes that Manager to Admin", async () => {
    const superUser = await createTestUser();
    const manager = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    const superUserMembership = await createMembership(
      superUser.id,
      organization.id,
      "super_user",
    );

    const managerMembership = await createMembership(
      manager.id,
      organization.id,
      "manager",
    );

    const memberMembership = await createMembership(
      member.id,
      organization.id,
      "member",
      { managerMembershipId: managerMembership.id },
    );

    await changeMembershipRole(
      superUser.id,
      organization.id,
      managerMembership.id,
      "admin",
      prisma,
    );

    const updatedManager = await prisma.membership.findUniqueOrThrow({
      where: { id: managerMembership.id },
    });

    const updatedMember = await prisma.membership.findUniqueOrThrow({
      where: { id: memberMembership.id },
    });

    expect(await getMembershipRole(managerMembership.id)).toBe("admin");
    expect(updatedManager.adminMembershipId).toBeNull();
    expect(updatedManager.managerMembershipId).toBeNull();
    expect(updatedMember.managerMembershipId).toBeNull();

    const auditLogs = await getRoleChangeAuditLogs(
      organization.id,
      managerMembership.id,
    );

    expect(auditLogs).toHaveLength(1);
    expect(auditLogs[0].actorMembershipId).toBe(superUserMembership.id);
    expect(auditLogs[0].metadata).toEqual({
      previousRole: "manager",
      newRole: "admin",
    });
  });

  test("unassigns Managers from an Admin when a Super User changes that Admin to Manager", async () => {
    const superUser = await createTestUser();
    const admin = await createTestUser();
    const manager = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    await createMembership(superUser.id, organization.id, "super_user");

    const adminMembership = await createMembership(
      admin.id,
      organization.id,
      "admin",
    );

    const managerMembership = await createMembership(
      manager.id,
      organization.id,
      "manager",
      { adminMembershipId: adminMembership.id },
    );

    const memberMembership = await createMembership(
      member.id,
      organization.id,
      "member",
      { managerMembershipId: managerMembership.id },
    );

    await changeMembershipRole(
      superUser.id,
      organization.id,
      adminMembership.id,
      "manager",
      prisma,
    );

    const updatedManager = await prisma.membership.findUniqueOrThrow({
      where: { id: managerMembership.id },
    });

    expect(await getMembershipRole(adminMembership.id)).toBe("manager");
    expect(updatedManager.adminMembershipId).toBeNull();

    // The Manager keeps their own Member assignment.
    expect(updatedManager.managerMembershipId).toBeNull();

    const unchangedMember = await prisma.membership.findUniqueOrThrow({
      where: { id: memberMembership.id },
    });

    expect(unchangedMember.managerMembershipId).toBe(managerMembership.id);
  });

  test("unassigns a Manager's Members when a Super User changes that Manager to Member", async () => {
    const superUser = await createTestUser();
    const manager = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    await createMembership(superUser.id, organization.id, "super_user");

    const managerMembership = await createMembership(
      manager.id,
      organization.id,
      "manager",
    );

    const memberMembership = await createMembership(
      member.id,
      organization.id,
      "member",
      { managerMembershipId: managerMembership.id },
    );

    await changeMembershipRole(
      superUser.id,
      organization.id,
      managerMembership.id,
      "member",
      prisma,
    );

    const updatedManager = await prisma.membership.findUniqueOrThrow({
      where: { id: managerMembership.id },
    });

    const updatedMember = await prisma.membership.findUniqueOrThrow({
      where: { id: memberMembership.id },
    });

    expect(await getMembershipRole(managerMembership.id)).toBe("member");
    expect(updatedManager.adminMembershipId).toBeNull();
    expect(updatedManager.managerMembershipId).toBeNull();
    expect(updatedMember.managerMembershipId).toBeNull();
  });

  test("rejects an attempt to promote another membership to Super User", async () => {
    const superUser = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    await createMembership(superUser.id, organization.id, "super_user");

    const memberMembership = await createMembership(
      member.id,
      organization.id,
      "member",
    );

    await expect(
      changeMembershipRole(
        superUser.id,
        organization.id,
        memberMembership.id,
        "super_user",
        prisma,
      ),
    ).rejects.toThrow("Not authorized to change this membership's role.");

    expect(await getMembershipRole(memberMembership.id)).toBe("member");

    expect(
      await getRoleChangeAuditLogs(organization.id, memberMembership.id),
    ).toHaveLength(0);
  });

  test("rejects a user attempting to change their own role", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    const membership = await createMembership(
      user.id,
      organization.id,
      "super_user",
    );

    await expect(
      changeMembershipRole(
        user.id,
        organization.id,
        membership.id,
        "admin",
        prisma,
      ),
    ).rejects.toThrow("Not authorized to change this membership's role.");

    expect(await getMembershipRole(membership.id)).toBe("super_user");

    expect(
      await getRoleChangeAuditLogs(organization.id, membership.id),
    ).toHaveLength(0);
  });

  test("rejects an invalid role without changing the membership", async () => {
    const superUser = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    await createMembership(superUser.id, organization.id, "super_user");

    const memberMembership = await createMembership(
      member.id,
      organization.id,
      "member",
    );

    await expect(
      changeMembershipRole(
        superUser.id,
        organization.id,
        memberMembership.id,
        "invalid_role",
        prisma,
      ),
    ).rejects.toThrow("Invalid role.");

    expect(await getMembershipRole(memberMembership.id)).toBe("member");

    expect(
      await getRoleChangeAuditLogs(organization.id, memberMembership.id),
    ).toHaveLength(0);
  });

  test("rejects a role change for a membership that does not exist in the organization", async () => {
    const superUser = await createTestUser();
    const organization = await createTestOrganization();

    await createMembership(superUser.id, organization.id, "super_user");

    await expect(
      changeMembershipRole(
        superUser.id,
        organization.id,
        randomUUID(),
        "admin",
        prisma,
      ),
    ).rejects.toThrow("Membership not found.");
  });
});
