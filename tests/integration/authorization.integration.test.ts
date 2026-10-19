import express from "express";
import request from "supertest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { env } from "../../src/config/env.js";
import { requireAuth } from "../../src/middleware/require-auth.js";
import { requireOrganizationMembership } from "../../src/middleware/require-organization-membership.js";
import { requirePermission } from "../../src/middleware/require-permission.js";
import { requireMembershipAction } from "../../src/middleware/require-membership-action.js";
import errorHandler from "../../src/middleware/error-handler.js";
import { prisma as appPrisma } from "../../src/lib/prisma.js";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

type RoleCode = "super_user" | "admin" | "manager" | "member";

type TestUser = {
  id: string;
  token: string;
};

type TestMembership = {
  id: string;
  userId: string;
};

describe("Authorization integration", () => {
  let organizationA: { id: string };
  let organizationB: { id: string };
  let roles: Record<RoleCode, string>;
  const createdUserIds: string[] = [];
  const createdOrganizationIds: string[] = [];

  async function createUser(): Promise<TestUser> {
    const user = await prisma.user.create({
      data: {
        email: `authorization-integration-${randomUUID()}@example.com`,
        passwordHash: "integration-test-hash",
        emailVerifiedAt: new Date(),
      },
    });

    createdUserIds.push(user.id);

    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    return { id: user.id, token };
  }

  async function createOrganization() {
    const organization = await prisma.organization.create({
      data: { name: `Integration ${randomUUID()}` },
    });

    createdOrganizationIds.push(organization.id);
    return organization;
  }

  async function createMembership(
    userId: string,
    organizationId: string,
    roleCode: RoleCode,
    reporting: {
      adminMembershipId?: string;
      managerMembershipId?: string;
    } = {},
  ): Promise<TestMembership> {
    const membership = await prisma.membership.create({
      data: {
        userId,
        organizationId,
        roleId: roles[roleCode],
        adminMembershipId: reporting.adminMembershipId,
        managerMembershipId: reporting.managerMembershipId,
      },
    });

    return { id: membership.id, userId: membership.userId };
  }

  function createApp() {
    const app = express();

    app.delete(
      "/organizations/:organizationId/memberships/:membershipId",
      requireAuth,
      requireMembershipAction("membership.remove"),
      async (req, res, next) => {
        try {
          const { membershipId, organizationId } = req.params;

          if (
            typeof membershipId !== "string" ||
            typeof organizationId !== "string"
          ) {
            res.status(400).json({
              error: {
                code: "INVALID_INPUT",
                message: "Invalid route parameters",
              },
            });
            return;
          }

          const deleted = await prisma.membership.deleteMany({
            where: {
              id: membershipId,
              organizationId,
            },
          });

          if (deleted.count !== 1) {
            res.status(404).json({
              error: {
                code: "NOT_FOUND",
                message: "Membership not found",
              },
            });
            return;
          }

          res.sendStatus(204);
        } catch (error) {
          next(error);
        }
      },
    );

    app.get(
      "/organizations/:organizationId/memberships",
      requireAuth,
      requireOrganizationMembership,
      requirePermission("membership.read"),
      (_req, res) => {
        res.sendStatus(200);
      },
    );

    app.use(errorHandler);
    return app;
  }

  let app: express.Express;

  beforeAll(async () => {
    const roleRecords = await prisma.role.findMany({
      where: {
        code: { in: ["super_user", "admin", "manager", "member"] },
      },
    });

    roles = Object.fromEntries(
      roleRecords.map((role) => [role.code, role.id]),
    ) as Record<RoleCode, string>;

    for (const roleCode of [
      "super_user",
      "admin",
      "manager",
      "member",
    ] as const) {
      if (!roles[roleCode]) {
        throw new Error(`Missing seeded role: ${roleCode}`);
      }
    }

    organizationA = await createOrganization();
    organizationB = await createOrganization();
    app = createApp();
  });

  afterAll(async () => {
    if (createdOrganizationIds.length > 0) {
      await prisma.auditLog.deleteMany({
        where: { organizationId: { in: createdOrganizationIds } },
      });

      await prisma.invitation.deleteMany({
        where: { organizationId: { in: createdOrganizationIds } },
      });

      await prisma.membership.deleteMany({
        where: { organizationId: { in: createdOrganizationIds } },
      });
    }

    if (createdUserIds.length > 0) {
      await prisma.session.deleteMany({
        where: { userId: { in: createdUserIds } },
      });

      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }

    await prisma.organization.deleteMany({
      where: { id: { in: createdOrganizationIds } },
    });

    await Promise.all([prisma.$disconnect(), appPrisma.$disconnect()]);
  });

  test("allows a member to access an organization they belong to when the permission is granted", async () => {
    const user = await createUser();

    await createMembership(user.id, organizationA.id, "member");

    const response = await request(app)
      .get(`/organizations/${organizationA.id}/memberships`)
      .set("Authorization", `Bearer ${user.token}`);

    expect(response.status).toBe(200);
  });

  test("denies a user without membership in the requested organization", async () => {
    const user = await createUser();

    await createMembership(user.id, organizationA.id, "member");

    const response = await request(app)
      .get(`/organizations/${organizationB.id}/memberships`)
      .set("Authorization", `Bearer ${user.token}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  test("allows a manager to remove a member within their reporting scope", async () => {
    const managerUser = await createUser();
    const manager = await createMembership(
      managerUser.id,
      organizationA.id,
      "manager",
    );

    const targetUser = await createUser();
    const target = await createMembership(
      targetUser.id,
      organizationA.id,
      "member",
      { managerMembershipId: manager.id },
    );

    const response = await request(app)
      .delete(`/organizations/${organizationA.id}/memberships/${target.id}`)
      .set("Authorization", `Bearer ${managerUser.token}`);

    expect(response.status).toBe(204);

    expect(
      await prisma.membership.findUnique({
        where: { id: target.id },
      }),
    ).toBeNull();
  });

  test.each([
    ["super_user", true],
    ["admin", true],
    ["member", false],
  ] as const)(
    "applies the membership.remove permission mapping for %s",
    async (roleCode, hasPermission) => {
      const user = await createUser();
      const actor = await createMembership(user.id, organizationA.id, roleCode);

      const targetUser = await createUser();
      const target = await createMembership(
        targetUser.id,
        organizationA.id,
        "member",
      );

      const response = await request(app)
        .delete(`/organizations/${organizationA.id}/memberships/${target.id}`)
        .set("Authorization", `Bearer ${user.token}`);

      // Managers have the permission, but can only manage directly assigned
      // members. The target here is unassigned.
      const shouldSucceed = roleCode === "super_user" || roleCode === "admin";

      expect(response.status).toBe(shouldSucceed ? 204 : 403);

      const persistedTarget = await prisma.membership.findUnique({
        where: { id: target.id },
      });

      expect(persistedTarget !== null).toBe(!shouldSucceed);
      expect(hasPermission).toBe(roleCode !== "member");

      // The actor must still exist unless the target was accidentally used.
      expect(
        await prisma.membership.findUnique({ where: { id: actor.id } }),
      ).not.toBeNull();
    },
  );

  test("denies a manager access to a member outside their reporting scope without changing the target", async () => {
    const managerUser = await createUser();
    const manager = await createMembership(
      managerUser.id,
      organizationA.id,
      "manager",
    );

    const targetUser = await createUser();
    const target = await createMembership(
      targetUser.id,
      organizationA.id,
      "member",
    );

    const before = await prisma.membership.findUniqueOrThrow({
      where: { id: target.id },
    });

    const response = await request(app)
      .delete(`/organizations/${organizationA.id}/memberships/${target.id}`)
      .set("Authorization", `Bearer ${managerUser.token}`);

    expect(response.status).toBe(403);

    const after = await prisma.membership.findUniqueOrThrow({
      where: { id: target.id },
    });

    expect(after).toEqual(before);
    expect(manager.id).not.toBe(target.id);
  });

  test("denies an admin access to another admin's manager", async () => {
    const adminAUser = await createUser();
    const adminA = await createMembership(
      adminAUser.id,
      organizationA.id,
      "admin",
    );

    const adminBUser = await createUser();
    const adminB = await createMembership(
      adminBUser.id,
      organizationA.id,
      "admin",
    );

    const managerUser = await createUser();
    const manager = await createMembership(
      managerUser.id,
      organizationA.id,
      "manager",
      { adminMembershipId: adminB.id },
    );

    const response = await request(app)
      .delete(`/organizations/${organizationA.id}/memberships/${manager.id}`)
      .set("Authorization", `Bearer ${adminAUser.token}`);

    expect(response.status).toBe(403);
    expect(
      await prisma.membership.findUnique({ where: { id: manager.id } }),
    ).not.toBeNull();
    expect(adminA.id).not.toBe(adminB.id);
  });

  test("denies access to a membership belonging to another organization", async () => {
    const actorUser = await createUser();
    await createMembership(actorUser.id, organizationA.id, "admin");

    const foreignUser = await createUser();
    const foreignTarget = await createMembership(
      foreignUser.id,
      organizationB.id,
      "member",
    );

    const response = await request(app)
      .delete(
        `/organizations/${organizationA.id}/memberships/${foreignTarget.id}`,
      )
      .set("Authorization", `Bearer ${actorUser.token}`);

    expect(response.status).toBe(403);
    expect(
      await prisma.membership.findUnique({
        where: { id: foreignTarget.id },
      }),
    ).not.toBeNull();
  });

  test("rejects missing and invalid bearer tokens", async () => {
    const missing = await request(app).get(
      `/organizations/${organizationA.id}/memberships`,
    );

    const invalid = await request(app)
      .get(`/organizations/${organizationA.id}/memberships`)
      .set("Authorization", "Bearer invalid-token");

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });
});
