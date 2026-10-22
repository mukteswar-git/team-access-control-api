import { describe, expect, it } from "@jest/globals";
import request from "supertest";
import express from "express";
import errorHandler from "../src/middleware/error-handler.js";
import { MembershipError } from "../src/services/membership.errors.js";

const app = express();

app.get("/test-error", () => {
  throw new Error("Internal database details");
});

app.get("/test-membership-invalid", () => {
  throw new MembershipError("INVALID_INPUT", "Invalid membership input.");
});

app.get("/test-membership-forbidden", () => {
  throw new MembershipError("FORBIDDEN", "Access denied.");
});

app.get("/test-membership-not-found", () => {
  throw new MembershipError("MEMBERSHIP_NOT_FOUND", "Membership not found.");
});

app.use(errorHandler);

describe("Error handler", () => {
  it("returns a generic 500 response", async () => {
    const response = await request(app).get("/test-error");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
      },
    });
  });

  it("maps invalid membership input to 400", async () => {
    const response = await request(app).get("/test-membership-invalid");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_INPUT");
  });

  it("maps forbidden membership operations to 403", async () => {
    const response = await request(app).get("/test-membership-forbidden");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("maps missing memberships to 404", async () => {
    const response = await request(app).get("/test-membership-not-found");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("MEMBERSHIP_NOT_FOUND");
  });
});
