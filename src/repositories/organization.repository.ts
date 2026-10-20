import { prisma, type DatabaseClient } from "../lib/prisma.js";

type CreateOrganizationData = {
  name: string;
};

export function createOrganization(
  data: CreateOrganizationData,
  db: DatabaseClient = prisma,
) {
  return db.organization.create({
    data: {
      name: data.name,
    },
  });
}

export function findOrganizationById(id: string, db: DatabaseClient = prisma) {
  return db.organization.findUnique({
    where: { id },
  });
}
