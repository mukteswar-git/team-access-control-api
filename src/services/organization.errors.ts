export type OrganizationErrorCode =
  | "INVALID_INPUT"
  | "EMAIL_NOT_VERIFIED"
  | "FORBIDDEN"
  | "ORGANIZATION_NOT_FOUND"
  | "SUPER_USER_ROLE_NOT_CONFIGURED";

export class OrganizationError extends Error {
  constructor(
    public readonly code: OrganizationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OrganizationError";
  }
}
