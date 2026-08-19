# SIR – Safety Inspection Report

Cloudflare Worker application for `https://sir.ondockdepot.workers.dev`.

## Stack

- Cloudflare Workers
- D1 for structured report data
- R2 for private inspection photos
- Cloudflare Email Service for notifications
- Google OAuth 2.0 + PKCE for SSO
- Browser-side PDF generation after successful submission

Cloudflare currently recommends `wrangler.jsonc` for new Worker projects. D1/R2 are configured as Worker bindings. Email Sending uses a `send_email` binding and requires an onboarded sending domain and Workers Paid plan.

## Security model

- Google SSO is required.
- Only users allow-listed in `users` can sign in.
- Initial Super Admin email is configured by `BOOTSTRAP_SUPER_ADMIN_EMAIL`.
- The authenticated Google `sub` is the permanent identity used for authorization.
- A submitted inspection is immutable.
- Only the original creator can edit a draft.
- Corrective actions are editable only by the assigned user or Admin.
- Closure requires Admin approval.
- Audit records are append-only.
- R2 is private; photos are served through authorized Worker routes.
- Server-side authorization is enforced on every state-changing endpoint.

## 1. Create resources

```bash
npm install
npx wrangler login

npx wrangler d1 create SIR_DB
npx wrangler r2 bucket create sir-photos
```

Copy the returned D1 `database_id` into `wrangler.jsonc`.

## 2. Google OAuth

Create a Google OAuth Web Application client.

Authorized redirect URI:

`https://sir.ondockdepot.workers.dev/auth/callback`

Set these Worker secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
```

Set the client ID in `wrangler.jsonc` under `vars.GOOGLE_CLIENT_ID`.

For production, use a long random SESSION_SECRET.

## 3. Bootstrap the first Super Admin

Set:

```json
"BOOTSTRAP_SUPER_ADMIN_EMAIL": "ongkokleong@gmail.com"
```

The first successful Google sign-in using that email is provisioned as `super_admin`.

Do not put a Google client secret or other credentials into GitHub.

## 4. D1 migration

```bash
npx wrangler d1 migrations apply SIR_DB --remote
```

## 5. R2

The Worker expects an R2 bucket binding called `PHOTOS`.

## 6. Email

Cloudflare Email Service must be onboarded for your sending domain. Update:

```json
"EMAIL_FROM": "sir@your-onboarded-domain.com"
```

Then use the `EMAIL` binding in `wrangler.jsonc`.

The initial Admin notification recipient is:

`ongkokl@globalpsa.com`

## 7. Local development

```bash
npm run dev
```

Google OAuth normally needs a publicly reachable callback for testing. Use a suitable development OAuth redirect URI if testing locally.

## 8. Deploy

```bash
npm run deploy
```

Then open:

`https://sir.ondockdepot.workers.dev`

## Important

This repository is a production-oriented starting point, but you should test Google OAuth, email delivery, photo uploads, authorization boundaries, backups and PDF rendering before using it for operational records.
