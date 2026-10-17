import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import {
  findMembershipById,
  findMembershipByUserAndOrganization,
  findMembershipsByOrganizationId,
  findMembershipsByUserId,
} from "../../src/repositories/membership.repository.js";

describe("Membership repository", () => {
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

  async function getRoleId() {
    const role = await prisma.role.findFirst();

    if (!role) {
      throw new Error(
        "No roles found. Ensure the test database has been seeded.",
      );
    }

    return role.id;
  }

  afterAll(async () => {
    await disconnectTestDatabase();
  });

  test("finds a membership by ID with related records", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();
    const roleId = await getRoleId();

    try {
      const membership = await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId,
        },
      });

      const result = await findMembershipById(membership.id);

      expect(result?.id).toBe(membership.id);
      expect(result?.user.id).toBe(user.id);
      expect(result?.organization.id).toBe(organization.id);
      expect(result?.role.id).toBe(roleId);
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

  test("returns null when a membership does not exist", async () => {
    const result = await findMembershipById(randomUUID());

    expect(result).toBeNull();
  });

  test("finds a membership by user ID and organization ID", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();
    const roleId = await getRoleId();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId,
        },
      });

      const result = await findMembershipByUserAndOrganization(
        user.id,
        organization.id,
      );

      expect(result?.userId).toBe(user.id);
      expect(result?.organizationId).toBe(organization.id);
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

  test("returns null when the user has no membership in the organization", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();

    try {
      const result = await findMembershipByUserAndOrganization(
        user.id,
        organization.id,
      );

      expect(result).toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("lists only memberships belonging to the requested organization", async () => {
    const user = await createTestUser();
    const organizationA = await createTestOrganization();
    const organizationB = await createTestOrganization();
    const roleId = await getRoleId();

    try {
      const membershipA = await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organizationA.id,
          roleId,
        },
      });

      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organizationB.id,
          roleId,
        },
      });

      const results = await findMembershipsByOrganizationId(organizationA.id);

      expect(results.map((membership) => membership.id)).toContain(
        membershipA.id,
      );
      expect(
        results.every(
          (membership) => membership.organizationId === organizationA.id,
        ),
      ).toBe(true);
    } finally {
      await prisma.membership.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.organization.deleteMany({
        where: { id: { in: [organizationA.id, organizationB.id] } },
      });
    }
  });

  test("lists a user's memberships across multiple organizations", async () => {
    const user = await createTestUser();
    const organizationA = await createTestOrganization();
    const organizationB = await createTestOrganization();
    const roleId = await getRoleId();

    try {
      await prisma.membership.createMany({
        data: [
          {
            userId: user.id,
            organizationId: organizationA.id,
            roleId,
          },
          {
            userId: user.id,
            organizationId: organizationB.id,
            roleId,
          },
        ],
      });

      const results = await findMembershipsByUserId(user.id);

      expect(results).toHaveLength(2);
      expect(
        results.map((membership) => membership.organizationId).sort(),
      ).toEqual([organizationA.id, organizationB.id].sort());
    } finally {
      await prisma.membership.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.organization.deleteMany({
        where: { id: { in: [organizationA.id, organizationB.id] } },
      });
    }
  });

  test("returns an empty list when an organization has no memberships", async () => {
    const organization = await createTestOrganization();

    try {
      const results = await findMembershipsByOrganizationId(organization.id);

      expect(results).toEqual([]);
    } finally {
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("rejects duplicate memberships for the same user and organization", async () => {
    const user = await createTestUser();
    const organization = await createTestOrganization();
    const roleId = await getRoleId();

    try {
      await prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          roleId,
        },
      });

      await expect(
        prisma.membership.create({
          data: {
            userId: user.id,
            organizationId: organization.id,
            roleId,
          },
        }),
      ).rejects.toMatchObject({
        code: "P2002",
      });
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
});
