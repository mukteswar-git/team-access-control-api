import { describe, expect, it } from "@jest/globals";
import express from "express";
import request from "supertest";
import { z } from "zod";
import validate from "../../src/middleware/validate.js";

const app = express();

app.use(express.json());

const schema = z.object({
  email: z.email(),
});

app.post("/test", validate(schema), (req, res) => {
  res.status(200).json({ data: req.body });
});

describe("Validation middleware", () => {
  it("accepts a valid request body", async () => {
    const response = await request(app)
      .post("/test")
      .send({ email: "user@example.com" });

    expect(response.status).toBe(200);
    expect(response.body.data.email).toBe("user@example.com");
  });

  it("rejects an invalid request body", async () => {
    const response = await request(app)
      .post("/test")
      .send({ email: "invalid-email" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details[0].field).toBe("email");
  });
});
