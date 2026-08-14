export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
  VECTORIZE: VectorizeIndex;
  ASSETS: Fetcher;

  VECTORIZE_SEED_KEY?: string;
}

const VISION_MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const EMBEDDING_MODEL =
  "@cf/baai/bge-base-en-v1.5";

const VECTORIZE_INDEX =
  "safety-checks";

const VECTOR_MATCH_THRESHOLD = 0.45;

const MAX_IMAGE_SIZE =
  12 * 1024 * 1024;

const MAX_FINDINGS = 8;

const MAX_VECTOR_CHECKS = 8;

type Status =
  | "PASS"
  | "FAIL"
  | "CHECK_REQUIRED";

type Risk =
  | "LOW"
  | "MEDIUM"
  | "HIGH";

interface SafetyCheck {
  id: string;
  category: string;
  source_type: string;
  check_question: string;
  guidance: string;
  source_title: string;
  source_url: string;
  keywords: string;
}

interface Finding {
  category: string;
  title: string;
  observation: string;
  status: Status;
  risk_level: Risk;
  confidence: number;

  check_id: string | null;

  source_type: string | null;
  source_title: string | null;
  source_url: string | null;

  vector_score?: number | null;
}

interface PhotoInput {
  bytes: ArrayBuffer;
  contentType: string;
  fileName: string;
}

interface ParsedRequest {
  photo: PhotoInput;
  location: string;
  inspector: string;
}

/* =========================================================
   RESPONSE HELPERS
   ========================================================= */

function jsonResponse(
  data: unknown,
  status = 200
): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store",

        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Methods":
          "GET, POST, OPTIONS",

        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, X-Vectorize-Seed-Key",
      },
    }
  );
}

function textResponse(
  text: string,
  status = 200
): Response {
  return new Response(
    text,
    {
      status,
      headers: {
        "Content-Type":
          "text/plain; charset=utf-8",

        "Access-Control-Allow-Origin":
          "*",
      },
    }
  );
}

/* =========================================================
   GENERAL HELPERS
   ========================================================= */

function uuid(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

function clean(
  value: unknown,
  max = 2000
): string {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }

  return String(value)
    .replace(/\u0000/g, "")
    .trim()
    .substring(0, max);
}

function cleanMarkdown(
  value: unknown,
  max = 2000
): string {
  return clean(
    value,
    max
  )
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/^#+\s*/g, "")
    .replace(/^[-*•]\s*/g, "")
    .trim();
}

function inspectionNumber(): string {
  const d =
    new Date();

  const y =
    d.getUTCFullYear();

  const m =
    String(
      d.getUTCMonth() + 1
    ).padStart(2, "0");

  const day =
    String(
      d.getUTCDate()
    ).padStart(2, "0");

  const random =
    crypto
      .randomUUID()
      .replace(/-/g, "")
      .substring(0, 6)
      .toUpperCase();

  return `SI-${y}${m}${day}-${random}`;
}

function normalizeContentType(
  value: unknown
): string {
  const type =
    String(value || "")
      .toLowerCase()
      .split(";")[0]
      .trim();

  if (
    type === "image/png"
  )
    return "image/png";

  if (
    type === "image/webp"
  )
    return "image/webp";

  if (
    type === "image/gif"
  )
    return "image/gif";

  if (
    type === "image/heic"
  )
    return "image/heic";

  if (
    type === "image/heif"
  )
    return "image/heif";

  return "image/jpeg";
}

function extension(
  contentType: string
): string {
  switch (contentType) {
    case "image/png":
      return "png";

    case "image/webp":
      return "webp";

    case "image/gif":
      return "gif";

    case "image/heic":
      return "heic";

    case "image/heif":
      return "heif";

    default:
      return "jpg";
  }
}

function safeFileName(
  value: string
): string {
  const result =
    value
      .replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      )
      .substring(0, 150);

  return (
    result ||
    "inspection-photo.jpg"
  );
}

/* =========================================================
   BASE64
   ========================================================= */

function arrayBufferToBase64(
  buffer: ArrayBuffer
): string {
  const bytes =
    new Uint8Array(buffer);

  let binary = "";

  const chunkSize =
    0x8000;

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    const chunk =
      bytes.subarray(
        i,
        Math.min(
          i + chunkSize,
          bytes.length
        )
      );

    binary +=
      String.fromCharCode(
        ...chunk
      );
  }

  return btoa(binary);
}

function imageDataUrl(
  bytes: ArrayBuffer,
  contentType: string
): string {
  return (
    `data:${contentType};base64,` +
    arrayBufferToBase64(bytes)
  );
}

/* =========================================================
   REQUEST PARSER
   ========================================================= */

async function parseRequest(
  request: Request
): Promise<ParsedRequest> {
  const contentType =
    request.headers.get(
      "content-type"
    ) || "";

  if (
    contentType
      .toLowerCase()
      .includes(
        "multipart/form-data"
      )
  ) {
    const form =
      await request.formData();

    let file:
      | File
      | null = null;

    const possibleNames = [
      "image",
      "photo",
      "file",
      "photoFile",
    ];

    for (
      const name of possibleNames
    ) {
      const value =
        form.get(name);

      if (
        value instanceof File
      ) {
        file = value;
        break;
      }
    }

    if (!file) {
      for (
        const [, value] of
          form.entries()
      ) {
        if (
          value instanceof File
        ) {
          file = value;
          break;
        }
      }
    }

    if (!file) {
      throw new Error(
        "No image file was uploaded."
      );
    }

    const bytes =
      await file.arrayBuffer();

    if (!bytes.byteLength) {
      throw new Error(
        "The uploaded image is empty."
      );
    }

    if (
      bytes.byteLength >
      MAX_IMAGE_SIZE
    ) {
      throw new Error(
        "The uploaded image is larger than 12 MB."
      );
    }

    return {
      photo: {
        bytes,

        contentType:
          normalizeContentType(
            file.type
          ),

        fileName:
          safeFileName(
            file.name ||
              "inspection-photo.jpg"
          ),
      },

      location:
        clean(
          form.get(
            "location"
          ),
          200
        ) ||
        "Unspecified",

      inspector:
        clean(
          form.get(
            "inspector"
          ),
          200
        ) ||
        "Unspecified",
    };
  }

  let body: any;

  try {
    body =
      await request.json();
  } catch {
    throw new Error(
      "Request body is not valid JSON."
    );
  }

  let base64 =
    body?.image ||
    body?.imageBase64 ||
    body?.photo;

  if (
    typeof base64 !==
      "string" ||
    !base64.trim()
  ) {
    throw new Error(
      "No image was supplied."
    );
  }

  base64 =
    base64.trim();

  let imageType =
    normalizeContentType(
      body?.mimeType ||
        body?.contentType ||
        "image/jpeg"
    );

  const match =
    base64.match(
      /^data:(image\/[^;]+);base64,(.+)$/s
    );

  if (match) {
    imageType =
      normalizeContentType(
        match[1]
      );

    base64 =
      match[2];
  }

  let binary: string;

  try {
    binary =
      atob(base64);
  } catch {
    throw new Error(
      "Image data is not valid base64."
    );
  }

  const bytes =
    new Uint8Array(
      binary.length
    );

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  if (!bytes.byteLength) {
    throw new Error(
      "The image is empty."
    );
  }

  if (
    bytes.byteLength >
    MAX_IMAGE_SIZE
  ) {
    throw new Error(
      "The image is larger than 12 MB."
    );
  }

  return {
    photo: {
      bytes:
        bytes.buffer,

      contentType:
        imageType,

      fileName:
        safeFileName(
          body?.fileName ||
            `inspection.${extension(
              imageType
            )}`
        ),
    },

    location:
      clean(
        body?.location,
        200
      ) ||
      "Unspecified",

    inspector:
      clean(
        body?.inspector,
        200
      ) ||
      "Unspecified",
  };
}

/* =========================================================
   D1 TABLE HELPERS
   ========================================================= */

const ALLOWED_TABLES = [
  "inspections",
  "inspection_photos",
  "inspection_items",
  "safety_checks",
  "corrective_actions",
];

async function getTableColumns(
  db: D1Database,
  table: string
): Promise<Set<string>> {
  if (
    !ALLOWED_TABLES.includes(
      table
    )
  ) {
    throw new Error(
      `Invalid table name: ${table}`
    );
  }

  const result =
    await db
      .prepare(
        `PRAGMA table_info("${table}")`
      )
      .all<{
        name: string;
      }>();

  return new Set(
    (result.results || [])
      .map(
        row => row.name
      )
  );
}

function buildInsert(
  table: string,
  columns: Set<string>,
  values: Record<
    string,
    unknown
  >
): {
  sql: string;
  params: unknown[];
} {
  if (
    !ALLOWED_TABLES.includes(
      table
    )
  ) {
    throw new Error(
      `Invalid insert table: ${table}`
    );
  }

  const selected =
    Object.entries(
      values
    ).filter(
      ([column]) =>
        columns.has(column)
    );

  if (
    !selected.length
  ) {
    throw new Error(
      `No matching columns found in ${table}.`
    );
  }

  return {
    sql: `
      INSERT INTO "${table}"
      (${selected
        .map(
          ([column]) =>
            `"${column}"`
        )
        .join(", ")})
      VALUES (${selected
        .map(
          () => "?"
        )
        .join(", ")})
    `,

    params:
      selected.map(
        ([, value]) =>
          value
      ),
  };
}

/* =========================================================
   SAFETY CHECKS
   ========================================================= */

async function loadSafetyChecks(
  env: Env
): Promise<SafetyCheck[]> {
  const columns =
    await getTableColumns(
      env.SAFETY_DB,
      "safety_checks"
    );

  const required = [
    "id",
    "category",
    "check_question",
    "guidance",
    "source_title",
    "source_url",
    "keywords",
  ];

  const missing =
    required.filter(
      column =>
        !columns.has(
          column
        )
    );

  if (
    missing.length
  ) {
    throw new Error(
      `safety_checks is missing columns: ${missing.join(
        ", "
      )}`
    );
  }

  const sourceType =
    columns.has(
      "source_type"
    )
      ? "source_type"
      : "'WSHC_DERIVED'";

  const result =
    await env.SAFETY_DB
      .prepare(
        `
        SELECT
          id,
          category,
          ${sourceType} AS source_type,
          check_question,
          guidance,
          source_title,
          source_url,
          keywords
        FROM safety_checks
        WHERE active = 1
        ORDER BY category, id
        LIMIT 100
        `
      )
      .all<SafetyCheck>();

  return (
    result.results ||
    []
  );
}

/* =========================================================
   VECTOR EMBEDDING
   ========================================================= */

interface EmbeddingResponse {
  shape?: number[];
  data: number[][];
}

async function createEmbedding(
  env: Env,
  text: string
): Promise<number[]> {
  const cleanText =
    clean(
      text,
      4000
    );

  if (!cleanText) {
    throw new Error(
      "Cannot create embedding from empty text."
    );
  }

  let response:
    | EmbeddingResponse
    | any;

  try {
    response =
      await env.AI.run(
        EMBEDDING_MODEL,
        {
          text:
            cleanText,
        } as any
      );
  } catch (error) {
    throw new Error(
      `Embedding generation failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }

  const vector =
    response?.data?.[0];

  if (
    !Array.isArray(
      vector
    )
  ) {
    throw new Error(
      `Embedding model returned invalid data: ${JSON.stringify(
        response
      ).substring(0, 1000)}`
    );
  }

  if (
    vector.length !==
    768
  ) {
    throw new Error(
      `Embedding dimension is ${vector.length}; expected 768.`
    );
  }

  return vector;
}

/* =========================================================
   VECTORIZE CHECK TEXT
   ========================================================= */

function checkEmbeddingText(
  check: SafetyCheck
): string {
  return `
Safety category: ${check.category}
Safety check: ${check.check_question}
Guidance: ${check.guidance}
Keywords: ${check.keywords}
Source: ${check.source_title}
Source type: ${check.source_type}
`.trim();
}

/* =========================================================
   VECTORIZE SEED
   ========================================================= */

function getSeedKey(
  request: Request
): string {
  const header =
    request.headers.get(
      "X-Vectorize-Seed-Key"
    );

  if (header) {
    return header.trim();
  }

  const authorization =
    request.headers.get(
      "Authorization"
    );

  if (
    authorization &&
    authorization
      .toLowerCase()
      .startsWith(
        "bearer "
      )
  ) {
    return authorization
      .substring(7)
      .trim();
  }

  return "";
}

async function vectorizeSeed(
  request: Request,
  env: Env
): Promise<Response> {
  const configuredKey =
    env.VECTORIZE_SEED_KEY;

  if (
    !configuredKey
  ) {
    return jsonResponse(
      {
        ok: false,

        error:
          "VECTORIZE_SEED_KEY is not configured. Create this Worker secret before running the seed operation.",
      },
      500
    );
  }

  const suppliedKey =
    getSeedKey(
      request
    );

  if (
    !suppliedKey ||
    suppliedKey !==
      configuredKey
  ) {
    return jsonResponse(
      {
        ok: false,
        error:
          "Invalid Vectorize seed key.",
      },
      401
    );
  }

  try {
    const checks =
      await loadSafetyChecks(
        env
      );

    if (
      checks.length ===
      0
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "No active safety checks found in D1.",
        },
        400
      );
    }

    const vectors: Array<{
      id: string;
      values: number[];
      metadata: Record<
        string,
        string
      >;
    }> = [];

    for (
      const check of checks
    ) {
      const text =
        checkEmbeddingText(
          check
        );

      const values =
        await createEmbedding(
          env,
          text
        );

      vectors.push({
        id:
          check.id,

        values,

        metadata: {
          category:
            check.category,

          source_type:
            check.source_type,

          source_title:
            check.source_title,

          source_url:
            check.source_url,

          check_question:
            check.check_question,
        },
      });
    }

    const mutation =
      await env.VECTORIZE.upsert(
        vectors
      );

    return jsonResponse({
      ok: true,

      message:
        "Safety checks successfully indexed into Vectorize.",

      index:
        VECTORIZE_INDEX,

      embedding_model:
        EMBEDDING_MODEL,

      dimensions:
        768,

      indexed:
        vectors.length,

      ids:
        vectors.map(
          vector =>
            vector.id
        ),

      mutation,
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,

        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}

/* =========================================================
   VECTOR SEARCH
   ========================================================= */

interface VectorMatch {
  id: string;
  score?: number;
  metadata?: Record<
    string,
    unknown
  >;
}

interface VectorSearchResult {
  matches?: VectorMatch[];
  count?: number;
}

async function searchSafetyChecks(
  env: Env,
  sceneDescription: string
): Promise<
  Array<{
    check: SafetyCheck | null;
    score: number;
    id: string;
  }>
> {
  const vector =
    await createEmbedding(
      env,
      sceneDescription
    );

  let result:
    | VectorSearchResult
    | any;

  try {
    result =
      await env.VECTORIZE.query(
        vector,
        {
          topK:
            MAX_VECTOR_CHECKS,

          returnMetadata:
            "all",
        } as any
      );
  } catch (error) {
    throw new Error(
      `Vectorize query failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }

  const matches =
    Array.isArray(
      result?.matches
    )
      ? result.matches
      : [];

  const checks =
    await loadSafetyChecks(
      env
    );

  const output: Array<{
    check:
      | SafetyCheck
      | null;
    score: number;
    id: string;
  }> = [];

  for (
    const match of matches
  ) {
    const score =
      Number(
        match.score || 0
      );

    if (
      score <
      VECTOR_MATCH_THRESHOLD
    ) {
      continue;
    }

    const check =
      checks.find(
        item =>
          item.id ===
          match.id
      ) || null;

    output.push({
      check,

      score:
        Math.round(
          score * 1000
        ) / 1000,

      id:
        match.id,
    });
  }

  return output;
}

/* =========================================================
   SCENE ANALYSIS PROMPT
   ========================================================= */

function buildScenePrompt(
  location: string
): string {
  return `
You are performing the first visual scene analysis for a Singapore container depot and container repair yard.

Location:
${clean(location, 200)}

Analyse ONLY what can actually be seen in the photograph.

Identify visible:
- people and PPE
- vehicles
- forklifts
- reach stackers
- cranes or lifting equipment
- containers
- container repair activities
- welding or hot work
- gas cylinders
- chemicals or chemical containers
- electrical equipment
- machinery
- storage and stacking
- loading/unloading
- traffic areas
- barriers and segregation
- housekeeping conditions
- spills
- trip hazards
- fire safety equipment
- work at height
- confined-space indicators
- damaged equipment
- warning signs
- safety cages or protective barriers

Do not assume an activity is taking place if it is not visible.

Do not report invisible or hypothetical hazards.

Return a concise factual description of the visible scene only.

Do not give a safety judgement yet.
`.trim();
}

/* =========================================================
   SCENE ANALYSIS
   ========================================================= */

async function analyzeScene(
  env: Env,
  image: ArrayBuffer,
  contentType: string,
  location: string
): Promise<{
  raw: string;
  imageDataUrl: string;
}> {
  const prompt =
    buildScenePrompt(
      location
    );

  const imageUrl =
    imageDataUrl(
      image,
      contentType
    );

  let response:
    | any;

  try {
    /*
     * IMPORTANT:
     *
     * Cloudflare Workers AI Vision expects
     * the image as a top-level "image"
     * property.
     *
     * Do NOT put the image inside
     * messages[].content.
     */
    response =
      await env.AI.run(
        VISION_MODEL,
        {
          messages: [
            {
              role:
                "system",

              content:
                "You are a strict visual scene-analysis assistant. Report only visible evidence.",
            },

            {
              role:
                "user",

              content:
                prompt,
            },
          ],

          image:
            imageUrl,

          max_tokens:
            700,

          temperature:
            0.01,

          top_p:
            0.8,
        } as any
      );
  } catch (error) {
    throw new Error(
      `Workers AI scene analysis failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }

  const raw =
    typeof response ===
    "string"
      ? response
      : typeof response?.response ===
        "string"
      ? response.response
      : "";

  if (
    !raw.trim()
  ) {
    throw new Error(
      `Workers AI scene analysis returned no text. Response: ${JSON.stringify(
        response
      ).substring(0, 2000)}`
    );
  }

  return {
    raw:
      raw.trim(),

    imageDataUrl:
      imageUrl,
  };
}

/* =========================================================
   FINAL AI PROMPT
   ========================================================= */

function buildFinalPrompt(
  scene: string,
  vectorChecks: Array<{
    check: SafetyCheck | null;
    score: number;
    id: string;
  }>
): string {
  const checksText =
    vectorChecks
      .filter(
        item =>
          item.check
      )
      .map(
        item => {
          const check =
            item.check!;

          return `
CHECK ID: ${check.id}
VECTOR SCORE: ${item.score}
CATEGORY: ${check.category}
SOURCE TYPE: ${check.source_type}
QUESTION: ${check.check_question}
GUIDANCE: ${check.guidance}
SOURCE TITLE: ${check.source_title}
SOURCE URL: ${check.source_url}
KEYWORDS: ${check.keywords}
`;
        }
      )
      .join("\n");

  return `
You are a strict evidence-based workplace safety inspection assistant for a Singapore shipping/container depot and container repair yard.

IMPORTANT:
Analyse the photograph yourself.

The scene description and Vectorize results are supporting context only.
Do not blindly trust them.

SCENE DESCRIPTION:
${scene}

RELEVANT WSH CHECKS RETRIEVED FROM VECTORIZE:
${checksText || "No sufficiently relevant checks were retrieved."}

RULES:

1. Report ONLY conditions that are visibly supported by the photograph.

2. Do NOT invent people, equipment, activities, hazards or PPE.

3. Do NOT create findings simply because a safety category exists.

4. If a category is not visibly relevant, OMIT it.

5. Do NOT generate statements such as:
"No visible lifting"
"No visible electrical equipment"
"No visible fire hazard"
"No visible work at height"
"No visible chemical hazard"

These are NOT findings.

6. PASS:
Use PASS when the relevant visible condition appears satisfactory.

7. FAIL:
Use FAIL when a visible unsafe condition is identified.

8. CHECK_REQUIRED:
Use CHECK_REQUIRED only when a relevant condition is visible but the photograph is insufficient to determine compliance.

9. Risk:
LOW = satisfactory or minor concern.
MEDIUM = potential safety concern.
HIGH = serious visible safety concern.

10. Confidence:
Use a number from 0 to 1 representing confidence that the observation is correctly supported by the image.

11. Check ID:
Use ONLY one of the CHECK IDs supplied above.

12. Do not use a check merely because it is semantically similar.
The check must actually relate to the visible condition.

13. If the photograph shows a gas cylinder inside a protective cage, for example, assess the visible condition of the cylinder/cage only if one of the supplied checks is relevant.

14. For container repair yards, pay particular attention to:
- gas cylinders
- welding/hot work
- machinery
- electrical equipment
- lifting equipment
- forklifts
- reach stackers
- container repair
- traffic segregation
- loading/unloading
- storage/stacking
- housekeeping
- PPE
- work at height
- chemical hazards

Return ONLY valid JSON.

Format:

{
  "findings": [
    {
      "category": "Chemical Safety",
      "title": "Gas cylinder appears securely stored",
      "observation": "A gas cylinder is visible inside a secured protective cage.",
      "status": "PASS",
      "risk": "LOW",
      "confidence": 0.90,
      "check_id": "chemical-001"
    }
  ]
}

If there are no relevant visible findings:

{
  "findings": []
}

Do not include markdown.
Do not include explanations outside the JSON.
`.trim();
}

/* =========================================================
   FINAL AI
   ========================================================= */

async function runFinalAI(
  env: Env,
  image: ArrayBuffer,
  contentType: string,
  scene: string,
  vectorChecks: Array<{
    check: SafetyCheck | null;
    score: number;
    id: string;
  }>
): Promise<string> {
  const prompt =
    buildFinalPrompt(
      scene,
      vectorChecks
    );

  const imageUrl =
    imageDataUrl(
      image,
      contentType
    );

  let response:
    | any;

  try {
    response =
      await env.AI.run(
        VISION_MODEL,
        {
          messages: [
            {
              role:
                "system",

              content:
                "You are a strict evidence-based Singapore workplace safety visual inspection assistant. Never invent visible evidence.",
            },

            {
              role:
                "user",

              content:
                prompt,
            },
          ],

          /*
           * IMPORTANT:
           * Image is a top-level parameter.
           */
          image:
            imageUrl,

          max_tokens:
            1000,

          temperature:
            0.01,

          top_p:
            0.8,
        } as any
      );
  } catch (error) {
    throw new Error(
      `Workers AI final analysis failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }

  const raw =
    typeof response ===
    "string"
      ? response
      : typeof response?.response ===
        "string"
      ? response.response
      : "";

  if (
    !raw.trim()
  ) {
    throw new Error(
      `Workers AI final analysis returned no text. Response: ${JSON.stringify(
        response
      ).substring(0, 3000)}`
    );
  }

  return raw.trim();
}

/* =========================================================
   CONFIDENCE
   ========================================================= */

function parseConfidence(
  value: unknown
): number {
  if (
    value === null ||
    value === undefined
  ) {
    return 0.6;
  }

  const text =
    String(value);

  const match =
    text.match(
      /(\d+(?:\.\d+)?)/
    );

  if (!match) {
    return 0.6;
  }

  let number =
    Number(
      match[1]
    );

  if (
    number > 1
  ) {
    number /=
      100;
  }

  if (
    !Number.isFinite(
      number
    )
  ) {
    number = 0.6;
  }

  return (
    Math.round(
      Math.max(
        0,
        Math.min(
          1,
          number
        )
      ) * 100
    ) / 100
  );
}

/* =========================================================
   STATUS / RISK
   ========================================================= */

function normalizeStatus(
  value: unknown,
  observation: string
): Status {
  const text =
    cleanMarkdown(
      value
    ).toUpperCase();

  if (
    text.includes(
      "FAIL"
    )
  ) {
    return "FAIL";
  }

  if (
    text.includes(
      "PASS"
    )
  ) {
    return "PASS";
  }

  if (
    text.includes(
      "CHECK"
    )
  ) {
    return "CHECK_REQUIRED";
  }

  const lower =
    observation.toLowerCase();

  const failureWords = [
    "unsafe",
    "hazard",
    "spill",
    "obstructed",
    "blocked",
    "missing",
    "damaged",
    "exposed",
    "unguarded",
    "leaking",
    "broken",
    "unstable",
  ];

  if (
    failureWords.some(
      word =>
        lower.includes(
          word
        )
    )
  ) {
    return "FAIL";
  }

  return "CHECK_REQUIRED";
}

function normalizeRisk(
  value: unknown,
  status: Status
): Risk {
  const text =
    cleanMarkdown(
      value
    ).toUpperCase();

  if (
    text.includes(
      "HIGH"
    )
  ) {
    return "HIGH";
  }

  if (
    text.includes(
      "MEDIUM"
    )
  ) {
    return "MEDIUM";
  }

  if (
    text.includes(
      "LOW"
    )
  ) {
    return "LOW";
  }

  if (
    status === "FAIL"
  ) {
    return "HIGH";
  }

  if (
    status === "PASS"
  ) {
    return "LOW";
  }

  return "MEDIUM";
}

/* =========================================================
   NEGATIVE VISIBILITY
   ========================================================= */

function isNegativeVisibilityFinding(
  category: string,
  title: string,
  observation: string
): boolean {
  const text =
    `${category} ${title} ${observation}`
      .toLowerCase()
      .replace(
        /\s+/g,
        " "
      );

  const patterns = [
    "no visible",
    "not visible",
    "there is no visible",
    "no evidence",
    "cannot be determined",
    "not observed",
    "not apparent",
    "no visible work at height",
    "no visible lifting",
    "no visible lifting operation",
    "no visible electrical",
    "no visible fire",
    "no visible storage",
    "no work at height",
    "no lifting operation",
    "no electrical equipment",
    "no fire hazards",
    "no storage hazards",
  ];

  return patterns.some(
    pattern =>
      text.includes(
        pattern
      )
  );
}

/* =========================================================
   CATEGORY
   ========================================================= */

function normalizeCategory(
  category: string
): string {
  const value =
    cleanMarkdown(
      category,
      100
    )
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  const lower =
    value.toLowerCase();

  if (
    lower === "ppe" ||
    lower.includes(
      "personal protective"
    )
  ) {
    return "PPE";
  }

  if (
    lower.includes(
      "housekeeping"
    )
  ) {
    return "Housekeeping";
  }

  if (
    lower.includes(
      "vehicular"
    ) ||
    lower.includes(
      "vehicle"
    ) ||
    lower.includes(
      "traffic"
    )
  ) {
    return "Vehicular Safety";
  }

  if (
    lower.includes(
      "reach stacker"
    )
  ) {
    return "Reach Stacker Safety";
  }

  if (
    lower.includes(
      "forklift"
    )
  ) {
    return "Forklift Safety";
  }

  if (
    lower.includes(
      "work at height"
    ) ||
    lower.includes(
      "working at height"
    )
  ) {
    return "Work at Height";
  }

  if (
    lower.includes(
      "loading"
    ) ||
    lower.includes(
      "unloading"
    )
  ) {
    return "Loading and Unloading";
  }

  if (
    lower.includes(
      "lifting"
    )
  ) {
    return "Lifting";
  }

  if (
    lower.includes(
      "chemical"
    )
  ) {
    return "Chemical Safety";
  }

  if (
    lower.includes(
      "electrical"
    )
  ) {
    return "Electrical Safety";
  }

  if (
    lower.includes(
      "fire"
    )
  ) {
    return "Fire Safety";
  }

  if (
    lower.includes(
      "storage"
    ) ||
    lower.includes(
      "stacking"
    )
  ) {
    return "Storage and Stacking";
  }

  if (
    lower.includes(
      "machinery"
    )
  ) {
    return "Machinery Safety";
  }

  if (
    lower.includes(
      "noise"
    )
  ) {
    return "Noise";
  }

  if (
    lower.includes(
      "manual handling"
    ) ||
    lower.includes(
      "ergonomic"
    )
  ) {
    return "Manual Handling";
  }

  if (
    lower.includes(
      "slip"
    ) ||
    lower.includes(
      "trip"
    ) ||
    lower.includes(
      "fall"
    )
  ) {
    return "Slips, Trips and Falls";
  }

  if (
    lower.includes(
      "confined"
    )
  ) {
    return "Confined Space";
  }

  if (
    lower.includes(
      "hot work"
    ) ||
    lower.includes(
      "welding"
    )
  ) {
    return "Hot Work";
  }

  if (
    lower.includes(
      "risk assessment"
    )
  ) {
    return "Risk Assessment";
  }

  return value;
}

/* =========================================================
   PARSE JSON AI RESPONSE
   ========================================================= */

function parseAIResponse(
  raw: string
): Array<{
  category: string;
  title: string;
  observation: string;
  status: Status;
  risk: Risk;
  confidence: number;
  checkId: string;
}> {
  let text =
    raw.trim();

  /*
   * Remove markdown fences if
   * the model unexpectedly returns them.
   */

  text =
    text.replace(
      /^```(?:json)?\s*/i,
      ""
    );

  text =
    text.replace(
      /\s*```$/i,
      ""
    );

  try {
    const parsed =
      JSON.parse(
        text
      );

    const findings =
      Array.isArray(
        parsed
      )
        ? parsed
        : Array.isArray(
            parsed?.findings
          )
        ? parsed.findings
        : [];

    return findings
      .slice(
        0,
        MAX_FINDINGS
      )
      .map(
        (
          item: any
        ) => ({
          category:
            normalizeCategory(
              clean(
                item?.category,
                100
              )
            ),

          title:
            cleanMarkdown(
              item?.title ||
                "Visible safety observation",
              250
            ),

          observation:
            cleanMarkdown(
              item?.observation ||
                "",
              1200
            ),

          status:
            normalizeStatus(
              item?.status,
              clean(
                item?.observation
              )
            ),

          risk:
            normalizeRisk(
              item?.risk,
              normalizeStatus(
                item?.status,
                clean(
                  item?.observation
                )
              )
            ),

          confidence:
            parseConfidence(
              item?.confidence
            ),

          checkId:
            cleanMarkdown(
              item?.check_id ||
                item?.checkId ||
                ""
            ),
        })
      )
      .filter(
        item =>
          item.category &&
          item.observation
      );
  } catch {
    /*
     * Fallback to legacy markdown format.
     */

    return parseLegacyAIResponse(
      raw
    );
  }
}

/* =========================================================
   LEGACY AI FORMAT
   ========================================================= */

function parseLegacyAIResponse(
  raw: string
): Array<{
  category: string;
  title: string;
  observation: string;
  status: Status;
  risk: Risk;
  confidence: number;
  checkId: string;
}> {
  const results: Array<{
    category: string;
    title: string;
    observation: string;
    status: Status;
    risk: Risk;
    confidence: number;
    checkId: string;
  }> = [];

  const blocks =
    raw.split(
      /(?=\*\*Category:\*\*)/i
    );

  for (
    const block of blocks
  ) {
    const categoryMatch =
      block.match(
        /\*\*Category:\*\*\s*(.+?)(?=\n|$)/i
      );

    if (
      !categoryMatch
    ) {
      continue;
    }

    const category =
      normalizeCategory(
        categoryMatch[1]
      );

    const titleMatch =
      block.match(
        /\*\*Title:\*\*\s*(.+?)(?=\n|$)/i
      );

    const observationMatch =
      block.match(
        /\*\*Observation:\*\*\s*(.+?)(?=\n|$)/i
      );

    const statusMatch =
      block.match(
        /\*\*Status:\*\*\s*(PASS|FAIL|CHECK_REQUIRED)/i
      );

    const riskMatch =
      block.match(
        /\*\*Risk:\*\*\s*(LOW|MEDIUM|HIGH)/i
      );

    const confidenceMatch =
      block.match(
        /\*\*Confidence:\*\*\s*([0-9.]+)/i
      );

    const checkIdMatch =
      block.match(
        /\*\*Check ID:\*\*\s*([^\s\n]+)/i
      );

    const title =
      cleanMarkdown(
        titleMatch?.[1] ||
          `${category} observation`
      );

    const observation =
      cleanMarkdown(
        observationMatch?.[1] ||
          ""
      );

    if (
      !observation
    ) {
      continue;
    }

    results.push({
      category,

      title,

      observation,

      status:
        normalizeStatus(
          statusMatch?.[1],
          observation
        ),

      risk:
        normalizeRisk(
          riskMatch?.[1],
          normalizeStatus(
            statusMatch?.[1],
            observation
          )
        ),

      confidence:
        parseConfidence(
          confidenceMatch?.[1]
        ),

      checkId:
        cleanMarkdown(
          checkIdMatch?.[1] ||
            ""
        ),
    });

    if (
      results.length >=
      MAX_FINDINGS
    ) {
      break;
    }
  }

  return results;
}

/* =========================================================
   FIND CHECK
   ========================================================= */

function findCheck(
  finding: {
    category: string;
    title: string;
    observation: string;
    checkId: string;
  },
  checks: SafetyCheck[]
): SafetyCheck | null {
  if (
    finding.checkId
  ) {
    const exact =
      checks.find(
        check =>
          check.id ===
          finding.checkId
      );

    if (exact) {
      return exact;
    }
  }

  const category =
    normalizeCategory(
      finding.category
    );

  const categoryMatches =
    checks.filter(
      check =>
        normalizeCategory(
          check.category
        ).toLowerCase() ===
        category.toLowerCase()
    );

  if (
    categoryMatches.length ===
    1
  ) {
    return categoryMatches[0];
  }

  const combined =
    `${category} ${finding.title} ${finding.observation}`
      .toLowerCase();

  let best:
    | SafetyCheck
    | null = null;

  let bestScore = 0;

  const candidates =
    categoryMatches.length
      ? categoryMatches
      : checks;

  for (
    const check of candidates
  ) {
    const keywords =
      clean(
        check.keywords,
        500
      )
        .toLowerCase()
        .split(
          /[,;|]+/
        )
        .map(
          word =>
            word.trim()
        )
        .filter(
          word =>
            word.length >= 3
        );

    let score = 0;

    for (
      const keyword of keywords
    ) {
      if (
        combined.includes(
          keyword
        )
      ) {
        score++;
      }
    }

    if (
      score >
      bestScore
    ) {
      bestScore =
        score;

      best =
        check;
    }
  }

  return bestScore > 0
    ? best
    : null;
}

/* =========================================================
   NORMALIZE FINDINGS
   ========================================================= */

function normalizeFindings(
  parsed: Array<{
    category: string;
    title: string;
    observation: string;
    status: Status;
    risk: Risk;
    confidence: number;
    checkId: string;
  }>,
  checks: SafetyCheck[],
  vectorChecks: Array<{
    check: SafetyCheck | null;
    score: number;
    id: string;
  }>
): Finding[] {
  const output:
    Finding[] = [];

  const seen =
    new Set<string>();

  for (
    const item of parsed
  ) {
    const category =
      normalizeCategory(
        item.category
      );

    const title =
      cleanMarkdown(
        item.title,
        250
      );

    const observation =
      cleanMarkdown(
        item.observation,
        1200
      );

    if (
      !category ||
      !observation
    ) {
      continue;
    }

    if (
      isNegativeVisibilityFinding(
        category,
        title,
        observation
      )
    ) {
      continue;
    }

    const key =
      `${category}|${title}|${observation}`
        .toLowerCase()
        .replace(
          /\s+/g,
          " "
        );

    if (
      seen.has(key)
    ) {
      continue;
    }

    seen.add(key);

    const check =
      findCheck(
        {
          category,
          title,
          observation,
          checkId:
            item.checkId,
        },
        checks
      );

    /*
     * Important:
     *
     * If the AI invented a check ID
     * that is not present in D1,
     * do not save it.
     */

    if (
      item.checkId &&
      !check
    ) {
      continue;
    }

    /*
     * If no matching WSH check exists,
     * keep the finding but without
     * foreign-key reference.
     */

    let vectorScore:
      number | null =
      null;

    if (
      check
    ) {
      const match =
        vectorChecks.find(
          item =>
            item.id ===
            check.id
        );

      if (
        match
      ) {
        vectorScore =
          match.score;
      }
    }

    let confidence =
      Number(
        item.confidence
      );

    if (
      !Number.isFinite(
        confidence
      )
    ) {
      confidence =
        0.6;
    }

    confidence =
      Math.max(
        0,
        Math.min(
          1,
          confidence
        )
      );

    output.push({
      category,

      title,

      observation,

      status:
        item.status,

      risk_level:
        item.risk,

      confidence:
        Math.round(
          confidence * 100
        ) / 100,

      check_id:
        check?.id ||
        null,

      source_type:
        check?.source_type ||
        null,

      source_title:
        check?.source_title ||
        null,

      source_url:
        check?.source_url ||
        null,

      vector_score:
        vectorScore,
    });

    if (
      output.length >=
      MAX_FINDINGS
    ) {
      break;
    }
  }

  return output;
}

/* =========================================================
   OVERALL
   ========================================================= */

function overall(
  findings: Finding[]
):
  | "PASS"
  | "ATTENTION"
  | "CHECK_REQUIRED" {
  if (
    findings.length ===
    0
  ) {
    return "CHECK_REQUIRED";
  }

  if (
    findings.some(
      finding =>
        finding.status ===
        "FAIL"
    )
  ) {
    return "ATTENTION";
  }

  if (
    findings.some(
      finding =>
        finding.status ===
        "CHECK_REQUIRED"
    )
  ) {
    return "CHECK_REQUIRED";
  }

  return "PASS";
}

function buildSummary(
  findings: Finding[]
): string {
  if (
    findings.length ===
    0
  ) {
    return "No relevant visible safety conditions were identified from the photograph.";
  }

  const pass =
    findings.filter(
      finding =>
        finding.status ===
        "PASS"
    ).length;

  const fail =
    findings.filter(
      finding =>
        finding.status ===
        "FAIL"
    ).length;

  const check =
    findings.filter(
      finding =>
        finding.status ===
        "CHECK_REQUIRED"
    ).length;

  if (
    fail > 0
  ) {
    return `${fail} visible safety finding(s) require corrective attention. ${check} item(s) require verification and ${pass} item(s) passed.`;
  }

  if (
    check > 0
  ) {
    return `${check} visible safety item(s) require verification. ${pass} item(s) passed.`;
  }

  return `${pass} visible safety item(s) were assessed as PASS.`;
}

/* =========================================================
   INSERT INSPECTION
   ========================================================= */

async function insertInspection(
  env: Env,
  id: string,
  inspectionNo: string,
  location: string,
  inspector: string,
  createdAt: string
): Promise<void> {
  const columns =
    await getTableColumns(
      env.SAFETY_DB,
      "inspections"
    );

  const insert =
    buildInsert(
      "inspections",
      columns,
      {
        id,

        inspection_no:
          inspectionNo,

        location:
          location ||
          null,

        inspector:
          inspector ||
          null,

        created_at:
          createdAt,

        overall_result:
          "CHECK_REQUIRED",
      }
    );

  await env.SAFETY_DB
    .prepare(
      insert.sql
    )
    .bind(
      ...insert.params
    )
    .run();
}

/* =========================================================
   INSERT PHOTO
   ========================================================= */

async function insertPhoto(
  env: Env,
  photoId: string,
  inspectionId: string,
  objectKey: string,
  fileName: string,
  contentType: string,
  createdAt: string
): Promise<void> {
  const columns =
    await getTableColumns(
      env.SAFETY_DB,
      "inspection_photos"
    );

  if (
    !columns.has(
      "object_key"
    )
  ) {
    throw new Error(
      "inspection_photos.object_key column does not exist."
    );
  }

  const insert =
    buildInsert(
      "inspection_photos",
      columns,
      {
        id:
          photoId,

        inspection_id:
          inspectionId,

        object_key:
          objectKey,

        file_name:
          fileName,

        content_type:
          contentType,

        created_at:
          createdAt,
      }
    );

  await env.SAFETY_DB
    .prepare(
      insert.sql
    )
    .bind(
      ...insert.params
    )
    .run();
}

/* =========================================================
   INSERT ITEMS
   ========================================================= */

async function insertInspectionItems(
  env: Env,
  inspectionId: string,
  photoId: string,
  findings: Finding[]
): Promise<void> {
  if (
    findings.length ===
    0
  ) {
    return;
  }

  const columns =
    await getTableColumns(
      env.SAFETY_DB,
      "inspection_items"
    );

  const statements =
    findings.map(
      finding => {
        const insert =
          buildInsert(
            "inspection_items",
            columns,
            {
              id:
                uuid(),

              inspection_id:
                inspectionId,

              photo_id:
                photoId,

              category:
                finding.category,

              title:
                finding.title,

              observation:
                finding.observation,

              status:
                finding.status,

              risk_level:
                finding.risk_level,

              confidence:
                finding.confidence,

              check_id:
                finding.check_id,

              source_type:
                finding.source_type,

              source_title:
                finding.source_title,

              source_url:
                finding.source_url,

              created_at:
                nowISO(),
            }
          );

        return env.SAFETY_DB
          .prepare(
            insert.sql
          )
          .bind(
            ...insert.params
          );
      }
    );

  await env.SAFETY_DB.batch(
    statements
  );
}

/* =========================================================
   UPDATE INSPECTION
   ========================================================= */

async function updateInspection(
  env: Env,
  inspectionId: string,
  result:
    | "PASS"
    | "ATTENTION"
    | "CHECK_REQUIRED"
): Promise<void> {
  const columns =
    await getTableColumns(
      env.SAFETY_DB,
      "inspections"
    );

  if (
    !columns.has(
      "overall_result"
    )
  ) {
    return;
  }

  await env.SAFETY_DB
    .prepare(
      `
      UPDATE inspections
      SET overall_result = ?
      WHERE id = ?
      `
    )
    .bind(
      result,
      inspectionId
    )
    .run();
}

/* =========================================================
   R2
   ========================================================= */

async function uploadToR2(
  env: Env,
  objectKey: string,
  photo: PhotoInput,
  metadata: {
    inspectionId: string;
    photoId: string;
    inspectionNo: string;
  }
): Promise<void> {
  await env.PHOTOS.put(
    objectKey,
    photo.bytes,
    {
      httpMetadata: {
        contentType:
          photo.contentType,

        contentDisposition:
          `inline; filename="${photo.fileName}"`,
      },

      customMetadata: {
        inspectionId:
          metadata.inspectionId,

        photoId:
          metadata.photoId,

        inspectionNo:
          metadata.inspectionNo,
      },
    }
  );
}

/* =========================================================
   MAIN ANALYSIS
   ========================================================= */

async function analyze(
  request: Request,
  env: Env
): Promise<Response> {
  let stage =
    "starting";

  let inspectionId =
    "";

  let photoId =
    "";

  let objectKey =
    "";

  let r2Uploaded =
    false;

  try {
    stage =
      "parse image";

    const input =
      await parseRequest(
        request
      );

    const photo =
      input.photo;

    stage =
      "create IDs";

    inspectionId =
      uuid();

    photoId =
      uuid();

    const inspectionNo =
      inspectionNumber();

    const createdAt =
      nowISO();

    stage =
      "generate R2 object key";

    objectKey =
      `inspections/${inspectionId}/${photoId}.${extension(
        photo.contentType
      )}`;

    stage =
      "D1 create inspection";

    await insertInspection(
      env,
      inspectionId,
      inspectionNo,
      input.location,
      input.inspector,
      createdAt
    );

    stage =
      "R2 upload";

    await uploadToR2(
      env,
      objectKey,
      photo,
      {
        inspectionId,
        photoId,
        inspectionNo,
      }
    );

    r2Uploaded =
      true;

    stage =
      "D1 save inspection photo";

    await insertPhoto(
      env,
      photoId,
      inspectionId,
      objectKey,
      photo.fileName,
      photo.contentType,
      createdAt
    );

    stage =
      "D1 load safety checks";

    const checks =
      await loadSafetyChecks(
        env
      );

    /*
     * -----------------------------------------------------
     * 1. SCENE ANALYSIS
     * -----------------------------------------------------
     */

    stage =
      "scene analysis";

    const scene =
      await analyzeScene(
        env,
        photo.bytes,
        photo.contentType,
        input.location
      );

    /*
     * -----------------------------------------------------
     * 2. VECTORIZE SEARCH
     * -----------------------------------------------------
     */

    stage =
      "Vectorize search";

    const vectorChecks =
      await searchSafetyChecks(
        env,
        scene.raw
      );

    /*
     * -----------------------------------------------------
     * 3. FINAL VISION ANALYSIS
     * -----------------------------------------------------
     */

    stage =
      "final safety analysis";

    const finalRaw =
      await runFinalAI(
        env,
        photo.bytes,
        photo.contentType,
        scene.raw,
        vectorChecks
      );

    /*
     * -----------------------------------------------------
     * 4. PARSE AI
     * -----------------------------------------------------
     */

    stage =
      "parse final AI response";

    const parsed =
      parseAIResponse(
        finalRaw
      );

    /*
     * -----------------------------------------------------
     * 5. MATCH D1 / FOREIGN KEY SAFE
     * -----------------------------------------------------
     */

    stage =
      "match WSH checks";

    const findings =
      normalizeFindings(
        parsed,
        checks,
        vectorChecks
      );

    /*
     * -----------------------------------------------------
     * 6. SAVE FINDINGS
     * -----------------------------------------------------
     */

    stage =
      "D1 save inspection items";

    await insertInspectionItems(
      env,
      inspectionId,
      photoId,
      findings
    );

    /*
     * -----------------------------------------------------
     * 7. OVERALL RESULT
     * -----------------------------------------------------
     */

    stage =
      "calculate overall result";

    const result =
      overall(
        findings
      );

    stage =
      "D1 update inspection";

    await updateInspection(
      env,
      inspectionId,
      result
    );

    return jsonResponse({
      ok: true,

      inspection: {
        id:
          inspectionId,

        inspection_no:
          inspectionNo,

        location:
          input.location,

        inspector:
          input.inspector,

        overall_result:
          result,

        created_at:
          createdAt,
      },

      photo: {
        id:
          photoId,

        object_key:
          objectKey,

        file_name:
          photo.fileName,

        content_type:
          photo.contentType,
      },

      ai: {
        vision_model:
          VISION_MODEL,

        embedding_model:
          EMBEDDING_MODEL,

        scene_analysis:
          scene.raw,

        final_response:
          finalRaw,

        response_length:
          finalRaw.length,
      },

      vectorize: {
        index:
          VECTORIZE_INDEX,

        threshold:
          VECTOR_MATCH_THRESHOLD,

        matches:
          vectorChecks.map(
            item => ({
              id:
                item.id,

              score:
                item.score,

              category:
                item.check
                  ?.category ||
                null,

              source_type:
                item.check
                  ?.source_type ||
                null,
            })
          ),
      },

      summary:
        buildSummary(
          findings
        ),

      findings,

      counts: {
        total:
          findings.length,

        pass:
          findings.filter(
            f =>
              f.status ===
              "PASS"
          ).length,

        fail:
          findings.filter(
            f =>
              f.status ===
              "FAIL"
          ).length,

        check_required:
          findings.filter(
            f =>
              f.status ===
              "CHECK_REQUIRED"
          ).length,
      },
    });
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : String(error);

    if (
      r2Uploaded &&
      objectKey
    ) {
      try {
        await env.PHOTOS.delete(
          objectKey
        );
      } catch {
        // Ignore cleanup failure.
      }
    }

    if (
      inspectionId
    ) {
      try {
        await updateInspection(
          env,
          inspectionId,
          "CHECK_REQUIRED"
        );
      } catch {
        // Ignore secondary failure.
      }
    }

    const diagnostic =
      [
        "AI analysis failed.",

        `Stage: ${stage}`,

        `Detail: ${detail}`,

        inspectionId
          ? `Inspection ID: ${inspectionId}`
          : "",

        photoId
          ? `Photo ID: ${photoId}`
          : "",

        objectKey
          ? `R2 object: ${objectKey}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

    return jsonResponse(
      {
        ok: false,

        error:
          diagnostic,

        stage,

        detail,

        inspectionId:
          inspectionId ||
          null,

        photoId:
          photoId ||
          null,

        objectKey:
          objectKey ||
          null,
      },
      500
    );
  }
}

/* =========================================================
   GET INSPECTION
   ========================================================= */

async function getInspection(
  env: Env,
  id: string
): Promise<Response> {
  try {
    const inspection =
      await env.SAFETY_DB
        .prepare(
          `
          SELECT *
          FROM inspections
          WHERE id = ?
          LIMIT 1
          `
        )
        .bind(id)
        .first();

    if (
      !inspection
    ) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Inspection not found.",
        },
        404
      );
    }

    const photos =
      await env.SAFETY_DB
        .prepare(
          `
          SELECT *
          FROM inspection_photos
          WHERE inspection_id = ?
          ORDER BY created_at
          `
        )
        .bind(id)
        .all();

    const items =
      await env.SAFETY_DB
        .prepare(
          `
          SELECT
            ii.*,
            sc.check_question,
            sc.guidance,
            sc.source_type
          FROM inspection_items ii
          LEFT JOIN safety_checks sc
            ON sc.id = ii.check_id
          WHERE ii.inspection_id = ?
          ORDER BY ii.created_at
          `
        )
        .bind(id)
        .all();

    return jsonResponse({
      ok: true,

      inspection,

      photos:
        photos.results ||
        [],

      findings:
        items.results ||
        [],
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,

        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}

/* =========================================================
   RECENT INSPECTIONS
   ========================================================= */

async function recentInspections(
  env: Env
): Promise<Response> {
  try {
    const result =
      await env.SAFETY_DB
        .prepare(
          `
          SELECT *
          FROM inspections
          ORDER BY created_at DESC
          LIMIT 30
          `
        )
        .all();

    return jsonResponse({
      ok: true,

      inspections:
        result.results ||
        [],
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,

        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}

/* =========================================================
   SAFETY CHECK API
   ========================================================= */

async function safetyChecks(
  env: Env
): Promise<Response> {
  try {
    const checks =
      await loadSafetyChecks(
        env
      );

    return jsonResponse({
      ok: true,

      count:
        checks.length,

      checks,
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,

        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}

/* =========================================================
   VECTORIZE TEST SEARCH
   ========================================================= */

async function vectorizeSearchAPI(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    let text =
      "";

    if (
      request.method ===
      "GET"
    ) {
      const url =
        new URL(
          request.url
        );

      text =
        clean(
          url.searchParams.get(
            "q"
          ),
          2000
        );
    } else {
      const body =
        await request.json<any>();

      text =
        clean(
          body?.query ||
            body?.text,
          2000
        );
    }

    if (!text) {
      return jsonResponse(
        {
          ok: false,
          error:
            "Missing query text.",
        },
        400
      );
    }

    const matches =
      await searchSafetyChecks(
        env,
        text
      );

    return jsonResponse({
      ok: true,

      query:
        text,

      threshold:
        VECTOR_MATCH_THRESHOLD,

      matches:
        matches.map(
          item => ({
            id:
              item.id,

            score:
              item.score,

            check:
              item.check,
          })
        ),
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,

        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}

/* =========================================================
   PHOTO API
   ========================================================= */

async function getPhoto(
  env: Env,
  objectKey: string
): Promise<Response> {
  try {
    const object =
      await env.PHOTOS.get(
        objectKey
      );

    if (!object) {
      return textResponse(
        "Photo not found.",
        404
      );
    }

    const headers =
      new Headers();

    object.writeHttpMetadata(
      headers
    );

    headers.set(
      "ETag",
      object.httpEtag
    );

    headers.set(
      "Cache-Control",
      "private, max-age=3600"
    );

    return new Response(
      object.body,
      {
        status: 200,
        headers,
      }
    );
  } catch (error) {
    return textResponse(
      error instanceof Error
        ? error.message
        : String(error),
      500
    );
  }
}

/* =========================================================
   HEALTH
   ========================================================= */

async function health(
  env: Env
): Promise<Response> {
  let database =
    false;

  let safetyChecks =
    false;

  let r2 =
    false;

  let vectorize =
    false;

  let vectorizeSeedKey =
    false;

  try {
    await env.SAFETY_DB
      .prepare(
        "SELECT 1 AS ok"
      )
      .first();

    database =
      true;
  } catch {
    database =
      false;
  }

  try {
    await loadSafetyChecks(
      env
    );

    safetyChecks =
      true;
  } catch {
    safetyChecks =
      false;
  }

  try {
    r2 =
      !!env.PHOTOS;
  } catch {
    r2 =
      false;
  }

  try {
    vectorize =
      !!env.VECTORIZE;
  } catch {
    vectorize =
      false;
  }

  try {
    vectorizeSeedKey =
      !!env.VECTORIZE_SEED_KEY;
  } catch {
    vectorizeSeedKey =
      false;
  }

  return jsonResponse({
    ok:
      database &&
      safetyChecks &&
      r2 &&
      vectorize,

    worker:
      "depot-safety",

    model:
      VISION_MODEL,

    embedding_model:
      EMBEDDING_MODEL,

    database,

    safety_checks:
      safetyChecks,

    r2,

    vectorize,

    vectorize_index:
      VECTORIZE_INDEX,

    vectorize_dimensions:
      768,

    vector_match_threshold:
      VECTOR_MATCH_THRESHOLD,

    vectorize_seed_key:
      vectorizeSeedKey,

    timestamp:
      nowISO(),
  });
}

/* =========================================================
   API ROUTER
   ========================================================= */

async function api(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const path =
    url.pathname;

  /*
   * HEALTH
   */

  if (
    request.method ===
      "GET" &&
    path ===
      "/api/health"
  ) {
    return health(
      env
    );
  }

  /*
   * ANALYZE
   */

  if (
    request.method ===
      "POST" &&
    (
      path ===
        "/api/analyze" ||
      path ===
        "/api/analysis"
    )
  ) {
    return analyze(
      request,
      env
    );
  }

  /*
   * INSPECTIONS
   */

  if (
    request.method ===
      "GET" &&
    path ===
      "/api/inspections"
  ) {
    return recentInspections(
      env
    );
  }

  /*
   * SINGLE INSPECTION
   */

  if (
    request.method ===
      "GET" &&
    path.startsWith(
      "/api/inspection/"
    )
  ) {
    const id =
      decodeURIComponent(
        path.substring(
          "/api/inspection/"
            .length
        )
      );

    if (!id) {
      return jsonResponse(
        {
          ok: false,

          error:
            "Missing inspection ID.",
        },
        400
      );
    }

    return getInspection(
      env,
      id
    );
  }

  /*
   * SAFETY CHECKS
   */

  if (
    request.method ===
      "GET" &&
    path ===
      "/api/safety-checks"
  ) {
    return safetyChecks(
      env
    );
  }

  /*
   * VECTORIZE SEED
   */

  if (
    request.method ===
      "POST" &&
    path ===
      "/api/vectorize/seed"
  ) {
    return vectorizeSeed(
      request,
      env
    );
  }

  /*
   * VECTORIZE SEARCH
   */

  if (
    (
      request.method ===
        "GET" ||
      request.method ===
        "POST"
    ) &&
    path ===
      "/api/vectorize/search"
  ) {
    return vectorizeSearchAPI(
      request,
      env
    );
  }

  /*
   * PHOTO
   */

  if (
    request.method ===
      "GET" &&
    path ===
      "/api/photo"
  ) {
    const key =
      url.searchParams.get(
        "key"
      );

    if (!key) {
      return textResponse(
        "Missing photo key.",
        400
      );
    }

    return getPhoto(
      env,
      key
    );
  }

  /*
   * UNKNOWN API
   */

  return jsonResponse(
    {
      ok: false,

      error:
        "API endpoint not found.",

      path,
    },
    404
  );
}

/* =========================================================
   WORKER ENTRY
   ========================================================= */

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    try {
      if (
        request.method ===
        "OPTIONS"
      ) {
        return new Response(
          null,
          {
            status: 204,

            headers: {
              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Methods":
                "GET, POST, OPTIONS",

              "Access-Control-Allow-Headers":
                "Content-Type, Authorization, X-Vectorize-Seed-Key",
            },
          }
        );
      }

      const url =
        new URL(
          request.url
        );

      if (
        url.pathname.startsWith(
          "/api/"
        )
      ) {
        return api(
          request,
          env,
          url
        );
      }

      try {
        const asset =
          await env.ASSETS.fetch(
            request
          );

        if (
          asset.status !==
          404
        ) {
          return asset;
        }
      } catch {
        // Continue.
      }

      return new Response(
        "Depot Safety AI is running.",
        {
          status: 200,

          headers: {
            "Content-Type":
              "text/plain; charset=utf-8",
          },
        }
      );
    } catch (error) {
      return jsonResponse(
        {
          ok: false,

          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        500
      );
    }
  },
} satisfies ExportedHandler<Env>;
