# Team Access Control API — API Development Guide

**Project:** Team Access Control API  
**Status:** Development baseline  
**Version:** 1.0

## 1. Purpose

This document defines the standard process for implementing API endpoints in the Team Access Control API.

The API Specification defines **what endpoints exist and what they are allowed to do**.

This document defines **how developers should implement those endpoints**.

The Product & Authorization Specification remains the source of truth for product behavior and authorization rules. The approved Database Design remains the source of truth for persistence structure and database invariants.

If this guide conflicts with either source, the source-of-truth document must be followed and the guide must be updated.

---

## 2. Core Implementation Rule

Every protected API endpoint must follow this general flow:

```text
HTTP Request
     ↓
Route
     ↓
Request validation
     ↓
Authentication
     ↓
Organization resolution
     ↓
Membership resolution
     ↓
Permission check
     ↓
Target resource organization check
     ↓
Role / scope check
     ↓
Service business rules
     ↓
Transaction when required
     ↓
Repository / Prisma
     ↓
Audit event when required
     ↓
HTTP Response
```

Not every endpoint requires every step.

The developer must determine the applicable steps from the API Specification.

---

## 3. Before Writing Code

Before implementation begins, the developer must understand:

1. The assigned task.
2. The API Specification entry for the endpoint.
3. The Product & Authorization Specification rules relevant to the endpoint.
4. The Database Design relevant to the endpoint.
5. The acceptance criteria.
6. The test cases.

Do not infer business rules merely from a route name.

---

## 4. Project Module Structure

Feature-related code should be grouped into modules.

Recommended structure:

```text
src/
├── config/
│   └── env.ts
│
├── lib/
│   ├── prisma.ts
│   └── redis.ts
│
├── middleware/
│   ├── error-handler.ts
│   ├── not-found.ts
│   └── require-auth.ts
│
├── modules/
│   ├── auth/
│   ├── organizations/
│   ├── memberships/
│   ├── invitations/
│   ├── sessions/
│   ├── authorization/
│   └── audit/
│
├── routes/
│   └── index.ts
│
├── app.ts
└── index.ts
```

A module should contain code for its feature rather than spreading one feature across unrelated global folders.

A typical module may contain:

```text
modules/memberships/
├── membership.controller.ts
├── membership.service.ts
├── membership.repository.ts
├── membership.schema.ts
└── membership.routes.ts
```

Not every module needs every file. Create files when they have a real responsibility.

---

## 5. Route Layer

Routes define:

- HTTP method;
- URL;
- middleware;
- controller.

Example:

```ts
router.patch(
  "/organizations/:organizationId/memberships/:membershipId",
  requireAuth,
  validate(updateMembershipSchema),
  membershipController.update,
);
```

Routes should remain thin.

Do not put database queries, authorization business rules, password hashing, invitation state transitions, or complex membership scope logic directly in route definitions.

---

## 6. Request Validation

Validate external input before business logic.

Use the project's established validation approach with Zod.

Validation should cover:

- request body;
- path parameters;
- query parameters;
- required fields;
- field types;
- string constraints;
- enum values;
- compatible combinations where appropriate.

Validation answers:

> Is the request structurally valid?

Authorization answers:

> Is this actor allowed to perform this operation?

Do not use request validation as a substitute for authorization.

---

## 7. Authentication

Authentication determines the current user.

For a protected endpoint:

```text
Cookie
  ↓
Session token
  ↓
Session lookup
  ↓
Session validity
  ↓
Current user
```

A session is valid only when it has not been revoked and has not expired.

The raw session token must not be stored in the database. The server stores a secure token hash.

Authentication middleware should establish trusted request context, for example:

```ts
req.auth = {
  userId: "...",
  sessionId: "...",
};
```

The exact request-context implementation is an implementation decision.

Controllers and services must use this trusted server-side identity rather than a client-supplied user ID.

---

## 8. Organization Resolution

For an organization-scoped endpoint, resolve the organization from:

```text
/organizations/:organizationId/...
```

Then verify that the organization exists and that the request is operating against that organization.

Never assume that a resource belongs to the organization simply because its ID appears in the URL.

The resource itself must also be checked.

---

## 9. Membership Resolution

After authentication and organization resolution, retrieve the actor's active membership when the endpoint is organization-scoped.

Authorization should operate using trusted server-side information such as:

```text
user
organization
membership
role
permissions
```

The user's role must come from the database membership.

Never trust:

```json
{
  "role": "super_user"
}
```

from the client.

---

## 10. Permission Checks

Current permissions are:

```text
organization.read
membership.read
invitation.create
invitation.revoke
membership.update
membership.remove
organization.manage
audit_log.read
session.manage_self
session.manage_any
```

The authorization service should determine whether the actor has the required permission.

Conceptually:

```ts
authorizationService.requirePermission(
  actor,
  "membership.update",
);
```

Permission checking alone is not sufficient. Scope must also be enforced.

---

## 11. Scope and Hierarchy Checks

This project has hierarchical authorization.

The fixed roles are:

```text
Super User
    ↓
Admin
    ↓
Manager
    ↓
Member
```

Hierarchy alone does not determine access.

### Super User

Organization-wide management authority.

### Admin

Can manage:

- Managers assigned to that Admin;
- Members under those Managers;
- unassigned Members.

### Manager

Can manage:

- Members directly assigned to that Manager.

### Member

Cannot perform membership-management operations.

An unassigned Manager can be managed only by the Super User.

An unassigned Member can be managed by Super User/Admin according to the authorization rules.

The authorization service must encode these rules centrally rather than duplicating them across controllers.

---

## 12. Resource Organization Checks

Every organization-scoped target resource must be verified against the requested organization.

Example:

```text
PATCH
/organizations/org-A/memberships/member-B
```

The server must verify:

```text
membership.member-B.organization_id == org-A
```

If it does not, the request must not access or modify that resource.

This is a mandatory tenant-isolation check.

---

## 13. Authorization Service

Complex authorization decisions belong in the authorization layer.

Recommended structure:

```text
authorization/
├── authorization.service.ts
└── authorization.types.ts
```

The service should provide reusable checks such as:

```text
requireAuthenticatedUser()
requireOrganizationMembership()
requirePermission()
requireSameOrganization()
requireManagementScope()
requireSuperUser()
```

The exact function names are implementation decisions.

The important rule is:

> Controllers must not contain duplicated role and scope logic.

---

## 14. Controllers

Controllers translate HTTP requests into application operations.

A controller should generally:

1. Read validated request data.
2. Read authenticated identity.
3. Call the appropriate service.
4. Translate the result into an HTTP response.
5. Avoid complex business rules.

Conceptual example:

```ts
async function update(req, res) {
  const result = await membershipService.updateMembership({
    actorUserId: req.auth.userId,
    organizationId: req.params.organizationId,
    membershipId: req.params.membershipId,
    input: req.body,
  });

  return res.status(200).json(result);
}
```

The service determines whether the operation is actually allowed.

---

## 15. Services

Services contain application and business rules.

Services are responsible for operations such as:

- registration;
- login;
- password reset;
- organization creation;
- ownership transfer;
- membership changes;
- invitation creation;
- invitation acceptance;
- session revocation;
- audit event creation.

A service should answer:

> What should happen?

A repository should answer:

> How do we persist or retrieve it?

---

## 16. Data-Access Layer / Repositories

Repositories encapsulate Prisma/data-access operations.

Example:

```text
membership.repository.ts
```

may contain:

```text
findById()
findByUserAndOrganization()
findManagersInScope()
create()
update()
delete()
```

Repositories should not make high-level authorization decisions such as:

> Is this Manager allowed to modify this Member?

That belongs in authorization/service logic.

---

## 17. Transactions

Use database transactions whenever an operation changes multiple related records and must be atomic.

Important transactional operations include:

```text
Organization creation
Ownership transfer
Membership role changes
Membership reporting-assignment changes
Membership removal where reporting relationships change
Invitation acceptance
Password reset
Password change + session revocation
```

Conceptually:

```ts
await prisma.$transaction(async (tx) => {
  // related mutations
});
```

Do not perform half of a privileged mutation and depend on a later request to finish it.

---

## 18. Ownership Transfer

Ownership transfer is especially sensitive.

The operation must atomically perform:

```text
Current Super User → Admin
Target existing member → Super User
```

The database must never be left with:

```text
zero Super Users
```

or:

```text
two Super Users
```

---

## 19. Membership Updates

Membership updates can change:

```text
role
admin assignment
manager assignment
```

The service must validate the complete resulting state.

Examples:

### Manager

```text
role = manager
adminMembershipId = valid Admin
managerMembershipId = null
```

or:

```text
role = manager
adminMembershipId = null
managerMembershipId = null
```

### Member

```text
role = member
managerMembershipId = valid Manager
adminMembershipId = null
```

or:

```text
role = member
managerMembershipId = null
adminMembershipId = null
```

Invalid states must never be committed.

Reporting references must belong to the same organization.

---

## 20. Invitation Implementation

Invitation creation must:

1. Validate request.
2. Normalize email.
3. Authenticate inviter.
4. Resolve inviter membership.
5. Check `invitation.create`.
6. Check role-specific scope.
7. Validate reporting assignment.
8. Check duplicate membership.
9. Handle pending duplicate invitation.
10. Generate cryptographically secure opaque token.
11. Store only its hash.
12. Set seven-calendar-day expiration.
13. Create invitation.
14. Audit creation.
15. Send invitation.

Invitation acceptance must revalidate authorization-sensitive data at acceptance time.

Do not assume that the role and reporting assignment are still valid merely because they were valid when the invitation was created.

---

## 21. Session Management

Sessions are global to the user, not tied to one organization.

A session contains:

```text
id
user_id
token_hash
expires_at
revoked_at
created_at
last_used_at
```

A valid session satisfies:

```text
revoked_at IS NULL
AND expires_at > current time
```

Never expose raw session tokens in responses, logs, audit metadata, or database records.

---

## 22. Password Security

Passwords must be hashed with Argon2id.

Never:

- store plaintext passwords;
- log passwords;
- return password hashes in normal responses;
- include passwords in audit metadata.

Password reset must:

1. Validate token.
2. Verify expiration.
3. Verify single-use state.
4. Update password.
5. Consume token.
6. Revoke all sessions.

Password change must also revoke sessions according to the security requirements.

---

## 23. Audit Logging

Audit logs are append-only.

They should be generated by trusted server-side code after the relevant operation has been authorized and its result is known.

Audit entries contain concepts such as:

```text
organization
actor user
actor membership
action
result
target
metadata
timestamp
```

Never put secrets into audit metadata.

Sensitive authorization denials must also be audited, including:

- insufficient permission;
- cross-organization access;
- Admin-scope failure;
- Manager-scope failure;
- out-of-scope target.

Do not create public API endpoints for editing or deleting audit records.

---

## 24. Error Handling

Application errors should flow through centralized error handling.

The application should distinguish at least:

```text
Validation errors
Authentication errors
Authorization errors
Not-found errors
Conflict errors
Rate-limit errors
Unexpected internal errors
```

Do not expose internal stack traces, SQL details, or infrastructure secrets to API clients.

---

## 25. HTTP Status Codes

Use status codes consistently.

Typical codes:

```text
200 OK
201 Created
202 Accepted
204 No Content
400 Bad Request
401 Unauthorized
403 Forbidden
404 Not Found
409 Conflict
410 Gone
429 Too Many Requests
500 Internal Server Error
```

Endpoint-specific behavior must follow the API Specification.

---

## 26. Testing Requirements

Every API task must have acceptance criteria and test cases before implementation is considered complete.

The developer is responsible for writing and running automated tests for the behavior they implement.

Tests should cover:

### Happy path

Expected successful behavior.

### Validation

Invalid request data.

### Authentication

Unauthenticated requests to protected endpoints.

### Authorization

Insufficient permission.

### Scope

Actor has permission but target is outside their scope.

### Tenant isolation

Target resource belongs to another organization.

### State transitions

Examples:

```text
pending → accepted
pending → revoked
active session → revoked
Manager → Admin
Member → Manager
```

### Security-sensitive behavior

Examples:

- password hashing;
- token expiration;
- token single-use;
- session revocation;
- generic password-reset responses.

### Database invariants

Where appropriate, verify that invalid states cannot be committed.

---

## 27. Test Case Format for Tasks

Every assigned task should define test cases before implementation.

Example:

### Task

```text
Implement POST /organizations/:organizationId/invitations
```

### Acceptance criteria

- Super User can invite Admin/Manager/Member.
- Admin can invite Managers in scope and Members in scope.
- Manager can invite only Members assigned to self.
- Member cannot invite.
- Invitation expires after seven calendar days.
- Raw token is never stored.
- Duplicate membership is rejected.
- Invitation creation is audited.

### Test cases

| Test | Expected result |
|---|---|
| Super User invites Member | Success |
| Super User invites Manager | Success |
| Admin invites in-scope Manager | Success |
| Admin invites out-of-scope Manager | Denied |
| Manager invites assigned Member | Success |
| Manager invites another Manager | Denied |
| Member creates invitation | Denied |
| Invitation for existing member | Conflict / appropriate service response |
| Cross-org reporting assignment | Denied |
| Token stored in DB | Only token hash exists |
| Invitation expiration | Expired invitation rejected |

The developer should add these as automated tests.

---

## 28. Definition of Done

An API task is complete when:

- [ ] API Specification requirements are satisfied.
- [ ] Request validation is implemented.
- [ ] Authentication is implemented where required.
- [ ] Authorization is implemented where required.
- [ ] Organization isolation is enforced.
- [ ] Role/scope rules are enforced.
- [ ] Business logic is in the appropriate service.
- [ ] Data access is in the repository/data-access layer.
- [ ] Required transactions are implemented.
- [ ] Required audit events are generated.
- [ ] Automated tests are added.
- [ ] Existing tests still pass.
- [ ] TypeScript checks pass.
- [ ] Build passes.
- [ ] No secrets are committed.
- [ ] API response/error behavior follows the specification.
- [ ] Documentation is updated when required.
- [ ] Pull Request is ready for review.

---

## 29. Pull Request Requirements

A Pull Request should explain:

```text
What changed?
Why was it needed?
How was it tested?
Are there database/migration changes?
Are there security implications?
```

Example:

```text
## Summary

Implemented invitation creation.

## Authorization

- Super User: Admin/Manager/Member
- Admin: scoped Manager/Member
- Manager: assigned Member only
- Member: denied

## Tests

- valid invitation
- invalid role
- out-of-scope target
- duplicate membership
- token hashing
- expiration

## Database

No migration required.
```

---

## 30. Code Review Checklist

The reviewer should verify:

### API contract

- Does the endpoint match the API Specification?
- Are HTTP method and route correct?
- Are request and response formats correct?

### Validation

- Is all client input validated?
- Are invalid combinations rejected?

### Authentication

- Is authentication required where appropriate?
- Is identity derived from the server-side session?

### Authorization

- Is the correct permission checked?
- Is organization membership checked?
- Is target organization ownership checked?
- Is role/scope checked?
- Are cross-organization requests denied?

### Business logic

- Is business logic in the service?
- Are invalid state transitions rejected?

### Database

- Are Prisma operations in the data-access layer?
- Are transactions used where required?
- Could the operation leave an invalid partial state?

### Security

- Are passwords/tokens protected?
- Are generic authentication responses used where necessary?
- Are sensitive denials audited?
- Are secrets absent from logs?

### Tests

- Are acceptance criteria covered?
- Are negative authorization tests included?
- Are tenant-isolation tests included?
- Are existing tests still passing?

---

## 31. Development Workflow

The complete development workflow is:

```text
Task / Issue
     ↓
Acceptance criteria
     ↓
Test cases
     ↓
Assignment
     ↓
Feature / fix branch
     ↓
Read API Specification
     ↓
Read relevant product/database rules
     ↓
Implement
     ↓
Write automated tests
     ↓
Run local checks
     ↓
Commit
     ↓
Push
     ↓
Pull Request
     ↓
CI
     ↓
Code review
     ↓
Fix review feedback
     ↓
Approval
     ↓
Merge
     ↓
Delete branch
```

The exact branch naming, commit format, PR template, and reviewer rules will be defined in the separate Team Development Workflow document.

---

## 32. What Developers Must Not Do

Do not:

- trust client-supplied roles;
- trust client-supplied user identity;
- skip organization checks;
- duplicate authorization logic across controllers;
- put complex business logic inside routes;
- put Prisma queries directly into controllers when a repository/data-access layer is appropriate;
- store raw authentication tokens;
- log passwords or secrets;
- modify audit records;
- bypass transactions for atomic privileged operations;
- create an endpoint that is not defined by the API Specification without updating the specification;
- weaken authorization just to make a test pass.

---

## 33. Source-of-Truth Hierarchy

When implementing an endpoint:

```text
Product & Authorization Specification
              ↓
Approved Database Design
              ↓
API Specification
              ↓
API Development Guide
              ↓
Implementation
```

The Product & Authorization Specification defines intended product behavior and authorization.

The Database Design defines persistence structure and database invariants.

The API Specification defines the HTTP interface.

This guide defines the implementation process.

If an implementation reveals a genuine conflict or missing rule, do not silently invent behavior. Raise the issue, decide the rule, and update the appropriate source document.

---

## 34. Final Rule

The goal is not simply:

> "Make the endpoint work."

The goal is:

> "Implement the endpoint according to the product rules, database invariants, authorization model, API contract, security requirements, and testable acceptance criteria."

That is the development standard for this project.
