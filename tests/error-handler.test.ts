import { describe, expect, it } from "@jest/globals";
import request from "supertest";
import express from "express";
import errorHandler from "../src/middleware/error-handler.js";

const app = express();

app.get("/test-error", () => {
  throw new Error("Internal database details");
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
});
