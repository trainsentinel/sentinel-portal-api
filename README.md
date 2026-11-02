# Sentinel programming server

A small private server for trainsentinel.com/member. It contains code only. The programming is never stored in this repository.

## What it does
- Stores each week of Affiliate programming privately in Webflow Cloud storage.
- When a member opens /member, the page asks this server for the programming. The server checks with Memberstack that the member is logged in and has an active Affiliate plan, then sends it.
- New weeks are saved as drafts that members can't see. A week goes live only after a separate publish step, done on Taylor's command.

## Webflow Cloud settings
- Mount path: `/portal-api`
- Storage: one Key Value store with the binding `PROGRAMMING` (declared in `wrangler.json`)

## Environment variables (mark each one marked "secret" as Secret)
| Name | Value | Secret |
|---|---|---|
| MEMBERSTACK_SECRET_KEY | Live secret key (`sk_...`) from Memberstack → Dev Tools | Yes |
| MEMBERSTACK_TEST_SECRET_KEY | Test-mode secret key (`sk_sb_...`), used by the staging address | Yes |
| MEMBERSTACK_APP_ID | `app_cmvykdzgo029a0ts9ac0vdy1e` | No |
| AFFILIATE_PLAN_IDS | The Affiliate plan ID (`pln_...`); separate several with commas | No |
| ALLOWED_ORIGINS | `https://www.trainsentinel.com,https://trainsentinel.com,https://sentineltraining.webflow.io` | No |
| ADMIN_TOKEN | Long random key used only to upload and publish weeks | Yes |

## Routes (under the mount path)
- `GET /api/weeks`: published weeks (members only)
- `GET /api/week/N`: one published week (members only)
- `PUT /api/admin/week/N/draft`, `GET /api/admin/week/N/draft`: save and review a draft (admin key)
- `POST /api/admin/week/N/publish`, `POST /api/admin/week/N/unpublish`: show or hide a week (admin key)
- `GET /api/admin/weeks`: list drafts and published weeks (admin key)

Every response is marked private, not cached, and not indexed. Uploaded weeks can't contain scripts.

## Tests
`npm test`
