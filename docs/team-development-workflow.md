# Team Access Control API — Team Development Workflow

**Project:** Team Access Control API  
**Status:** Development baseline  
**Version:** 1.0

## 1. Purpose

This document defines how the team takes work from an assigned task to a merged change.

The workflow is designed to make every change:

- clearly defined;
- independently implementable;
- testable;
- reviewable;
- traceable;
- safe to merge.

The API Specification defines **what the API should do**.

The API Development Guide defines **how an API should be implemented**.

This document defines **how the team collaborates to build, review, and merge that implementation**.

---

## 2. Development Workflow

The standard workflow is:

```text
Task / Issue
     ↓
Acceptance Criteria
     ↓
Test Cases
     ↓
Assignment
     ↓
Feature / Fix Branch
     ↓
Implementation
     ↓
Automated Tests
     ↓
Local Checks
     ↓
Commit
     ↓
Push
     ↓
Pull Request
     ↓
CI
     ↓
Code Review
     ↓
Changes if Required
     ↓
Approval
     ↓
Merge
     ↓
Delete Branch
```

No developer should begin implementation of a significant API task without knowing what constitutes successful completion.

---

## 3. Task / Issue Creation

Every meaningful piece of work should begin as a task or issue.

A task should describe:

```text
Title
Description
Relevant API endpoint(s)
Acceptance criteria
Test cases
Dependencies
Notes / constraints
```

Example:

```text
Title:
Implement POST /auth/login

Description:
Implement user login using the authentication rules
defined by the API Specification.

Acceptance criteria:
- Valid credentials authenticate the user.
- Password is verified with Argon2id.
- A server-managed session is created.
- Only a secure session-token hash is stored.
- A secure HttpOnly cookie is returned.
- Invalid credentials do not reveal account existence.
- Login is rate limited.
```

---

## 4. Acceptance Criteria

Acceptance criteria define what must be true for the task to be considered complete.

They should be:

- specific;
- observable;
- testable;
- connected to the specification.

Avoid vague criteria such as:

```text
"Make login work."
```

Prefer:

```text
"Valid credentials create a session and set the
secure HttpOnly session cookie."
```

For authorization tasks, explicitly state the allowed and denied roles/scopes.

---

## 5. Test Cases Before Implementation

Test cases should be defined when the task is created.

The purpose is to establish the expected behavior before implementation begins.

For an authorization endpoint, include:

```text
Happy path
Invalid input
Unauthenticated request
Insufficient permission
Out-of-scope target
Cross-organization target
Invalid state transition
Database invariant
Security-sensitive behavior
```

Example:

```text
Task:
PATCH /organizations/:organizationId/memberships/:membershipId

Tests:
✓ Super User can update an in-scope membership.
✓ Admin can update a membership in Admin scope.
✓ Manager can update directly assigned Member.
✗ Manager cannot update another Manager.
✗ Manager cannot update an unassigned Member.
✗ Cross-organization membership is rejected.
✗ Invalid role/reporting combination is rejected.
```

These cases become automated tests during implementation.

---

## 6. Task Assignment

After the task and its acceptance criteria are ready, assign it to a developer.

The assigned developer should confirm that they understand:

- the task;
- the relevant API specification;
- the acceptance criteria;
- the test cases;
- dependencies;
- expected output.

If an important requirement is ambiguous, resolve it before implementation rather than letting developers make conflicting assumptions.

---

## 7. Branching Strategy

Each task should be implemented in its own branch.

Do not develop unrelated features directly on the main branch.

Recommended branch naming:

### Features

```text
feature/login
feature/invitation-create
feature/membership-update
```

### Fixes

```text
fix/session-expiration
fix/cross-org-membership-access
fix/invitation-acceptance
```

### Refactoring

```text
refactor/auth-service
refactor/authorization-service
```

### Tests

```text
test/membership-authorization
test/invitation-service
```

The branch should normally be created from the latest `main`.

Example:

```bash
git switch main
git pull
git switch -c feature/login
```

---

## 8. Implementation

The developer implements the task according to:

1. Product & Authorization Specification.
2. Approved Database Design.
3. API Specification.
4. API Development Guide.
5. Task acceptance criteria.

The developer should not silently change API behavior because an alternative implementation seems easier.

If implementation reveals a genuine specification problem:

```text
Stop
 ↓
Raise the issue
 ↓
Decide the required behavior
 ↓
Update the relevant specification
 ↓
Continue implementation
```

---

## 9. Developer Responsibilities

The developer is responsible for:

- implementing the assigned behavior;
- following project architecture;
- adding validation;
- implementing authentication where required;
- implementing authorization where required;
- enforcing tenant isolation;
- implementing required transactions;
- adding required audit events;
- writing automated tests;
- running local checks;
- keeping the change focused;
- documenting relevant changes;
- creating a clear commit;
- opening a Pull Request.

The developer should not rely on the reviewer to discover missing basic tests or obvious specification requirements.

---

## 10. Automated Tests

The developer must write tests for the behavior introduced by the task.

At minimum, tests should cover the acceptance criteria.

For authorization-heavy features, negative tests are particularly important.

Example:

```text
Allowed:
Super User → update Member

Denied:
Admin → update another Admin
Manager → update another Manager
Manager → update unassigned Member
Member → update Member
Organization A actor → Organization B target
```

A test suite that checks only successful requests is insufficient for this project.

---

## 11. Local Verification

Before opening a Pull Request, the developer should run the project's required checks.

The exact npm scripts will be defined by the repository, but the expected categories are:

```bash
npm test
npx tsc --noEmit
npm run build
```

If linting is configured:

```bash
npm run lint
```

The developer should also perform relevant manual/API checks when appropriate.

For example:

```bash
curl ...
```

or use the project's API documentation/testing tooling.

Do not open a Pull Request while knowingly failing local checks unless the failure is explicitly documented and part of the task.

---

## 12. Commit Strategy

Commits should represent coherent changes.

Recommended conventional commit style:

```text
feat: add login endpoint
feat: add invitation authorization
fix: prevent cross-org membership access
test: add membership scope tests
refactor: extract authorization service
docs: update invitation API specification
chore: configure test environment
```

Avoid vague commits:

```text
update
changes
fix stuff
work
final
```

Keep commits small enough that a reviewer can understand the change.

Do not commit:

- `.env`;
- passwords;
- API keys;
- session tokens;
- invitation tokens;
- generated secrets;
- local machine configuration that does not belong in the repository.

---

## 13. Push the Branch

After local verification:

```bash
git push -u origin feature/login
```

The first push should establish the upstream branch.

Subsequent pushes can normally use:

```bash
git push
```

---

## 14. Pull Request

Create a Pull Request from the feature branch into `main`.

The PR should clearly explain:

```text
What changed?
Why?
How was it tested?
Any database changes?
Any security implications?
```

Recommended PR structure:

```markdown
### Summary

Implemented `POST /auth/login`.

### Changes

- Added login validation.
- Added Argon2id password verification.
- Added session creation.
- Added secure session cookie.
- Added rate-limit handling.

### Tests

- valid login
- invalid password
- unknown account
- rate limiting
- session creation

### Database

No migration required.

### Security

- Raw session token is not stored.
- Authentication failures use generic responses.
```

---

## 15. CI

The Pull Request should trigger automated CI.

At minimum, CI should eventually verify:

```text
Install dependencies
      ↓
TypeScript check
      ↓
Lint
      ↓
Automated tests
      ↓
Build
```

A PR should not be approved while required CI checks are failing.

CI is an automated safety gate; it does not replace human code review.

---

## 16. Code Review

The reviewer should review the implementation against:

### Specification

- Does it match the API Specification?
- Does it follow product rules?
- Does it respect database invariants?

### Architecture

- Is the code in the correct module?
- Are routes thin?
- Are controllers focused on HTTP concerns?
- Is business logic in services?
- Is data access appropriately separated?

### Authentication

- Is identity derived from the server-side session?
- Are sessions validated correctly?

### Authorization

- Is the correct permission checked?
- Is active organization membership checked?
- Is target resource organization verified?
- Is role/scope enforced?
- Are cross-organization accesses denied?

### Security

- Are passwords and tokens protected?
- Are sensitive operations audited?
- Are generic authentication responses used where required?
- Are secrets absent from logs?

### Database

- Are transactions used where necessary?
- Can the operation leave an invalid state?
- Are reporting relationships valid?

### Tests

- Do tests cover acceptance criteria?
- Are negative authorization cases included?
- Are tenant-isolation cases included?
- Do existing tests still pass?

---

## 17. Review Comments

Review comments should be specific and actionable.

Good:

```text
This membership lookup only filters by membershipId.
Please also constrain it by organizationId so a membership
from another organization cannot be accessed through this route.
```

Poor:

```text
This is wrong.
```

If a comment is a blocking correctness/security issue, make that clear.

---

## 18. Handling Review Feedback

If changes are requested:

```text
Developer
   ↓
Fix requested issue
   ↓
Add/update tests if needed
   ↓
Run checks
   ↓
Push changes
   ↓
Reviewer re-checks
```

Do not merge merely because the original PR was approved before additional changes were requested.

The final PR state must be the reviewed state.

---

## 19. Approval

A reviewer should approve only when:

- acceptance criteria are satisfied;
- required tests exist;
- CI passes;
- security requirements are satisfied;
- no blocking review comments remain;
- implementation follows the project's architecture.

Approval means:

> I have reviewed this change and believe it is ready to be merged.

---

## 20. Merge

After approval and successful required checks, merge the Pull Request into `main`.

The repository should use a consistent merge strategy.

For a small team, **squash merge** is a reasonable default because it keeps the main branch history focused on completed changes.

Example resulting history:

```text
main
 |
 |-- feat: implement invitation creation
 |
 |-- feat: implement login
 |
 |-- fix: prevent cross-org access
```

The exact merge strategy can be changed later if the team adopts a different Git policy.

---

## 21. After Merge

After merging:

1. Confirm the change is present on `main`.
2. Delete the feature branch.
3. Update the local repository.
4. Start the next task from the latest `main`.

Example:

```bash
git switch main
git pull
git branch -d feature/login
```

Delete the remote branch through the Git hosting platform if it is not automatically deleted.

---

## 22. Keeping the Main Branch Stable

`main` should represent code that is:

- buildable;
- tested;
- reviewed;
- integrated.

Do not push unfinished feature work directly to `main`.

Do not use `main` as a personal development branch.

---

## 23. Handling Database Changes

If a task requires a database change:

```text
Task
 ↓
Identify schema change
 ↓
Update Prisma schema
 ↓
Create migration
 ↓
Test migration
 ↓
Update seed/integrity tests if required
 ↓
Implement application change
 ↓
Run tests
 ↓
PR
```

The Pull Request must clearly identify database/migration changes.

Do not manually modify the production database as a substitute for a migration.

---

## 24. Handling Specification Changes

Sometimes implementation reveals that the existing specification is incomplete or incorrect.

Do not silently change behavior.

Use:

```text
Problem identified
       ↓
Discuss / decide
       ↓
Update source-of-truth document
       ↓
Update API specification if necessary
       ↓
Update tests
       ↓
Implement
```

The relevant source document should be updated before the implementation is treated as final.

---

## 25. Task Splitting

Large tasks should be split into smaller tasks when possible.

Instead of:

```text
Implement authentication
```

prefer:

```text
Implement registration
Implement email verification
Implement login
Implement logout
Implement password change
Implement password reset
Implement session management
```

This makes:

- assignment easier;
- review easier;
- testing easier;
- branches smaller;
- merge conflicts less likely.

---

## 26. Parallel Team Development

Multiple developers can work simultaneously:

```text
main
 ├── feature/register
 ├── feature/login
 ├── feature/membership-update
 └── feature/invitation-create
```

Each developer owns their branch and Pull Request.

Avoid having multiple developers modify the same files unnecessarily.

When dependencies exist, identify them explicitly.

Example:

```text
authorization-service
        ↓
membership-update
        ↓
membership-update-tests
```

The dependent task should not assume the prerequisite exists unless the dependency is available.

---

## 27. Avoiding Merge Conflicts

To reduce conflicts:

- keep branches focused;
- avoid unrelated formatting changes;
- avoid changing shared files unnecessarily;
- pull/rebase/update from `main` according to team policy;
- communicate when a shared file must be changed.

Do not mix unrelated refactoring into a feature PR.

For example, a login PR should not also rename every service file in the project.

---

## 28. Emergency Fixes

Critical security or production issues may require a hotfix.

Recommended naming:

```text
hotfix/session-security
hotfix/cross-org-data-leak
```

The hotfix should still:

- have a clear description;
- include a regression test where possible;
- receive review;
- pass required checks;
- be merged through the repository's normal controlled process.

After the hotfix, verify whether the relevant specification or development guide needs updating.

---

## 29. Definition of Ready

A task is **Ready for Development** when:

- [ ] Task has a clear description.
- [ ] Relevant endpoint/module is identified.
- [ ] Acceptance criteria are written.
- [ ] Test cases are written.
- [ ] Dependencies are identified.
- [ ] Relevant specification sections are known.
- [ ] No unresolved requirement ambiguity blocks implementation.

---

## 30. Definition of Done

A task is **Done** when:

- [ ] Implementation is complete.
- [ ] Acceptance criteria are satisfied.
- [ ] Automated tests are added.
- [ ] Relevant negative/security tests are added.
- [ ] Local checks pass.
- [ ] CI passes.
- [ ] PR is reviewed.
- [ ] Review feedback is resolved.
- [ ] PR is approved.
- [ ] PR is merged.
- [ ] Feature branch is deleted.
- [ ] Main branch contains the final reviewed implementation.

---

## 31. Team Roles

For a small team, the same person may perform multiple roles, but the responsibilities remain distinct.

### Developer

Responsible for:

- implementation;
- tests;
- local verification;
- PR preparation;
- responding to review feedback.

### Reviewer

Responsible for:

- correctness;
- architecture;
- security;
- authorization;
- test quality;
- specification compliance.

### Maintainer / Project Owner

Responsible for:

- task prioritization;
- resolving specification ambiguity;
- final acceptance;
- merge policy;
- maintaining project standards.

---

## 32. Recommended PR Checklist

Every PR should use a checklist similar to:

```markdown
## Checklist

- [ ] Task requirements are satisfied.
- [ ] API Specification was followed.
- [ ] Validation is implemented.
- [ ] Authentication is correct.
- [ ] Authorization is correct.
- [ ] Tenant isolation is enforced.
- [ ] Required transactions are used.
- [ ] Required audit events are implemented.
- [ ] Automated tests were added.
- [ ] Negative/security tests were added.
- [ ] Existing tests pass.
- [ ] TypeScript check passes.
- [ ] Build passes.
- [ ] No secrets are committed.
- [ ] Documentation updated if required.
- [ ] Ready for review.
```

---

## 33. Example Complete Task Lifecycle

Suppose the task is:

```text
Implement POST /auth/login
```

The lifecycle is:

```text
1. Create issue
      ↓
2. Write acceptance criteria
      ↓
3. Write test cases
      ↓
4. Assign developer
      ↓
5. Developer creates:
   feature/login
      ↓
6. Developer reads:
   - API Specification
   - Product rules
   - Database design
   - API Development Guide
      ↓
7. Implement validation
      ↓
8. Implement authentication
      ↓
9. Implement session creation
      ↓
10. Add automated tests
      ↓
11. Run:
    npm test
    npx tsc --noEmit
    npm run build
      ↓
12. Commit
      ↓
13. Push
      ↓
14. Open PR
      ↓
15. CI runs
      ↓
16. Reviewer checks code
      ↓
17. Developer fixes feedback if needed
      ↓
18. Reviewer approves
      ↓
19. Merge into main
      ↓
20. Delete feature/login
```

---

## 34. Source-of-Truth Hierarchy

The team's documentation should be interpreted as:

```text
Product & Authorization Specification
                ↓
Approved Database Design
                ↓
API Specification
                ↓
API Development Guide
                ↓
Team Development Workflow
                ↓
Implementation
```

The documents have different responsibilities.

```text
Product Specification
"What should the system do?"

Database Design
"How must the data and database invariants work?"

API Specification
"What HTTP API exposes those capabilities?"

API Development Guide
"How should developers implement the API?"

Team Development Workflow
"How should the team build, review, and merge the implementation?"
```

If a conflict is discovered, do not silently choose an interpretation. Resolve it and update the appropriate document.

---

## 35. Final Team Rule

A task is not complete because:

```text
"The developer says it works."
```

It is complete when:

```text
Requirement
    ↓
Acceptance criteria
    ↓
Test cases
    ↓
Implementation
    ↓
Automated verification
    ↓
Code review
    ↓
Approval
    ↓
Merge
```

The objective is to make correctness a repeatable team process rather than relying on one person's memory or judgment.
