import express from "express";
import request from "supertest";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import "../../src/middleware/require-auth.js";

const mockHasPermission =
  jest.fn<
    (
      userId: string,
      organizationId: string,
      permissionCode: string,
    ) => Promise<boolean>
  >();

jest.unstable_mockModule("../../src/services/authorization.service.js", () => ({
  hasPermission: mockHasPermission,
}));

const { requirePermission } =
  await import("../../src/middleware/require-permission.js");

function createApp(authenticated = true) {
  const app = express();

  app.use((req, _res, next) => {
    if (authenticated) {
      req.auth = {
        user: {
          id: "user-123",
          email: "user@example.com",
          emailVerifiedAt: new Date(),
        },
        session: {
          id: "session-123",
          expiresAt: new Date(Date.now() + 60_000),
        },
      };
    }

    next();
  });

  app.get(
    "/organizations/:organizationId",
    requirePermission("organization.read"),
    (_req, res) => {
      res.status(200).json({ status: "ok" });
    },
  );

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred",
        },
      });
    },
  );

  return app;
}

afterEach(() => {
  mockHasPermission.mockReset();
});

describe("requirePermission middleware", () => {
  test("rejects requests without authentication", async () => {
    const response = await request(createApp(false)).get(
      "/organizations/org-123",
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(mockHasPermission).not.toHaveBeenCalled();
  });

  test("rejects a missing organization ID at the route", async () => {
    const response = await request(createApp()).get("/organizations/");

    expect(response.status).toBe(404);
    expect(mockHasPermission).not.toHaveBeenCalled();
  });

  test("rejects users without the required permission", async () => {
    mockHasPermission.mockResolvedValue(false);

    const response = await request(createApp()).get("/organizations/org-123");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(mockHasPermission).toHaveBeenCalledWith(
      "user-123",
      "org-123",
      "organization.read",
    );
  });

  test("allows users with the required permission", async () => {
    mockHasPermission.mockResolvedValue(true);

    const response = await request(createApp()).get("/organizations/org-123");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(mockHasPermission).toHaveBeenCalledWith(
      "user-123",
      "org-123",
      "organization.read",
    );
  });

  test("forwards unexpected authorization service errors", async () => {
    mockHasPermission.mockRejectedValue(new Error("Database unavailable"));

    const response = await request(createApp()).get("/organizations/org-123");

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
