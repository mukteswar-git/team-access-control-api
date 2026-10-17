import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "@jest/globals";
import {
  testPrisma as prisma,
  disconnectTestDatabase,
} from "../helpers/database.js";
import {
  createOrganization,
  findOrganizationById,
} from "../../src/repositories/organization.repository.js";

describe("Organization repository", () => {
  afterAll(async () => {
    await disconnectTestDatabase();
  });

  test("creates an organization", async () => {
    const name = `Organization ${randomUUID()}`;

    const organization = await createOrganization({ name });

    try {
      expect(organization.id).toBeDefined();
      expect(organization.name).toBe(name);
      expect(organization.createdAt).toBeInstanceOf(Date);
      expect(organization.updatedAt).toBeInstanceOf(Date);
    } finally {
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("finds an organization by ID", async () => {
    const organization = await prisma.organization.create({
      data: {
        name: `Organization ${randomUUID()}`,
      },
    });

    try {
      const result = await findOrganizationById(organization.id);

      expect(result?.id).toBe(organization.id);
      expect(result?.name).toBe(organization.name);
    } finally {
      await prisma.organization.delete({
        where: { id: organization.id },
      });
    }
  });

  test("returns null when the organization does not exist", async () => {
    const result = await findOrganizationById(randomUUID());

    expect(result).toBeNull();
  });
});
