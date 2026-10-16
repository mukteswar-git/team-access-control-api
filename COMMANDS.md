# Team Access Control API — Development Commands

A quick reference for commands used regularly in this project. Run project commands from the repository root.

## 1. Daily checks

```bash
# Run the full Jest test suite using .env.test
npm test

# Run one test file
npm test -- tests/repositories/session.repository.test.ts

# TypeScript type-check
npx tsc --noEmit

# Check formatting
npx prettier --check .

# Automatically format files
npx prettier --write .
```

## 2. Docker

```bash
# Build and start services (first setup or apply changes)
docker compose up -d --build

# Start existing stopped containers
docker compose start

# See running containers
docker ps

# Stop services
docker compose stop

# Restart services
docker compose restart
```

`docker start` works only if those containers already exist. Check `docker ps -a` if Docker says a container cannot be found.

## 3. Prisma and database

```bash
# Generate Prisma Client after schema changes
npx prisma generate

# Create and apply a development migration
npx prisma migrate dev --name describe_your_change

# Check migration status
npx prisma migrate status

# Open Prisma Studio
npx prisma studio
```

Use a meaningful migration name, for example `add_membership_indexes`.

**Important:** Confirm the active `DATABASE_URL` before running migration commands. Do not run development migrations against the test or production database.

## 4. Git: issue workflow

```bash
# Check current branch and working tree
git status

# Review unstaged changes
git diff

# Review staged changes
git diff --cached

# Create a feature branch from the current branch
git switch -c feat/short-issue-name

# Stage changes (review before committing)
git add .
git status
git diff --cached --stat

# Commit
git commit -m "feat: describe the change"

# Push a new branch and set upstream
git push -u origin feat/short-issue-name

# Push later commits on the same branch
git push
```

Prefer staging specific files when unrelated changes may be present. Before using `git add .`, check `git status`.

## 5. After a pull request is merged

```bash
# Return to main
git switch main

# Update local main
git pull origin main

# Delete the local feature branch after it has been merged
git branch -d feat/short-issue-name

# List local branches
git branch

# List local and remote branches
git branch -a
```

Only delete a branch after confirming the pull request was merged and you no longer need the branch.

## 6. Useful inspection commands

```bash
# Show recent commits
git log --oneline -10

# Show changed files and summary
git diff --stat
git diff --cached --stat

# List project files (if tree is installed)
tree -I 'node_modules|.git|dist|coverage'

# Check Node and npm versions
node --version
npm --version
```

## 7. Recommended check sequence before committing

Run these from the repository root:

```bash
npm test
npx tsc --noEmit
npx prettier --check .
git status
git diff
```

If formatting fails, run Prettier on the reported files (or `npx prettier --write .` if the entire project should be formatted), then rerun the checks.

## 8. Safety reminders

- Never commit `.env`, `.env.test`, credentials, tokens, or database dumps.
- Keep `.env.example` free of real secrets.
- Verify `DATABASE_URL` before running migrations or destructive database commands.
- Do not use `prisma migrate reset` unless you intentionally want to erase the target database.
- Do not run `docker rm` or `docker volume rm` casually; they can destroy local development data.
- Keep this file updated when a new command becomes part of the regular workflow.
