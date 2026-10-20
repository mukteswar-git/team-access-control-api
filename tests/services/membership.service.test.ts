import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import {
  changeMembershipRole,
  getMembershipDetails,
  listOrganizationMemberships,
  getOrganizationStructure,
  removeMembership,
  updateMembershipReportingAssignment,
} from "../../src/services/membership.service.js";

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

  test("allows a Member to read membership details in their organization", async () => {
    const actor = await createTestUser();
    const target = await createTestUser();
    const organization = await createTestOrganization();

    await createMembership(actor.id, organization.id, "member");
    const targetMembership = await createMembership(
      target.id,
      organization.id,
      "manager",
    );

    const result = await getMembershipDetails(
      actor.id,
      organization.id,
      targetMembership.id,
      prisma,
    );

    expect(result.id).toBe(targetMembership.id);
    expect(result.organizationId).toBe(organization.id);
    expect(result.user.email).toBe(target.email);
    expect(result.role.code).toBe("manager");
  });

  test("denies membership reads when the actor has no membership in the organization", async () => {
    const actor = await createTestUser();
    const organization = await createTestOrganization();

    await expect(
      listOrganizationMemberships(actor.id, organization.id, prisma),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  test("does not reveal a membership from another organization", async () => {
    const actor = await createTestUser();
    const target = await createTestUser();
    const organizationA = await createTestOrganization();
    const organizationB = await createTestOrganization();

    await createMembership(actor.id, organizationA.id, "member");
    const targetMembership = await createMembership(
      target.id,
      organizationB.id,
      "member",
    );

    await expect(
      getMembershipDetails(
        actor.id,
        organizationA.id,
        targetMembership.id,
        prisma,
      ),
    ).rejects.toMatchObject({
      code: "MEMBERSHIP_NOT_FOUND",
    });
  });

  test("lists only memberships belonging to the requested organization", async () => {
    const actor = await createTestUser();
    const targetA = await createTestUser();
    const targetB = await createTestUser();
    const organizationA = await createTestOrganization();
    const organizationB = await createTestOrganization();

    await createMembership(actor.id, organizationA.id, "member");
    const membershipA = await createMembership(
      targetA.id,
      organizationA.id,
      "admin",
    );
    await createMembership(targetB.id, organizationB.id, "member");

    const result = await listOrganizationMemberships(
      actor.id,
      organizationA.id,
      prisma,
    );

    expect(result.map((membership) => membership.id)).toEqual(
      expect.arrayContaining([membershipA.id]),
    );
    expect(
      result.every(
        (membership) => membership.organizationId === organizationA.id,
      ),
    ).toBe(true);
  });

  test("returns organization structure with reporting relationships and member counts", async () => {
    const actor = await createTestUser();
    const admin = await createTestUser();
    const manager = await createTestUser();
    const unassignedManager = await createTestUser();
    const assignedMemberA = await createTestUser();
    const assignedMemberB = await createTestUser();
    const unassignedMember = await createTestUser();
    const organization = await createTestOrganization();

    await createMembership(actor.id, organization.id, "member");

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

    await createMembership(unassignedManager.id, organization.id, "manager");

    const memberMembershipA = await createMembership(
      assignedMemberA.id,
      organization.id,
      "member",
      { managerMembershipId: managerMembership.id },
    );

    const memberMembershipB = await createMembership(
      assignedMemberB.id,
      organization.id,
      "member",
      { managerMembershipId: managerMembership.id },
    );

    const unassignedMemberMembership = await createMembership(
      unassignedMember.id,
      organization.id,
      "member",
    );

    const result = await getOrganizationStructure(
      actor.id,
      organization.id,
      prisma,
    );

    expect(result.counts).toEqual({
      total: 7,
      superUsers: 0,
      admins: 1,
      managers: 2,
      members: 4,
    });

    expect(result.admins.map((membership) => membership.id)).toContain(
      adminMembership.id,
    );

    const managerResult = result.managers.find(
      (membership) => membership.id === managerMembership.id,
    );

    expect(managerResult).toMatchObject({
      adminMembershipId: adminMembership.id,
      memberCount: 2,
    });

    const unassignedManagerMembership = result.managers.find(
      (membership) => membership.adminMembershipId === null,
    );

    expect(unassignedManagerMembership).toMatchObject({
      id: expect.any(String),
      memberCount: 0,
    });

    expect(result.members.map((membership) => membership.id)).toEqual(
      expect.arrayContaining([
        memberMembershipA.id,
        memberMembershipB.id,
        unassignedMemberMembership.id,
      ]),
    );

    expect(
      result.members.filter(
        (membership) => membership.managerMembershipId === managerMembership.id,
      ),
    ).toHaveLength(2);

    expect(
      result.members
        .filter((membership) => membership.managerMembershipId === null)
        .map((membership) => membership.id),
    ).toContain(unassignedMemberMembership.id);

    expect(result.superUsers).toHaveLength(0);
  });

  test("allows a Super User to assign a Manager to an Admin and audits the change", async () => {
    const superUser = await createTestUser();
    const admin = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    const superUserMembership = await createMembership(
      superUser.id,
      organization.id,
      "super_user",
    );

    const adminMembership = await createMembership(
      admin.id,
      organization.id,
      "admin",
    );

    const managerMembership = await createMembership(
      manager.id,
      organization.id,
      "manager",
    );

    const result = await updateMembershipReportingAssignment(
      superUser.id,
      organization.id,
      managerMembership.id,
      {
        role: "manager",
        adminMembershipId: adminMembership.id,
      },
      prisma,
    );

    expect(result.adminMembershipId).toBe(adminMembership.id);
    expect(result.managerMembershipId).toBeNull();

    const audit = await prisma.auditLog.findMany({
      where: {
        organizationId: organization.id,
        action: "membership.reporting_assignment_changed",
        targetId: managerMembership.id,
      },
    });

    expect(audit).toHaveLength(1);
    expect(audit[0].actorMembershipId).toBe(superUserMembership.id);
    expect(audit[0].result).toBe("success");
  });

  test("rejects assigning a Manager to an Admin in another organization", async () => {
    const superUser = await createTestUser();
    const manager = await createTestUser();
    const admin = await createTestUser();
    const organization = await createTestOrganization();
    const otherOrganization = await createTestOrganization();

    await createMembership(superUser.id, organization.id, "super_user");

    const managerMembership = await createMembership(
      manager.id,
      organization.id,
      "manager",
    );

    const otherAdminMembership = await createMembership(
      admin.id,
      otherOrganization.id,
      "admin",
    );

    await expect(
      updateMembershipReportingAssignment(
        superUser.id,
        organization.id,
        managerMembership.id,
        {
          role: "manager",
          adminMembershipId: otherAdminMembership.id,
        },
        prisma,
      ),
    ).rejects.toThrow(
      "Reporting assignment must reference a admin in the same organization.",
    );

    const unchanged = await prisma.membership.findUniqueOrThrow({
      where: { id: managerMembership.id },
    });

    expect(unchanged.adminMembershipId).toBeNull();

    const audit = await prisma.auditLog.findMany({
      where: {
        organizationId: organization.id,
        action: "membership.reporting_assignment_changed",
        targetId: managerMembership.id,
      },
    });

    expect(audit).toHaveLength(0);
  });

  test("rejects assigning a Member to a membership that is not a Manager", async () => {
    const superUser = await createTestUser();
    const admin = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    await createMembership(superUser.id, organization.id, "super_user");

    const adminMembership = await createMembership(
      admin.id,
      organization.id,
      "admin",
    );

    const memberMembership = await createMembership(
      member.id,
      organization.id,
      "member",
    );

    await expect(
      updateMembershipReportingAssignment(
        superUser.id,
        organization.id,
        memberMembership.id,
        {
          role: "member",
          managerMembershipId: adminMembership.id,
        },
        prisma,
      ),
    ).rejects.toThrow(
      "Reporting assignment must reference a manager in the same organization.",
    );

    const unchanged = await prisma.membership.findUniqueOrThrow({
      where: { id: memberMembership.id },
    });

    expect(unchanged.managerMembershipId).toBeNull();
  });

  test("rejects a Manager attempting to reassign another Manager's Member", async () => {
    const managerA = await createTestUser();
    const managerB = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    const managerAMembership = await createMembership(
      managerA.id,
      organization.id,
      "manager",
    );

    const managerBMembership = await createMembership(
      managerB.id,
      organization.id,
      "manager",
    );

    const memberMembership = await createMembership(
      member.id,
      organization.id,
      "member",
      { managerMembershipId: managerBMembership.id },
    );

    await expect(
      updateMembershipReportingAssignment(
        managerA.id,
        organization.id,
        memberMembership.id,
        {
          role: "member",
          managerMembershipId: managerAMembership.id,
        },
        prisma,
      ),
    ).rejects.toThrow("Not authorized to update this reporting assignment.");

    const unchanged = await prisma.membership.findUniqueOrThrow({
      where: { id: memberMembership.id },
    });

    expect(unchanged.managerMembershipId).toBe(managerBMembership.id);
  });

  it("allows an Admin to move an assigned Manager to another Admin and audits the change", async () => {
    const organization = await createTestOrganization();

    const adminAUser = await createTestUser();
    const adminBUser = await createTestUser();
    const managerUser = await createTestUser();

    const adminA = await createMembership(
      adminAUser.id,
      organization.id,
      "admin",
    );

    const adminB = await createMembership(
      adminBUser.id,
      organization.id,
      "admin",
    );

    const manager = await createMembership(
      managerUser.id,
      organization.id,
      "manager",
      { adminMembershipId: adminA.id },
    );

    await updateMembershipReportingAssignment(
      adminAUser.id,
      organization.id,
      manager.id,
      {
        role: "manager",
        adminMembershipId: adminB.id,
      },
    );

    const updatedManager = await prisma.membership.findUniqueOrThrow({
      where: { id: manager.id },
    });

    expect(updatedManager.adminMembershipId).toBe(adminB.id);

    const auditLog = await prisma.auditLog.findFirst({
      where: {
        action: "membership.reporting_assignment_changed",
        targetId: manager.id,
      },
    });

    expect(auditLog).not.toBeNull();
  });

  test("allows a Super User to remove a Member and records an audit log", async () => {
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

    const result = await removeMembership(
      superUser.id,
      organization.id,
      memberMembership.id,
      prisma,
    );

    expect(result).toEqual({
      membershipId: memberMembership.id,
      removedRole: "member",
    });

    expect(
      await prisma.membership.findUnique({
        where: { id: memberMembership.id },
      }),
    ).toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: {
        organizationId: organization.id,
        action: "membership.removed",
        targetId: memberMembership.id,
      },
    });

    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(superUser.id);
    expect(audit?.actorMembershipId).toBe(superUserMembership.id);
    expect(audit?.result).toBe("success");
    expect(audit?.metadata).toEqual({ removedRole: "member" });
  });

  test("rejects removal of a Super User membership", async () => {
    const superUser = await createTestUser();
    const organization = await createTestOrganization();

    const superUserMembership = await createMembership(
      superUser.id,
      organization.id,
      "super_user",
    );

    await expect(
      removeMembership(
        superUser.id,
        organization.id,
        superUserMembership.id,
        prisma,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(
      await prisma.membership.findUnique({
        where: { id: superUserMembership.id },
      }),
    ).not.toBeNull();
  });

  test("rejects removal by a Manager who does not manage the target Member", async () => {
    const manager = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();

    await createMembership(manager.id, organization.id, "manager");
    const memberMembership = await createMembership(
      member.id,
      organization.id,
      "member",
    );

    await expect(
      removeMembership(
        manager.id,
        organization.id,
        memberMembership.id,
        prisma,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(
      await prisma.membership.findUnique({
        where: { id: memberMembership.id },
      }),
    ).not.toBeNull();
  });

  test("treats a membership in another organization as not found", async () => {
    const superUser = await createTestUser();
    const member = await createTestUser();
    const organization = await createTestOrganization();
    const otherOrganization = await createTestOrganization();

    await createMembership(superUser.id, organization.id, "super_user");
    const memberMembership = await createMembership(
      member.id,
      otherOrganization.id,
      "member",
    );

    await expect(
      removeMembership(
        superUser.id,
        organization.id,
        memberMembership.id,
        prisma,
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_NOT_FOUND" });

    expect(
      await prisma.membership.findUnique({
        where: { id: memberMembership.id },
      }),
    ).not.toBeNull();
  });

  test("unassigns a Manager's Members when removing that Manager", async () => {
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

    await removeMembership(
      superUser.id,
      organization.id,
      managerMembership.id,
      prisma,
    );

    const updatedMember = await prisma.membership.findUniqueOrThrow({
      where: { id: memberMembership.id },
    });

    expect(updatedMember.managerMembershipId).toBeNull();
    expect(
      await prisma.membership.findUnique({
        where: { id: managerMembership.id },
      }),
    ).toBeNull();
  });

  test("unassigns a Manager from pending invitations when removing that Manager", async () => {
    const superUser = await createTestUser();
    const manager = await createTestUser();
    const organization = await createTestOrganization();

    await createMembership(superUser.id, organization.id, "super_user");
    const managerMembership = await createMembership(
      manager.id,
      organization.id,
      "manager",
    );

    const invitation = await prisma.invitation.create({
      data: {
        organizationId: organization.id,
        invitedEmail: `invite-${randomUUID()}@example.com`,
        roleId: await getRoleId("member"),
        managerMembershipId: managerMembership.id,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        createdByMembershipId: managerMembership.id,
      },
    });

    await removeMembership(
      superUser.id,
      organization.id,
      managerMembership.id,
      prisma,
    );

    const updatedInvitation = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });

    expect(updatedInvitation.managerMembershipId).toBeNull();
    expect(updatedInvitation.revokedAt).not.toBeNull();
    expect(updatedInvitation.createdByMembershipId).toBeNull();
  });

  test("rolls back membership removal when audit creation fails", async () => {
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

    // The membership deletion and reassignment must both roll back.
    expect(
      await prisma.membership.findUnique({
        where: { id: managerMembership.id },
      }),
    ).not.toBeNull();

    const updatedMember = await prisma.membership.findUniqueOrThrow({
      where: { id: memberMembership.id },
    });

    expect(updatedMember.managerMembershipId).toBe(managerMembership.id);
  });
});
