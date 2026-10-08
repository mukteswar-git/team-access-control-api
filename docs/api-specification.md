# Team Access Control API — API Specification

**Product:** Team Access Control API  
**Status:** Implementation baseline  
**Version:** 1.0

## 1. Purpose

This document defines the HTTP API surface for the Team Access Control API.

The Product & Authorization Specification is the source of truth for product behavior and authorization rules. The approved Database Design is the source of truth for persistence structure and database invariants.

---

## 2. API Principles

### 2.1 Authentication and authorization are separate

Authentication establishes the user's identity.

Authorization determines what the user may do within a particular organization and against a particular resource.

Every protected organization-scoped operation must evaluate:

1. Valid session.
2. Target organization.
3. Active membership in that organization.
4. Required permission.
5. Target resource belongs to that organization.
6. Role and administrative/resource scope.
7. Allow or deny.

### 2.2 Tenant isolation

Organizations are hard tenant boundaries.

A resource identifier from Organization B must never allow a user acting in Organization A to access Organization B's resource.

Client-supplied organization IDs, roles, membership IDs, Admin assignments, and Manager assignments are never trusted as authorization facts.

### 2.3 Deny by default

Actions not explicitly permitted by the authorization rules must be denied.

### 2.4 Permission and scope are separate

A role having a permission does not automatically grant organization-wide access to the corresponding resource.

---

## 3. API Conventions

### 3.1 Base path

No version prefix is required at this stage.

Example:

```text
POST /auth/login
```

### 3.2 Content type

JSON requests and responses use:

```text
Content-Type: application/json
```

unless explicitly stated otherwise.

### 3.3 Authentication

Authentication uses server-managed sessions delivered through secure cookies.

Cookies must use:

- Secure
- HttpOnly
- appropriate SameSite policy

State-changing browser requests must have CSRF protection.

### 3.4 Identifiers

Resource identifiers use UUIDs unless explicitly stated otherwise.

Invitation acceptance uses an opaque token.

### 3.5 Timestamps

Timestamps use ISO 8601 representation.

Example:

```text
2026-10-08T10:30:00Z
```

---

## 4. Error Model

Proposed standard error shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": []
  }
}
```

Validation example:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "details": [
      {
        "field": "email",
        "message": "Invalid email address."
      }
    ]
  }
}
```

The API must never expose passwords, raw authentication tokens, database credentials, or other secrets.

Authentication-sensitive operations should use generic responses where necessary to prevent account enumeration.

The final error-code catalog will be defined before implementation.

---

## 5. Authentication API

The authentication API supports registration, email verification, login, logout, password change, password recovery/reset, and session authentication.

### 5.1 Register

#### `POST /auth/register`

Create a global user account.

**Authentication:** None.

#### Request

```json
{
  "email": "user@example.com",
  "password": "..."
}
```

#### Behavior

1. Validate input.
2. Normalize email.
3. Check account uniqueness.
4. Hash the password using Argon2id.
5. Create the user.
6. Create an email-verification token.
7. Send verification email.

Registration does not create an organization.

#### Success

```text
201 Created
```

#### Possible errors

```text
400 Bad Request
409 Conflict
429 Too Many Requests
```

---

### 5.2 Verify email

#### `GET /auth/verify-email`

Verify an email using a single-use verification token.

**Authentication:** None.

#### Query

```text
?token=<opaque-token>
```

#### Behavior

- Validate token.
- Check expiration.
- Check that it has not been used.
- Mark the email as verified.
- Consume the token.
- Perform verification transactionally.

---

### 5.3 Login

#### `POST /auth/login`

Authenticate a user and create a server-managed session.

**Authentication:** None.

#### Request

```json
{
  "email": "user@example.com",
  "password": "..."
}
```

#### Behavior

1. Validate input.
2. Normalize email.
3. Find user.
4. Verify password using Argon2id.
5. Create session.
6. Store a secure session-token hash.
7. Set the secure HttpOnly session cookie.
8. Record the appropriate authentication/security event.

#### Success

```text
200 OK
```

#### Possible errors

```text
400 Bad Request
401 Unauthorized
429 Too Many Requests
```

Authentication failures must not reveal whether the email exists.

---

### 5.4 Logout

#### `POST /auth/logout`

Revoke the current session.

**Authentication:** Required.

This operation affects only the current session.

#### Success

```text
204 No Content
```

---

### 5.5 Current user

#### `GET /auth/me`

Return the currently authenticated global user.

**Authentication:** Required.

**API design decision:** This endpoint is not explicitly defined by the Product Specification. It is included as a practical API endpoint for clients to determine the current authenticated identity.

#### Response

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "emailVerifiedAt": "2026-10-08T10:30:00Z"
}
```

---

### 5.6 Change password

#### `POST /auth/password/change`

Change the password for the authenticated user.

**Authentication:** Required.

#### Request

```json
{
  "currentPassword": "...",
  "newPassword": "..."
}
```

#### Behavior

1. Validate session.
2. Verify current password.
3. Validate new password.
4. Hash the new password using Argon2id.
5. Update password.
6. Revoke all existing sessions.
7. Require authentication again.

The operation must be transactional.

---

### 5.7 Forgot password

#### `POST /auth/password/forgot`

Start password recovery.

**Authentication:** None.

#### Request

```json
{
  "email": "user@example.com"
}
```

#### Behavior

- Normalize email.
- Generate a cryptographically secure reset token when appropriate.
- Store only its secure hash.
- Apply expiration.
- Send reset email.

The response must not reveal whether the account exists.

#### Success

```text
202 Accepted
```

---

### 5.8 Reset password

#### `POST /auth/password/reset`

Reset a password using a valid reset token.

**Authentication:** None.

#### Request

```json
{
  "token": "...",
  "password": "..."
}
```

#### Behavior

1. Validate token.
2. Check expiration.
3. Check single-use state.
4. Hash the new password using Argon2id.
5. Update password.
6. Consume the token.
7. Revoke all existing sessions.

The operation must be transactional.

---

## 6. Organization API

### 6.1 Create organization

#### `POST /organizations`

Create an organization.

**Authentication:** Required.

**Email verification:** Required.

#### Request

```json
{
  "name": "Acme Inc"
}
```

#### Behavior

Create atomically:

1. Organization.
2. Initial membership.
3. Super User role assignment.

The creator becomes the organization's sole Super User/Owner.

#### Success

```text
201 Created
```

Organization creation is an account-level capability, not an organization-role permission.

---

### 6.2 Get organization

#### `GET /organizations/:organizationId`

View basic organization information.

**Authentication:** Required.

**Permission:** `organization.read`

**Scope:** Actor must have an active membership in the requested organization.

#### Response

```json
{
  "id": "uuid",
  "name": "Acme Inc",
  "createdAt": "...",
  "updatedAt": "..."
}
```

---

### 6.3 Update organization

#### `PATCH /organizations/:organizationId`

Update organization settings.

**Authentication:** Required.

**Permission:** `organization.manage`

**Role:** Super User only.

#### Request

```json
{
  "name": "Acme Corporation"
}
```

#### Behavior

1. Validate input.
2. Authorize Super User.
3. Update organization.
4. Append audit event.

---

### 6.4 Transfer ownership

#### `POST /organizations/:organizationId/transfer-ownership`

Transfer Super User/Owner status to an existing organization member.

**Authentication:** Required.

**Permission:** `organization.manage`

**Role:** Current Super User only.

#### Request

```json
{
  "targetMembershipId": "uuid"
}
```

#### Rules

- Target must already be an organization member.
- Target must be eligible to become Super User.
- Current Super User cannot be directly removed or demoted.
- Previous Super User becomes Admin.
- Target becomes Super User.
- Organization must never have zero or more than one Super User.

#### Transaction

The operation must be atomic.

#### Audit

A successful ownership transfer must be audited.

---

## 7. Membership API

Memberships represent a user's relationship with one organization and contain the organization-specific role and applicable reporting assignments.

### 7.1 List memberships

#### `GET /organizations/:organizationId/memberships`

View organization members and reporting structure.

**Authentication:** Required.

**Permission:** `membership.read`

**Scope:** Active membership in the organization.

All organization members may view the organization directory and reporting structure. Visibility does not grant management authority.

#### Proposed query parameters

```text
?page=1&limit=50
```

---

### 7.2 Get membership

#### `GET /organizations/:organizationId/memberships/:membershipId`

View one membership.

**Authentication:** Required.

**Permission:** `membership.read`

The membership must belong to the requested organization.

---

### 7.3 Update membership

#### `PATCH /organizations/:organizationId/memberships/:membershipId`

Change a membership's role or reporting assignment.

**Authentication:** Required.

**Permission:** `membership.update`

**Scope:** Target membership must be within the actor's administrative scope.

#### Proposed requests

Manager:

```json
{
  "role": "manager",
  "adminMembershipId": "uuid"
}
```

Member:

```json
{
  "role": "member",
  "managerMembershipId": "uuid"
}
```

The final schema must enforce valid role/reporting combinations.

#### Scope rules

**Super User**

- Organization-wide scope.

**Admin**

- Managers assigned to that Admin.
- Members assigned to those Managers.
- Unassigned Members.
- Not other Admins, the Super User, other Admins' Managers/Members, or unassigned Managers.

**Manager**

- Members directly assigned to that Manager only.

**Member**

- No membership-management authority.

#### Role transition rules

- Promoting a Member to Manager clears the Member's Manager assignment.
- Promoting a Manager to Admin clears the Manager's Admin assignment.
- Moving a Manager between Admins moves that Manager and its direct Members between Admin scopes.
- Moving a Member between Managers changes the Member's administrative scope.
- Reporting references must remain within the same organization.

#### Transaction

Authorization and mutation must be atomic.

#### Audit

Role and reporting-assignment changes must be audited.

---

### 7.4 Remove membership

#### `DELETE /organizations/:organizationId/memberships/:membershipId`

Remove a membership.

**Authentication:** Required.

**Permission:** `membership.remove`

**Scope:** Target must be within actor's administrative scope.

#### Rules

- Current Super User cannot be directly removed.
- Ownership must first be transferred.
- Removing a Manager leaves direct Members as organization members but unassigned.
- Removing an Admin leaves that Admin's Managers unassigned.
- Those Managers' Members remain assigned to those Managers.
- Removing a membership ends organization-specific access immediately.
- The user's global account and other organization memberships remain unaffected.

#### Audit

Membership removal must be audited.

---

## 8. Invitation API

Invitations are opaque, single-use offers bound to a normalized email address, organization, role, and permitted reporting assignment. They expire after seven calendar days.

### 8.1 Create invitation

#### `POST /organizations/:organizationId/invitations`

**Authentication:** Required.

**Permission:** `invitation.create`

#### Example Manager invitation

```json
{
  "email": "manager@example.com",
  "role": "manager",
  "adminMembershipId": "uuid"
}
```

#### Example Member invitation

```json
{
  "email": "member@example.com",
  "role": "member",
  "managerMembershipId": "uuid"
}
```

#### Authorization

**Super User**

- May invite Admin, Manager, or Member.
- May choose valid reporting assignments.

**Admin**

- May invite Manager assigned to the inviting Admin.
- May invite Member assigned to a Manager in the Admin's scope or left unassigned.

**Manager**

- May invite Member only.
- Member must be assigned to the inviting Manager.

**Member**

- Cannot create invitations.

#### Behavior

1. Normalize email.
2. Validate target role and reporting assignment.
3. Check inviter permission and scope.
4. Check for duplicate membership.
5. Handle duplicate pending invitation according to service rules.
6. Generate opaque cryptographically secure token.
7. Store only token hash.
8. Set seven-calendar-day expiration.
9. Create invitation.
10. Record audit event.
11. Send invitation email.

---

### 8.2 Revoke invitation

#### `POST /organizations/:organizationId/invitations/:invitationId/revoke`

**Authentication:** Required.

**Permission:** `invitation.revoke`

**Scope:** Invitation must be within actor's permitted scope.

#### Behavior

Set `revokedAt`.

Do not physically delete the invitation.

#### Audit

Record invitation revocation.

---

### 8.3 Accept invitation

#### `POST /invitations/:token/accept`

Existing account: authentication required.

New recipient: account creation and email verification must occur before acceptance.

#### Behavior

1. Hash token.
2. Find invitation.
3. Verify pending state.
4. Verify expiration.
5. Verify authenticated verified email exactly matches invitation email.
6. Revalidate role.
7. Revalidate reporting assignment.
8. Check existing membership.
9. Create membership if appropriate.
10. Mark invitation accepted.
11. Record audit event.

#### Transaction

Membership creation and invitation acceptance must be atomic.

#### Existing member

If the user is already a member:

- do not create a second membership;
- do not change the existing role;
- do not change the existing reporting assignment;
- close the invitation without creating a duplicate membership.

#### Invalid invitation

Expired, revoked, accepted, or otherwise invalid invitations cannot be reused.

---

### 8.4 Invitation list/view endpoints

The approved permission catalog defines `invitation.create` and `invitation.revoke`, but does not define `invitation.read`.

Therefore these endpoints are intentionally **not included in API v1**:

```text
GET /organizations/:organizationId/invitations
GET /organizations/:organizationId/invitations/:invitationId
```

They may be added later if the team defines their authorization semantics.

---

## 9. Session API

Sessions authenticate the global user account and are not organization memberships.

### 9.1 List own sessions

#### `GET /sessions`

**Authentication:** Required.

**Permission:** `session.manage_self`

**Scope:** Current user only.

#### Response

```json
{
  "items": [
    {
      "id": "uuid",
      "createdAt": "...",
      "lastUsedAt": "...",
      "expiresAt": "...",
      "current": true
    }
  ]
}
```

---

### 9.2 Revoke own session

#### `DELETE /sessions/:sessionId`

**Authentication:** Required.

**Permission:** `session.manage_self`

**Scope:** Target session must belong to current user.

#### Success

```text
204 No Content
```

---

### 9.3 Logout everywhere

#### `POST /sessions/logout-all`

**Authentication:** Required.

**Permission:** `session.manage_self`

Revoke all active sessions belonging to the current user, including the current session.

---

### 9.4 Revoke another user's session

#### `DELETE /organizations/:organizationId/memberships/:membershipId/sessions/:sessionId`

**Authentication:** Required.

**Permission:** `session.manage_any`

**Scope:** Target membership must be within actor's administrative scope.

The target session must belong to the target membership's user.

- Super User: organization-wide.
- Admin: own administrative scope.
- Manager: own direct Member scope.
- Member: denied.

---

## 10. Audit Log API

Audit logs are append-only and read-only to normal API consumers.

Only Super Users and Admins may view organization audit logs.

### 10.1 List audit logs

#### `GET /organizations/:organizationId/audit-logs`

**Authentication:** Required.

**Permission:** `audit_log.read`

**Role:** Super User or Admin.

#### Proposed query parameters

```text
?page=1
&limit=50
&action=...
&result=success
&actorMembershipId=...
&targetType=...
&targetId=...
&from=...
&to=...
```

#### Response

```json
{
  "items": [
    {
      "id": "uuid",
      "action": "membership.role_changed",
      "result": "success",
      "actor": {
        "userId": "uuid",
        "membershipId": "uuid"
      },
      "target": {
        "type": "membership",
        "id": "uuid"
      },
      "metadata": {},
      "createdAt": "..."
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 125
  }
}
```

---

### 10.2 Get audit log

#### `GET /organizations/:organizationId/audit-logs/:auditLogId`

**Authentication:** Required.

**Permission:** `audit_log.read`

**Role:** Super User or Admin.

The audit record must belong to the requested organization.

---

### 10.3 Audit mutation endpoints

These endpoints do not exist:

```text
POST   /audit-logs
PATCH  /audit-logs/:id
DELETE /audit-logs/:id
```

Audit records are generated by trusted server-side code.

---

## 11. Complete API Route Map

### Authentication

```text
POST /auth/register
GET  /auth/verify-email
POST /auth/login
POST /auth/logout
GET  /auth/me
POST /auth/password/change
POST /auth/password/forgot
POST /auth/password/reset
```

### Organizations

```text
POST  /organizations
GET   /organizations/:organizationId
PATCH /organizations/:organizationId
POST  /organizations/:organizationId/transfer-ownership
```

### Memberships

```text
GET    /organizations/:organizationId/memberships
GET    /organizations/:organizationId/memberships/:membershipId
PATCH  /organizations/:organizationId/memberships/:membershipId
DELETE /organizations/:organizationId/memberships/:membershipId
```

### Invitations

```text
POST /organizations/:organizationId/invitations
POST /organizations/:organizationId/invitations/:invitationId/revoke
POST /invitations/:token/accept
```

### Sessions

```text
GET    /sessions
DELETE /sessions/:sessionId
POST   /sessions/logout-all

DELETE /organizations/:organizationId/memberships/:membershipId/sessions/:sessionId
```

### Audit logs

```text
GET /organizations/:organizationId/audit-logs
GET /organizations/:organizationId/audit-logs/:auditLogId
```

---

## 12. Authorization Summary

| Endpoint | Required authorization |
|---|---|
| `POST /auth/register` | None |
| `GET /auth/verify-email` | Valid verification token |
| `POST /auth/login` | Credentials |
| `POST /auth/logout` | Authenticated session |
| `GET /auth/me` | Authenticated session |
| `POST /auth/password/change` | Authenticated session |
| `POST /auth/password/forgot` | None |
| `POST /auth/password/reset` | Valid reset token |
| `POST /organizations` | Authenticated + verified email |
| `GET /organizations/:id` | `organization.read` + active membership |
| `PATCH /organizations/:id` | `organization.manage` + Super User |
| `POST /organizations/:id/transfer-ownership` | `organization.manage` + current Super User |
| `GET /organizations/:id/memberships` | `membership.read` + active membership |
| `GET /organizations/:id/memberships/:membershipId` | `membership.read` + same organization |
| `PATCH /organizations/:id/memberships/:membershipId` | `membership.update` + target in scope |
| `DELETE /organizations/:id/memberships/:membershipId` | `membership.remove` + target in scope |
| `POST /organizations/:id/invitations` | `invitation.create` + target in scope |
| `POST /organizations/:id/invitations/:invitationId/revoke` | `invitation.revoke` + invitation in scope |
| `POST /invitations/:token/accept` | Valid invitation + matching verified email |
| `GET /sessions` | `session.manage_self` |
| `DELETE /sessions/:sessionId` | `session.manage_self` + own session |
| `POST /sessions/logout-all` | `session.manage_self` |
| `DELETE /organizations/:id/memberships/:membershipId/sessions/:sessionId` | `session.manage_any` + target in scope |
| `GET /organizations/:id/audit-logs` | `audit_log.read` + Super User/Admin |
| `GET /organizations/:id/audit-logs/:auditLogId` | `audit_log.read` + Super User/Admin |

---

## 13. Transaction Requirements

The following operations require atomic authorization checks and mutations:

- Organization creation.
- Ownership transfer.
- Membership role changes.
- Membership reporting-assignment changes.
- Membership removal where reporting relationships change.
- Invitation acceptance.
- Password reset.
- Password change and associated session revocation.

The exact transaction boundaries must follow the approved Database Design.

---

## 14. Audit Requirements

The system must record appropriate events for:

#### Organization

```text
organization.created
organization.settings_updated
organization.ownership_transferred
```

#### Invitations

```text
invitation.created
invitation.resent
invitation.accepted
invitation.revoked
invitation.expired
```

#### Memberships

```text
membership.created
membership.role_changed
membership.admin_assignment_changed
membership.manager_assignment_changed
membership.removed
```

#### Sessions

```text
session.created
session.revoked
session.all_revoked
```

#### Authentication/security

```text
password.changed
password.reset
login.success
logout
```

#### Authorization

Sensitive denials including:

```text
insufficient permission
cross-organization access
Admin-scope failure
Manager-scope failure
out-of-scope target
```

Audit metadata must never contain passwords, raw session tokens, invitation tokens, password-reset tokens, 2FA secrets, or other authentication secrets.

---

## 15. Explicitly Deferred API Decisions

The following are intentionally not finalized yet:

- Exact error-code catalog.
- Exact validation rules for every field.
- Exact pagination implementation.
- Exact audit-log filtering behavior.
- Exact response envelope conventions.
- Exact email-verification/reset URL representation.
- API versioning strategy.
- OpenAPI schema details.

These should be finalized before implementation begins.

---

## 16. Endpoint Implementation Flow

Every protected endpoint should follow this conceptual flow:

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

Controllers should handle HTTP concerns and delegate business rules to services.

Authorization must use trusted server-side state.
