# Safety Inspection AI — Cloudflare MVP

A Cloudflare-native safety inspection web app for Singapore workplace inspections.

## What this MVP does

1. Inspector uploads/takes a workplace photo.
2. Photo is stored in Cloudflare R2.
3. Cloudflare Workers AI analyses visible safety situations.
4. The AI identifies categories such as:
   - Vehicular Safety
   - Housekeeping
   - PPE
   - Work at Height
   - Lifting
5. Relevant WSH checks are retrieved from D1.
6. Optional Vectorize semantic matching improves the check retrieval.
7. Findings are saved in D1.
8. The web UI shows PASS / FAIL / CHECK REQUIRED with WSH source links.

## Important safety design

The AI is an inspection assistant, not a legal/compliance authority. A photo can be insufficient to establish compliance. The UI therefore uses `CHECK_REQUIRED` when the evidence is uncertain.

## Cloudflare resources

- Workers: application/API
- Workers AI: vision + embeddings
- D1: inspection and WSH check database
- R2: inspection photographs
- Vectorize: semantic matching of photo observations to WSH checks

Cloudflare documents the Workers AI vision model `@cf/meta/llama-3.2-11b-vision-instruct` and the 768-dimensional `@cf/baai/bge-base-en-v1.5` embedding model.

## Setup

### 1. Prerequisites

Install Node.js and Wrangler.

```bash
npm install
npx wrangler login
```

### 2. Create Cloudflare resources

```bash
npx wrangler d1 create safety-inspection-db
npx wrangler r2 bucket create safety-inspection-photos
npx wrangler vectorize create safety-wsh-index --dimensions=768 --metric=cosine
```

Copy the D1 database ID into `wrangler.toml`.

### 3. Accept the Meta license

The first call to the Llama 3.2 11B Vision model requires acceptance of Meta's license.

Use your Cloudflare dashboard/API token, or run the equivalent request described in Cloudflare's official Workers AI Llama Vision documentation.

### 4. Apply the D1 migrations

For local testing:

```bash
npm run db:local
```

For production:

```bash
npm run db:remote
```

### 5. Run locally

```bash
npm run dev
```

Open the local URL shown by Wrangler.

### 6. Deploy

```bash
npm run deploy
```

## Vectorize knowledge-base indexing

The MVP works with D1 category/keyword matching even if Vectorize is not populated.

For production, the next step is to ingest the full WSH Council documents into `safety_checks`, generate embeddings with:

`@cf/baai/bge-base-en-v1.5`

and upsert the check IDs + vectors into `safety-wsh-index`.

Recommended metadata per vector:

- check_id
- category
- source_title
- source_url
- version
- document_date

## Initial WSH sources

The seed migration includes references to WSH Council material on:

- Vehicular Safety
- Workplace Traffic Safety Management
- Workplace Housekeeping
- PPE
- Work at Height
- Lifting

The official WSH Council website should remain the authoritative source. Expand the knowledge base with the latest applicable WSH Council guidelines/checklists before production use.

## Production improvements

Before production rollout, add:

- Cloudflare Access authentication
- role-based permissions
- image retention policy
- audit logging
- corrective action workflow
- due dates and reminders
- dashboard/KPI
- WSH document ingestion and versioning
- human confirmation workflow
- EXIF stripping/privacy controls
- rate limiting
- maximum image dimensions
- AI Gateway
- automated WSH source refresh
- organisation/site configuration
- export to PDF/Excel

## Suggested depot-specific checks

For a container depot, extend the knowledge base with:

- prime mover / truck interaction
- pedestrian segregation
- reversing
- banksman / traffic controller
- chassis condition
- container door movement
- container stacking
- twist-lock handling
- reach stacker operation
- forklift operation
- oil spill
- wet surfaces
- housekeeping
- PPE
- work at height
- lifting operations
- damaged barriers and traffic controls
