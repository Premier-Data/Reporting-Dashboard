# Worktree Setup Note — Supabase Egress Optimization

## Worktree
- **Path:** `c:\Users\AndyDin\reporting-dashboard\.worktrees\egress-opt`
- **Branch:** `perf/supabase-egress` (created off `main`)
- **Main tree:** untouched (still on `main`, dev server may be running on port 3000)

## Env files copied
Copied from `c:\Users\AndyDin\reporting-dashboard\reporting-ui\` into
`c:\Users\AndyDin\reporting-dashboard\.worktrees\egress-opt\reporting-ui\`:
- `.env`
- `.env.local`

## node_modules junction (FLAGGED FOR REMOVAL AT CLEANUP)
A reversible directory junction was created (gitignored):

- **Junction:** `c:\Users\AndyDin\reporting-dashboard\.worktrees\egress-opt\reporting-ui\node_modules`
- **Target:** `c:\Users\AndyDin\reporting-dashboard\reporting-ui\node_modules`

> ⚠️ The orchestrator MUST remove this junction BEFORE removing the worktree,
> otherwise worktree removal may follow the junction into the real
> `node_modules`. Remove with:
>
> ```
> cmd /c rmdir c:\Users\AndyDin\reporting-dashboard\.worktrees\egress-opt\reporting-ui\node_modules
> ```
>
> (`rmdir` without `/S` on a junction removes only the link, not the target.)

## Do NOT
- Do not commit, merge, or remove the worktree in this setup step.
