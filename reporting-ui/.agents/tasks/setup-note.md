# Worktree Setup Note — player-category-tally

## Worktree
- **Path:** `c:\Users\AndyDin\reporting-dashboard\.worktrees\player-category-tally`
- **reporting-ui subfolder:** `c:\Users\AndyDin\reporting-dashboard\.worktrees\player-category-tally\reporting-ui`
- **Branch:** `feature/player-category-tally` (created off `main` at commit 31d327b)
- **Base HEAD:** 31d327b — feat(push-activity): show round on each round-summary fixture row

## Env files
Copied from the main tree into the worktree's reporting-ui:
- `.env`  (copied)
- `.env.local`  (copied)

## node_modules junction (REVERSIBLE — must be removed before removing the worktree)
A Windows directory junction (NOT a copy) was created. It is gitignored.
- **Source (junction / link location):** `c:\Users\AndyDin\reporting-dashboard\.worktrees\player-category-tally\reporting-ui\node_modules`
- **Target (points to main tree):** `c:\Users\AndyDin\reporting-dashboard\reporting-ui\node_modules`
- Created with: `cmd /c mklink /J "<source>" "<target>"`
- **Orchestrator action required:** remove this junction BEFORE removing the worktree.
  To remove: `cmd /c rmdir "c:\Users\AndyDin\reporting-dashboard\.worktrees\player-category-tally\reporting-ui\node_modules"`
  (`rmdir` on a junction removes only the link, not the main tree's node_modules.)

## Known worktree artifact (NOT a real failure)
Because node_modules is a junction, in the worktree:
- `npx vitest` can fail with "No test suite found".
- Turbopack `next build` can fail with "Symlink ... out of filesystem root".

These are junction artifacts, not code failures.
- `npx tsc --noEmit` works fine in the worktree (verified passing during setup).
- vitest / full `next build` should be verified in the MAIN tree.
Always note which tree a given command ran in.

## Constraints
- Do NOT disturb the main working tree (on `main`) other than reading env files.
- A dev server on port 3000 belongs to the main tree — do NOT touch it.
- Do NOT commit, merge, or remove the worktree in this step.
