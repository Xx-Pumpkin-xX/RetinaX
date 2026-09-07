# Commit sequence

The course marks *commit history*, and every member needs commits in their own
name. So this file is a suggested sequence rather than a repository that arrives
pre-committed — run these yourselves, split across the team.

Work in this order and each commit builds on a repo that runs. Do not squash it
all into "initial commit": a single commit tells a marker nothing about who did
what or in what order.

## Before the first commit

```bash
git init
git add .gitignore README.md COMMITS.md
git commit -m "chore: repository setup, ignore rules and README"
```

Check `git status` shows no `node_modules/`, no `server/data/`, no `.pth`. If it
does, fix `.gitignore` before committing anything else — a file committed once
stays in the history even after it is deleted.

## The sequence

| # | Commit message | Files |
|---|---|---|
| 1 | `chore: repository setup, ignore rules and README` | `.gitignore` `README.md` `COMMITS.md` |
| 2 | `feat(db): three-table schema for doctors, cases and predictions` | `server/db.js` |
| 3 | `feat(api): doctor authentication with httpOnly session cookie` | `server/server.js` `server/seed.js` `server/package.json` |
| 4 | `feat(api): case upload, listing and per-doctor access control (BR-1)` | `server/server.js` |
| 5 | `feat(ai): FastAPI grading service returning grade and heatmap` | `ai/main.py` `ai/requirements.txt` |
| 6 | `feat(api): grade on upload via the model service` | `server/ai.js` `server/server.js` |
| 7 | `feat(api): agree/disagree marking, enforcing BR-2, BR-3 and BR-4` | `server/server.js` |
| 8 | `feat(api): single-use expiring password reset, token stored hashed` | `server/db.js` `server/server.js` |
| 9 | `feat(web): app shell, routing and API client` | `web/` scaffold, `App.jsx`, `api.js` |
| 10 | `feat(web): sign-in, keep-me-signed-in and password reset screens` | `web/src/pages/Login.jsx` |
| 11 | `feat(web): case worklist` | `web/src/pages/Cases.jsx` |
| 12 | `feat(web): new case form with patient code, eye and image` | `web/src/pages/NewCase.jsx` |
| 13 | `feat(web): case detail with CAM/CCEM overlay and opacity control` | `web/src/pages/CaseDetail.jsx` |
| 14 | `feat(web): agree and disagree flow with required correction reason` | `web/src/pages/CaseDetail.jsx` |
| 15 | `feat(web): light and dark themes with no flash on first paint` | `web/src/styles.css` `web/index.html` |
| 16 | `feat(web): standing decision-support disclaimer on AI-facing screens` | `web/src/pages/*` `styles.css` |
| 17 | `chore(deploy): SPA fallback, VITE_API_URL and Render blueprint` | `web/vercel.json` `web/public/_redirects` `web/.env.example` `render.yaml` |
| 18 | `fix(api): SameSite=None cookie so login works across domains` | `server/server.js` |
| 19 | `feat(server): re-seed demo cases on boot for ephemeral hosting` | `server/seed-demo.js` `server/demo-images/README.md` |
| 20 | `docs: deployment, API reference and business rules` | `README.md` |

## Message convention

`type(scope): what changed, in the imperative`

`feat` a capability · `fix` a defect · `chore` tooling and config · `docs`
documentation · `refactor` no behaviour change.

Write what the commit *does to the product*, not what you typed.
`feat(api): reject a correction with no reason (BR-3)` is a commit message;
`update server.js` is not.

## Splitting across the team

Assign whole rows, not fragments of rows, so nobody has to commit a broken tree.
A sensible split for three people:

- **API and rules** — 2, 3, 4, 6, 7, 8, 18, 19
- **Front end** — 9, 10, 11, 12, 13, 14, 15, 16
- **Model service, deployment, docs** — 1, 5, 17, 20

Whoever deploys should also push the tag once the demo is live:

```bash
git tag -a v1.0 -m "Competition submission"
git push origin main --tags
```

## Branches

If you want the history to show review as well as work, branch per feature:

```bash
git checkout -b feat/password-reset
# … commits 8 and 10 …
git push -u origin feat/password-reset
```

Open a pull request, have someone else merge it. Merge commits on `main` are
evidence of review, and cost nothing beyond the extra click.
