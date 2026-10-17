import { prisma } from "../lib/prisma.js";

type CreateOrganizationData = {
  name: string;
};

export function createOrganization(data: CreateOrganizationData) {
  return prisma.organization.create({
    data: {
      name: data.name,
    },
  });
}

export function findOrganizationById(id: string) {
  return prisma.organization.findUnique({
    where: { id },
  });
}
