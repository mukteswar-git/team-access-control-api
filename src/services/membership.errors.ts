export type MembershipErrorCode =
  "INVALID_INPUT" | "FORBIDDEN" | "MEMBERSHIP_NOT_FOUND";

export class MembershipError extends Error {
  constructor(
    public readonly code: MembershipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MembershipError";
  }
}
