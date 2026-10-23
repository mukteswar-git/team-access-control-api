import { afterAll, describe, expect, test } from "@jest/globals";
import request from "supertest";
import argon2 from "argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../../helpers/database.js";

const { default: app } = await import("../../../src/app.js");

async function createAuthenticatedUser() {
  const email = `organization-test-${randomUUID()}@example.com`;
  const sessionToken = randomBytes(32).toString("hex");

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await argon2.hash("Strong-test-password-123", {
        type: argon2.argon2id,
      }),
      emailVerifiedAt: new Date(),
    },
  });

  try {
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  } catch (error) {
    await prisma.user.delete({ where: { id: user.id } });
    throw error;
  }

  return { user, sessionToken };
}

async function cleanupOrganization(organizationId: string) {
  await prisma.$executeRaw`
    ALTER TABLE "audit_logs" DISABLE TRIGGER "audit_logs_append_only"
  `;

  try {
    await prisma.auditLog.deleteMany({
      where: { organizationId },
    });
  } finally {
    await prisma.$executeRaw`
      ALTER TABLE "audit_logs" ENABLE TRIGGER "audit_logs_append_only"
    `;
  }

  await prisma.membership.deleteMany({
    where: { organizationId },
  });

  await prisma.organization.deleteMany({
    where: { id: organizationId },
  });
}

async function createMembership(
  organizationId: string,
  userId: string,
  roleCode: string,
  reporting: {
    adminMembershipId?: string | null;
    managerMembershipId?: string | null;
  } = {},
) {
  const role = await prisma.role.findUnique({
    where: { code: roleCode },
  });

  if (!role) {
    throw new Error(`Role "${roleCode}" is missing from the test database`);
  }

  return prisma.membership.create({
    data: {
      organizationId,
      userId,
      roleId: role.id,
      ...reporting,
    },
  });
}

afterAll(async () => {
  await disconnectTestDatabase();
});

describe("POST /organizations", () => {
  test("rejects a request without authentication", async () => {
    const response = await request(app)
      .post("/organizations")
      .send({ name: "Test organization" });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("rejects an invalid request body", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();

    try {
      const response = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ name: "" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await prisma.session.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("creates an organization with an initial Super User membership", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    const organizationName = `Test organization ${randomUUID()}`;
    let organizationId: string | undefined;

    try {
      const response = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ name: `  ${organizationName}  ` });

      expect(response.status).toBe(201);
      expect(response.body.organization.name).toBe(organizationName);

      organizationId = response.body.organization.id;

      if (typeof organizationId !== "string") {
        throw new Error("Expected the organization ID to be a string");
      }

      const membership = await prisma.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId,
          },
        },
        include: { role: true },
      });

      expect(membership).not.toBeNull();
      expect(membership!.role.code).toBe("super_user");

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          organizationId,
          actorUserId: user.id,
          action: "organization.created",
        },
      });

      expect(auditLog).not.toBeNull();
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: user.id },
      });

      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });
});

describe("GET /organizations/:organizationId", () => {
  test("rejects a request without authentication", async () => {
    const response = await request(app).get(
      "/organizations/00000000-0000-0000-0000-000000000000",
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("rejects an invalid organization UUID", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();

    try {
      const response = await request(app)
        .get("/organizations/not-a-uuid")
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await prisma.session.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("allows an organization member to retrieve their organization", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ name: `Retrieval test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .get(`/organizations/${organizationId}`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(200);
      expect(response.body.organization).toMatchObject({
        id: organizationId,
        name: createResponse.body.organization.name,
      });
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("denies a user who does not belong to the organization", async () => {
    const { user: owner, sessionToken: ownerToken } =
      await createAuthenticatedUser();
    const { user: outsider, sessionToken: outsiderToken } =
      await createAuthenticatedUser();

    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: `Isolation test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .get(`/organizations/${organizationId}`)
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: { in: [owner.id, outsider.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [owner.id, outsider.id] } },
      });
    }
  });
});

describe("GET /organizations/:organizationId/memberships", () => {
  test("allows an organization member to list memberships", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ name: `Membership list ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .get(`/organizations/${organizationId}/memberships`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.memberships)).toBe(true);
      expect(response.body.memberships.length).toBeGreaterThan(0);
      expect(
        response.body.memberships.every(
          (membership: { organizationId: string }) =>
            membership.organizationId === organizationId,
        ),
      ).toBe(true);
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("denies a user without organization membership", async () => {
    const { user: owner, sessionToken: ownerToken } =
      await createAuthenticatedUser();
    const { user: outsider, sessionToken: outsiderToken } =
      await createAuthenticatedUser();

    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: `Membership isolation ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .get(`/organizations/${organizationId}/memberships`)
        .set("Authorization", `Bearer ${outsiderToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: { in: [owner.id, outsider.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [owner.id, outsider.id] } },
      });
    }
  });
});

describe("GET /organizations/:organizationId/memberships/:membershipId", () => {
  test("allows an organization member to retrieve a membership", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ name: `Membership detail ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const membershipsResponse = await request(app)
        .get(`/organizations/${organizationId}/memberships`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(membershipsResponse.status).toBe(200);

      const membershipId = membershipsResponse.body.memberships[0].id;

      const response = await request(app)
        .get(`/organizations/${organizationId}/memberships/${membershipId}`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(200);
      expect(response.body.membership).toMatchObject({
        id: membershipId,
        organizationId,
        role: { code: "super_user" },
      });
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("rejects an invalid membership UUID", async () => {
    const owner = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Invalid membership ID test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .get(`/organizations/${organizationId}/memberships/not-a-uuid`)
        .set("Authorization", `Bearer ${owner.sessionToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: owner.user.id },
      });

      await prisma.user.delete({
        where: { id: owner.user.id },
      });
    }
  });

  test("does not reveal a membership from another organization", async () => {
    const { user: ownerA, sessionToken: tokenA } =
      await createAuthenticatedUser();
    const { user: ownerB, sessionToken: tokenB } =
      await createAuthenticatedUser();

    let organizationAId: string | undefined;
    let organizationBId: string | undefined;

    try {
      const responseA = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ name: `Organization A ${randomUUID()}` });

      expect(responseA.status).toBe(201);
      organizationAId = responseA.body.organization.id;

      const responseB = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${tokenB}`)
        .send({ name: `Organization B ${randomUUID()}` });

      expect(responseB.status).toBe(201);
      organizationBId = responseB.body.organization.id;

      const membershipsResponse = await request(app)
        .get(`/organizations/${organizationBId}/memberships`)
        .set("Authorization", `Bearer ${tokenB}`);

      expect(membershipsResponse.status).toBe(200);

      const targetMembershipId = membershipsResponse.body.memberships[0].id;

      const response = await request(app)
        .get(
          `/organizations/${organizationAId}/memberships/${targetMembershipId}`,
        )
        .set("Authorization", `Bearer ${tokenA}`);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("MEMBERSHIP_NOT_FOUND");
    } finally {
      if (organizationAId) {
        await cleanupOrganization(organizationAId);
      }
      if (organizationBId) {
        await cleanupOrganization(organizationBId);
      }

      await prisma.session.deleteMany({
        where: { userId: { in: [ownerA.id, ownerB.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [ownerA.id, ownerB.id] } },
      });
    }
  });
});

describe("GET /organizations/:organizationId/structure", () => {
  test("allows an organization member to retrieve the organization structure", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ name: `Structure test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .get(`/organizations/${organizationId}/structure`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(200);
      expect(response.body.structure.organizationId).toBe(organizationId);
      expect(response.body.structure.counts).toEqual({
        total: 1,
        superUsers: 1,
        admins: 0,
        managers: 0,
        members: 0,
      });
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: user.id },
      });
      await prisma.user.delete({
        where: { id: user.id },
      });
    }
  });

  test("denies a user without organization membership", async () => {
    const owner = await createAuthenticatedUser();
    const outsider = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Structure test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .get(`/organizations/${organizationId}/structure`)
        .set("Authorization", `Bearer ${outsider.sessionToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: { in: [owner.user.id, outsider.user.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [owner.user.id, outsider.user.id] } },
      });
    }
  });
});

describe("POST /organizations/:organizationId/transfer-ownership", () => {
  test("allows the Super User to transfer ownership to another member", async () => {
    const owner = await createAuthenticatedUser();
    const targetUser = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Ownership test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      if (typeof organizationId !== "string") {
        throw new Error("Expected the organization ID to be a string");
      }

      const targetMembership = await createMembership(
        organizationId,
        targetUser.user.id,
        "member",
      );

      const response = await request(app)
        .post(`/organizations/${organizationId}/transfer-ownership`)
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ targetMembershipId: targetMembership.id });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        organizationId,
        newOwnerMembershipId: targetMembership.id,
      });

      const memberships = await prisma.membership.findMany({
        where: { organizationId },
        include: { role: true },
      });

      expect(
        memberships.find((membership) => membership.userId === owner.user.id)
          ?.role.code,
      ).toBe("admin");

      expect(
        memberships.find((membership) => membership.id === targetMembership.id)
          ?.role.code,
      ).toBe("super_user");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      const userIds = [owner.user.id, targetUser.user.id];

      await prisma.session.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
    }
  });

  test("rejects a target membership that does not exist in the organization", async () => {
    const owner = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Ownership test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .post(`/organizations/${organizationId}/transfer-ownership`)
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ targetMembershipId: randomUUID() });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe(
        "OWNERSHIP_TRANSFER_TARGET_INVALID",
      );
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: owner.user.id },
      });
      await prisma.user.delete({
        where: { id: owner.user.id },
      });
    }
  });

  test("denies a regular member from transferring ownership", async () => {
    const owner = await createAuthenticatedUser();
    const member = await createAuthenticatedUser();
    const targetUser = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Unauthorized transfer test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      if (typeof organizationId !== "string") {
        throw new Error("Expected the organization ID to be a string");
      }

      await createMembership(organizationId, member.user.id, "member");

      const targetMembership = await createMembership(
        organizationId,
        targetUser.user.id,
        "member",
      );

      const response = await request(app)
        .post(`/organizations/${organizationId}/transfer-ownership`)
        .set("Authorization", `Bearer ${member.sessionToken}`)
        .send({ targetMembershipId: targetMembership.id });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");

      const ownerMembership = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: owner.user.id,
            organizationId,
          },
        },
        include: { role: true },
      });

      expect(ownerMembership.role.code).toBe("super_user");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      const userIds = [owner.user.id, member.user.id, targetUser.user.id];

      await prisma.session.deleteMany({
        where: { userId: { in: userIds } },
      });

      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
    }
  });
});

describe("PATCH /organizations/:organizationId/memberships/:membershipId/role", () => {
  test("allows the Super User to change a member's role", async () => {
    const owner = await createAuthenticatedUser();
    const targetUser = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Role test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      if (typeof organizationId !== "string") {
        throw new Error("Expected the organization ID to be a string");
      }

      const targetMembership = await createMembership(
        organizationId,
        targetUser.user.id,
        "member",
      );

      const response = await request(app)
        .patch(
          `/organizations/${organizationId}/memberships/${targetMembership.id}/role`,
        )
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ roleCode: "manager" });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        membershipId: targetMembership.id,
        previousRole: "member",
        newRole: "manager",
      });

      const updatedMembership = await prisma.membership.findUnique({
        where: { id: targetMembership.id },
        include: { role: true },
      });

      expect(updatedMembership?.role.code).toBe("manager");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      const userIds = [owner.user.id, targetUser.user.id];

      await prisma.session.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
    }
  });

  test("rejects an invalid role code", async () => {
    const owner = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Role test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      if (typeof organizationId !== "string") {
        throw new Error("Expected the organization ID to be a string");
      }

      const membership = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: owner.user.id,
            organizationId,
          },
        },
      });

      const response = await request(app)
        .patch(
          `/organizations/${organizationId}/memberships/${membership.id}/role`,
        )
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ roleCode: "invalid_role" });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: owner.user.id },
      });
      await prisma.user.delete({
        where: { id: owner.user.id },
      });
    }
  });

  test("denies a user without organization membership", async () => {
    const owner = await createAuthenticatedUser();
    const outsider = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Role test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      if (typeof organizationId !== "string") {
        throw new Error("Expected the organization ID to be a string");
      }

      const membership = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: owner.user.id,
            organizationId,
          },
        },
      });

      const response = await request(app)
        .patch(
          `/organizations/${organizationId}/memberships/${membership.id}/role`,
        )
        .set("Authorization", `Bearer ${outsider.sessionToken}`)
        .send({ roleCode: "admin" });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      const userIds = [owner.user.id, outsider.user.id];

      await prisma.session.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
    }
  });
});

describe("PATCH /organizations/:organizationId/memberships/:membershipId/reporting-assignment", () => {
  test("allows the Super User to assign a Manager to an Admin", async () => {
    const owner = await createAuthenticatedUser();
    const adminUser = await createAuthenticatedUser();
    const managerUser = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Reporting test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      if (typeof organizationId !== "string") {
        throw new Error("Expected the organization ID to be a string");
      }

      const adminMembership = await createMembership(
        organizationId,
        adminUser.user.id,
        "admin",
      );

      const managerMembership = await createMembership(
        organizationId,
        managerUser.user.id,
        "manager",
      );

      const response = await request(app)
        .patch(
          `/organizations/${organizationId}/memberships/${managerMembership.id}/reporting-assignment`,
        )
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({
          role: "manager",
          adminMembershipId: adminMembership.id,
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        membershipId: managerMembership.id,
        role: "manager",
        adminMembershipId: adminMembership.id,
        managerMembershipId: null,
      });

      const updatedMembership = await prisma.membership.findUnique({
        where: { id: managerMembership.id },
      });

      expect(updatedMembership?.adminMembershipId).toBe(adminMembership.id);
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      const userIds = [owner.user.id, adminUser.user.id, managerUser.user.id];

      await prisma.session.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
    }
  });

  test("denies an Admin from moving a Manager to another Admin", async () => {
    const owner = await createAuthenticatedUser();
    const adminAUser = await createAuthenticatedUser();
    const adminBUser = await createAuthenticatedUser();
    const managerUser = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Reporting test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      if (typeof organizationId !== "string") {
        throw new Error("Expected the organization ID to be a string");
      }

      const adminA = await createMembership(
        organizationId,
        adminAUser.user.id,
        "admin",
      );

      const adminB = await createMembership(
        organizationId,
        adminBUser.user.id,
        "admin",
      );

      const manager = await createMembership(
        organizationId,
        managerUser.user.id,
        "manager",
        { adminMembershipId: adminA.id },
      );

      const response = await request(app)
        .patch(
          `/organizations/${organizationId}/memberships/${manager.id}/reporting-assignment`,
        )
        .set("Authorization", `Bearer ${adminAUser.sessionToken}`)
        .send({
          role: "manager",
          adminMembershipId: adminB.id,
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");

      const unchangedManager = await prisma.membership.findUniqueOrThrow({
        where: { id: manager.id },
      });

      expect(unchangedManager.adminMembershipId).toBe(adminA.id);

      const auditLog = await prisma.auditLog.findFirst({
        where: {
          organizationId,
          action: "membership.reporting_assignment_changed",
          targetId: manager.id,
        },
      });

      expect(auditLog).toBeNull();
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      const userIds = [
        owner.user.id,
        adminAUser.user.id,
        adminBUser.user.id,
        managerUser.user.id,
      ];

      await prisma.session.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
    }
  });

  test("rejects an invalid reporting-assignment body", async () => {
    const owner = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Reporting test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      if (typeof organizationId !== "string") {
        throw new Error("Expected the organization ID to be a string");
      }

      const membership = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: owner.user.id,
            organizationId,
          },
        },
      });

      const response = await request(app)
        .patch(
          `/organizations/${organizationId}/memberships/${membership.id}/reporting-assignment`,
        )
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({
          role: "invalid_role",
          adminMembershipId: null,
        });

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({
        where: { userId: owner.user.id },
      });
      await prisma.user.delete({
        where: { id: owner.user.id },
      });
    }
  });

  test("denies a user without organization membership", async () => {
    const owner = await createAuthenticatedUser();
    const outsider = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Reporting test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      if (typeof organizationId !== "string") {
        throw new Error("Expected the organization ID to be a string");
      }

      const membership = await prisma.membership.findUniqueOrThrow({
        where: {
          userId_organizationId: {
            userId: owner.user.id,
            organizationId,
          },
        },
      });

      const response = await request(app)
        .patch(
          `/organizations/${organizationId}/memberships/${membership.id}/reporting-assignment`,
        )
        .set("Authorization", `Bearer ${outsider.sessionToken}`)
        .send({
          role: "manager",
          adminMembershipId: null,
        });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      const userIds = [owner.user.id, outsider.user.id];

      await prisma.session.deleteMany({
        where: { userId: { in: userIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
    }
  });
});

describe("DELETE /organizations/:organizationId/memberships/:membershipId", () => {
  test("DELETE /organizations/:organizationId/memberships/:membershipId removes a membership", async () => {
    const owner = await createAuthenticatedUser();
    const member = await createAuthenticatedUser();

    const organization = await prisma.organization.create({
      data: { name: "Membership Removal Test" },
    });

    try {
      await createMembership(organization.id, owner.user.id, "super_user");
      const targetMembership = await createMembership(
        organization.id,
        member.user.id,
        "member",
      );

      const response = await request(app)
        .delete(
          `/organizations/${organization.id}/memberships/${targetMembership.id}`,
        )
        .set("Authorization", `Bearer ${owner.sessionToken}`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        membershipId: targetMembership.id,
        removedRole: "member",
      });

      const deletedMembership = await prisma.membership.findUnique({
        where: { id: targetMembership.id },
      });

      expect(deletedMembership).toBeNull();
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.session.deleteMany({
        where: { userId: { in: [owner.user.id, member.user.id] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [owner.user.id, member.user.id] } },
      });
    }
  });

  test("DELETE /organizations/:organizationId/memberships/:membershipId rejects removing a Super User", async () => {
    const owner = await createAuthenticatedUser();

    const organization = await prisma.organization.create({
      data: { name: "Super User Removal Test" },
    });

    try {
      const ownerMembership = await createMembership(
        organization.id,
        owner.user.id,
        "super_user",
      );

      const response = await request(app)
        .delete(
          `/organizations/${organization.id}/memberships/${ownerMembership.id}`,
        )
        .set("Authorization", `Bearer ${owner.sessionToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");

      const existingMembership = await prisma.membership.findUnique({
        where: { id: ownerMembership.id },
      });

      expect(existingMembership).not.toBeNull();
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.session.deleteMany({
        where: { userId: owner.user.id },
      });
      await prisma.user.deleteMany({
        where: { id: owner.user.id },
      });
    }
  });

  test("DELETE /organizations/:organizationId/memberships/:membershipId rejects an unauthorized actor", async () => {
    const owner = await createAuthenticatedUser();
    const member = await createAuthenticatedUser();
    const outsider = await createAuthenticatedUser();

    const organization = await prisma.organization.create({
      data: { name: "Unauthorized Removal Test" },
    });

    try {
      await createMembership(organization.id, owner.user.id, "super_user");
      const targetMembership = await createMembership(
        organization.id,
        member.user.id,
        "member",
      );

      const response = await request(app)
        .delete(
          `/organizations/${organization.id}/memberships/${targetMembership.id}`,
        )
        .set("Authorization", `Bearer ${outsider.sessionToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");

      const existingMembership = await prisma.membership.findUnique({
        where: { id: targetMembership.id },
      });

      expect(existingMembership).not.toBeNull();
    } finally {
      await cleanupOrganization(organization.id);
      await prisma.session.deleteMany({
        where: {
          userId: {
            in: [owner.user.id, member.user.id, outsider.user.id],
          },
        },
      });
      await prisma.user.deleteMany({
        where: {
          id: {
            in: [owner.user.id, member.user.id, outsider.user.id],
          },
        },
      });
    }
  });
});

describe("DELETE /organizations/:organizationId/users/:userId/sessions", () => {
  test("rejects a request without authentication", async () => {
    const response = await request(app).delete(
      `/organizations/${randomUUID()}/users/${randomUUID()}/sessions`,
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("rejects invalid organization and user UUIDs", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();

    try {
      const response = await request(app)
        .delete("/organizations/not-a-uuid/users/not-a-uuid/sessions")
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("allows a Super User to revoke a member's sessions", async () => {
    const actor = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();
    const organization = await prisma.organization.create({
      data: { name: `Session revocation ${randomUUID()}` },
    });

    try {
      await createMembership(organization.id, actor.user.id, "super_user");
      await createMembership(organization.id, target.user.id, "member");

      const targetSession = await prisma.session.create({
        data: {
          userId: target.user.id,
          tokenHash: createHash("sha256")
            .update(randomBytes(32).toString("hex"))
            .digest("hex"),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const response = await request(app)
        .delete(
          `/organizations/${organization.id}/users/${target.user.id}/sessions`,
        )
        .set("Authorization", `Bearer ${actor.sessionToken}`);

      expect(response.status).toBe(200);
      expect(response.body.revokedCount).toBeGreaterThanOrEqual(1);

      const revokedSession = await prisma.session.findUnique({
        where: { id: targetSession.id },
      });

      expect(revokedSession?.revokedAt).not.toBeNull();
    } finally {
      await prisma.session.deleteMany({
        where: {
          userId: { in: [actor.user.id, target.user.id] },
        },
      });

      // Remove memberships and the organization before deleting users.
      await cleanupOrganization(organization.id);

      await prisma.user.deleteMany({
        where: {
          id: { in: [actor.user.id, target.user.id] },
        },
      });
    }
  });

  test("rejects an actor without session.manage_any permission", async () => {
    const actor = await createAuthenticatedUser();
    const target = await createAuthenticatedUser();
    const organization = await prisma.organization.create({
      data: { name: `Session permission ${randomUUID()}` },
    });

    try {
      await createMembership(organization.id, actor.user.id, "member");
      await createMembership(organization.id, target.user.id, "member");

      const response = await request(app)
        .delete(
          `/organizations/${organization.id}/users/${target.user.id}/sessions`,
        )
        .set("Authorization", `Bearer ${actor.sessionToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    } finally {
      await prisma.session.deleteMany({
        where: { userId: { in: [actor.user.id, target.user.id] } },
      });

      await cleanupOrganization(organization.id);

      await prisma.user.deleteMany({
        where: { id: { in: [actor.user.id, target.user.id] } },
      });
    }
  });

  test("rejects an Admin revoking sessions for a Manager outside their scope", async () => {
    const actorAdmin = await createAuthenticatedUser();
    const otherAdmin = await createAuthenticatedUser();
    const targetManager = await createAuthenticatedUser();

    const organization = await prisma.organization.create({
      data: { name: `Session scope ${randomUUID()}` },
    });

    try {
      const actorAdminMembership = await createMembership(
        organization.id,
        actorAdmin.user.id,
        "admin",
      );

      const otherAdminMembership = await createMembership(
        organization.id,
        otherAdmin.user.id,
        "admin",
      );

      await createMembership(
        organization.id,
        targetManager.user.id,
        "manager",
        { adminMembershipId: otherAdminMembership.id },
      );

      const targetSession = await prisma.session.create({
        data: {
          userId: targetManager.user.id,
          tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const response = await request(app)
        .delete(
          `/organizations/${organization.id}/users/${targetManager.user.id}/sessions`,
        )
        .set("Authorization", `Bearer ${actorAdmin.sessionToken}`);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");

      const unchangedSession = await prisma.session.findUniqueOrThrow({
        where: { id: targetSession.id },
      });

      expect(unchangedSession.revokedAt).toBeNull();
    } finally {
      await cleanupOrganization(organization.id);

      await prisma.session.deleteMany({
        where: {
          userId: {
            in: [actorAdmin.user.id, otherAdmin.user.id, targetManager.user.id],
          },
        },
      });

      await prisma.user.deleteMany({
        where: {
          id: {
            in: [actorAdmin.user.id, otherAdmin.user.id, targetManager.user.id],
          },
        },
      });
    }
  });
});

describe("GET /organizations/:organizationId/audit-logs", () => {
  test("rejects a request without authentication", async () => {
    const response = await request(app).get(
      `/organizations/${randomUUID()}/audit-logs`,
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("allows a Super User to retrieve organization audit logs", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ name: `Audit test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .get(`/organizations/${organizationId}/audit-logs`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(200);
      expect(response.body.auditLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            organizationId,
            actorUserId: user.id,
            action: "organization.created",
          }),
        ]),
      );
      expect(response.body.pagination).toEqual({
        page: 1,
        pageSize: 20,
        total: expect.any(Number),
        totalPages: expect.any(Number),
      });

      expect(response.body.auditLogs[0]).not.toHaveProperty("metadata");
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects a regular member without audit_log.read permission", async () => {
    const owner = await createAuthenticatedUser();
    const member = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${owner.sessionToken}`)
        .send({ name: `Audit permission test ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      if (typeof organizationId !== "string") {
        throw new Error("Expected the organization ID to be a string");
      }

      await createMembership(organizationId, member.user.id, "member");

      const response = await request(app)
        .get(`/organizations/${organizationId}/audit-logs`)
        .set("Authorization", `Bearer ${member.sessionToken}`);

      expect(response.status).toBe(403);
    } finally {
      if (organizationId) {
        await cleanupOrganization(organizationId);
      }

      for (const account of [owner, member]) {
        await prisma.session.deleteMany({
          where: { userId: account.user.id },
        });
        await prisma.user.delete({
          where: { id: account.user.id },
        });
      }
    }
  });

  test("rejects an invalid organization UUID", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();

    try {
      const response = await request(app)
        .get("/organizations/not-a-uuid/audit-logs")
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects invalid pagination parameters", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ name: `Audit pagination ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .get(`/organizations/${organizationId}/audit-logs?page=0&pageSize=101`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("rejects unsupported query parameters", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ name: `Audit filter ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .get(`/organizations/${organizationId}/audit-logs?unknownFilter=value`)
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  test("does not expose audit logs from another organization", async () => {
    const firstOwner = await createAuthenticatedUser();
    const secondOwner = await createAuthenticatedUser();
    let firstOrganizationId: string | undefined;
    let secondOrganizationId: string | undefined;

    try {
      const firstCreate = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${firstOwner.sessionToken}`)
        .send({ name: `First audit org ${randomUUID()}` });

      const secondCreate = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${secondOwner.sessionToken}`)
        .send({ name: `Second audit org ${randomUUID()}` });

      expect(firstCreate.status).toBe(201);
      expect(secondCreate.status).toBe(201);

      firstOrganizationId = firstCreate.body.organization.id;
      secondOrganizationId = secondCreate.body.organization.id;

      if (
        typeof firstOrganizationId !== "string" ||
        typeof secondOrganizationId !== "string"
      ) {
        throw new Error("Expected both organization IDs to be strings");
      }

      const response = await request(app)
        .get(`/organizations/${firstOrganizationId}/audit-logs`)
        .set("Authorization", `Bearer ${firstOwner.sessionToken}`);

      expect(response.status).toBe(200);
      expect(
        response.body.auditLogs.every(
          (log: { organizationId: string }) =>
            log.organizationId === firstOrganizationId,
        ),
      ).toBe(true);

      expect(
        response.body.auditLogs.some(
          (log: { organizationId: string }) =>
            log.organizationId === secondOrganizationId,
        ),
      ).toBe(false);
    } finally {
      if (firstOrganizationId) {
        await cleanupOrganization(firstOrganizationId);
      }
      if (secondOrganizationId) {
        await cleanupOrganization(secondOrganizationId);
      }

      for (const account of [firstOwner, secondOwner]) {
        await prisma.session.deleteMany({
          where: { userId: account.user.id },
        });
        await prisma.user.delete({
          where: { id: account.user.id },
        });
      }
    }
  });

  test("returns empty results when no audit logs match the filter", async () => {
    const { user, sessionToken } = await createAuthenticatedUser();
    let organizationId: string | undefined;

    try {
      const createResponse = await request(app)
        .post("/organizations")
        .set("Authorization", `Bearer ${sessionToken}`)
        .send({ name: `Empty audit result ${randomUUID()}` });

      expect(createResponse.status).toBe(201);
      organizationId = createResponse.body.organization.id;

      const response = await request(app)
        .get(
          `/organizations/${organizationId}/audit-logs?action=${encodeURIComponent(
            `nonexistent.action.${randomUUID()}`,
          )}`,
        )
        .set("Authorization", `Bearer ${sessionToken}`);

      expect(response.status).toBe(200);
      expect(response.body.auditLogs).toEqual([]);
      expect(response.body.pagination).toMatchObject({
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 0,
      });
    } finally {
      if (organizationId) await cleanupOrganization(organizationId);
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
