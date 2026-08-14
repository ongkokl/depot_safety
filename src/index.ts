export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
  VECTORIZE: VectorizeIndex;
  ASSETS: Fetcher;

  /*
   * Worker Secret
   *
   * Used only for:
   * POST /api/vectorize/seed
   */
  VECTORIZE_SEED_KEY?: string;
}

/* =========================================================
   MODELS
   ========================================================= */

const VISION_MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const EMBEDDING_MODEL =
  "@cf/baai/bge-base-en-v1.5";

const VECTORIZE_INDEX =
  "safety-checks";

const VECTOR_MATCH_THRESHOLD =
  0.45;

const MAX_IMAGE_SIZE =
  12 * 1024 * 1024;

const MAX_FINDINGS =
  8;

const MAX_SCENE_ITEMS =
  12;

const MAX_RETRIEVED_CHECKS =
  12;

/* =========================================================
   TYPES
   ========================================================= */

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

interface SceneItem {
  item: string;
  category: string;
  confidence: number;
  visible_details: string;
}

interface SceneAnalysis {
  scene_summary: string;
  visible_items: SceneItem[];
}

interface RetrievedCheck {
  check: SafetyCheck;
  score: number;
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
          "Content-Type, X-Vectorize-Seed-Key",
      },
    }
  );
}

function textResponse(
  text: string,
  status = 200
): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type":
        "text/plain; charset=utf-8",

      "Access-Control-Allow-Origin":
        "*",
    },
  });
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
  return clean(value, max)
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/^#+\s*/g, "")
    .replace(/^[-*•]\s*/g, "")
    .trim();
}

function inspectionNumber(): string {
  const d = new Date();

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

/* =========================================================
   CONTENT TYPE
   ========================================================= */

function normalizeContentType(
  value: unknown
): string {
  const type =
    String(value || "")
      .toLowerCase()
      .split(";")[0]
      .trim();

  if (type === "image/png")
    return "image/png";

  if (type === "image/webp")
    return "image/webp";

  if (type === "image/gif")
    return "image/gif";

  if (type === "image/heic")
    return "image/heic";

  if (type === "image/heif")
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

    binary += String.fromCharCode(
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

  /*
   * MULTIPART
   */

  if (
    contentType
      .toLowerCase()
      .includes(
        "multipart/form-data"
      )
  ) {

    const form =
      await request.formData();

    let file: File | null =
      null;

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
          form.get("location"),
          200
        ) || "Unspecified",

      inspector:
        clean(
          form.get("inspector"),
          200
        ) || "Unspecified",
    };
  }

  /*
   * JSON
   */

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
      ) || "Unspecified",

    inspector:
      clean(
        body?.inspector,
        200
      ) || "Unspecified",
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
        row =>
          row.name
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
    Object.entries(values)
      .filter(
        ([column]) =>
          columns.has(
            column
          )
      );

  if (!selected.length) {
    throw new Error(
      `No matching columns found in ${table}.`
    );
  }

  const names =
    selected.map(
      ([column]) =>
        `"${column}"`
    );

  const placeholders =
    selected.map(
      () => "?"
    );

  const params =
    selected.map(
      ([, value]) =>
        value
    );

  return {
    sql: `
      INSERT INTO "${table}"
      (${names.join(", ")})
      VALUES (${placeholders.join(", ")})
    `,
    params,
  };
}

/* =========================================================
   LOAD SAFETY CHECKS
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

  if (missing.length) {
    throw new Error(
      `safety_checks is missing columns: ${missing.join(
        ", "
      )}`
    );
  }

  const hasSourceType =
    columns.has(
      "source_type"
    );

  const sourceTypeSQL =
    hasSourceType
      ? "source_type"
      : "'WSHC_DERIVED' AS source_type";

  const result =
    await env.SAFETY_DB
      .prepare(
        `
        SELECT
          id,
          category,
          ${sourceTypeSQL},
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
    result.results || []
  );
}

/* =========================================================
   SCENE ANALYSIS
   ========================================================= */

function sceneSchema() {
  return {
    type: "object",

    properties: {

      scene_summary: {
        type: "string",
      },

      visible_items: {
        type: "array",

        items: {
          type: "object",

          properties: {

            item: {
              type: "string",
            },

            category: {
              type: "string",
            },

            confidence: {
              type: "number",
            },

            visible_details: {
              type: "string",
            },
          },

          required: [
            "item",
            "category",
            "confidence",
            "visible_details",
          ],
        },
      },
    },

    required: [
      "scene_summary",
      "visible_items",
    ],
  };
}

function buildScenePrompt(): string {

  return `
You are the visual scene identification stage of a workplace safety inspection system for a Singapore shipping and container depot.

Your task is NOT to decide PASS or FAIL.

Your task is to identify safety-relevant objects, equipment, activities and conditions that are visibly present in the photograph.

Only report things that can actually be seen.

Do NOT invent objects.

Important examples of things to identify when visible:

- workers
- hard hats
- high visibility vests
- safety shoes
- gloves
- ladders
- mobile access platforms
- working platforms
- guardrails
- stairs
- handrails
- reach stackers
- forklifts
- container handlers
- cranes
- lifting equipment
- slings
- chains
- hooks
- gas cylinders
- welding equipment
- cutting equipment
- hot work
- electrical equipment
- cables
- machinery
- container repair equipment
- vehicles
- traffic lanes
- pedestrians
- storage
- stacked containers
- hazardous substances
- chemical containers
- spills
- oil
- obstructions
- damaged equipment
- unsafe access
- housekeeping conditions

If an object is visible but its exact type is uncertain, describe it conservatively.

For example:

"mobile access platform / ladder structure"

rather than inventing a specific equipment model.

The category should be one of:

PPE
Housekeeping
Vehicular Safety
Work at Height
Lifting
Electrical Safety
Fire Safety
Chemical Safety
Confined Space
Forklift Safety
Reach Stacker Safety
Loading and Unloading
Machinery Safety
Manual Handling
Hot Work
Noise
Storage and Stacking
Risk Assessment
Other

Return JSON only.
`.trim();
}

async function runSceneAnalysis(
  env: Env,
  photo: PhotoInput
): Promise<SceneAnalysis> {

  const image =
    imageDataUrl(
      photo.bytes,
      photo.contentType
    );

  let response: any;

  try {

    response =
      await env.AI.run(
        VISION_MODEL,
        {
          messages: [
            {
              role: "system",

              content:
                "You identify visible safety-related objects and activities. Never invent objects.",
            },

            {
              role: "user",

              content:
                buildScenePrompt(),
            },
          ],

          image,

          max_tokens: 700,

          temperature: 0.05,

          top_p: 0.8,

          response_format: {
            type:
              "json_object",
          },
        } as any
      );

  } catch (error) {

    throw new Error(
      `Scene analysis failed: ${
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
        : typeof response?.result ===
            "string"
          ? response.result
          : "";

  if (!raw.trim()) {

    throw new Error(
      `Scene analysis returned no text. Response: ${JSON.stringify(
        response
      ).substring(0, 3000)}`
    );
  }

  let parsed: any;

  try {

    parsed =
      JSON.parse(
        raw
          .replace(
            /^```json\s*/i,
            ""
          )
          .replace(
            /^```\s*/i,
            ""
          )
          .replace(
            /\s*```$/i,
            ""
          )
          .trim()
      );

  } catch {

    throw new Error(
      `Scene analysis returned invalid JSON: ${raw.substring(
        0,
        2000
      )}`
    );
  }

  const visibleItems =
    Array.isArray(
      parsed?.visible_items
    )
      ? parsed.visible_items
      : [];

  const items: SceneItem[] =
    visibleItems
      .map(
        (item: any) => {

          const confidence =
            Number(
              item?.confidence
            );

          return {
            item:
              clean(
                item?.item,
                200
              ),

            category:
              normalizeCategory(
                clean(
                  item?.category,
                  100
                )
              ),

            confidence:
              Number.isFinite(
                confidence
              )
                ? Math.max(
                    0,
                    Math.min(
                      1,
                      confidence
                    )
                  )
                : 0.6,

            visible_details:
              clean(
                item?.visible_details,
                500
              ),
          };
        }
      )
      .filter(
        item =>
          item.item
      )
      .slice(
        0,
        MAX_SCENE_ITEMS
      );

  return {
    scene_summary:
      clean(
        parsed?.scene_summary,
        1000
      ),

    visible_items:
      items,
  };
}

/* =========================================================
   EMBEDDINGS
   ========================================================= */

interface EmbeddingResponse {
  shape: number[];
  data: number[][];
}

async function createEmbedding(
  env: Env,
  text: string
): Promise<number[]> {

  const result =
    await env.AI.run(
      EMBEDDING_MODEL,
      {
        text: [
          clean(
            text,
            2000
          ),
        ],
      }
    ) as unknown as
      EmbeddingResponse;

  const vector =
    result?.data?.[0];

  if (
    !vector ||
    !Array.isArray(vector)
  ) {
    throw new Error(
      "Embedding model returned no vector."
    );
  }

  if (
    vector.length !== 768
  ) {
    throw new Error(
      `Embedding dimension mismatch. Expected 768 but received ${vector.length}.`
    );
  }

  return vector;
}

/* =========================================================
   VECTORIZE SAFETY CHECK SEARCH
   ========================================================= */

async function searchVectorize(
  env: Env,
  queryText: string,
  checks: SafetyCheck[]
): Promise<RetrievedCheck[]> {

  const vector =
    await createEmbedding(
      env,
      queryText
    );

  const result =
    await env.VECTORIZE.query(
      vector,
      {
        topK:
          MAX_RETRIEVED_CHECKS,

        returnMetadata:
          true,
      } as any
    );

  const matches =
    Array.isArray(
      (result as any)?.matches
    )
      ? (result as any).matches
      : [];

  const output:
    RetrievedCheck[] = [];

  for (
    const match of matches
  ) {

    const score =
      Number(
        match?.score
      );

    if (
      !Number.isFinite(score)
    ) {
      continue;
    }

    if (
      score <
      VECTOR_MATCH_THRESHOLD
    ) {
      continue;
    }

    const id =
      String(
        match?.id || ""
      );

    const check =
      checks.find(
        item =>
          item.id === id
      );

    if (!check) {
      continue;
    }

    output.push({
      check,
      score,
    });
  }

  return output;
}

/* =========================================================
   RETRIEVE CHECKS FROM SCENE
   ========================================================= */

async function retrieveRelevantChecks(
  env: Env,
  scene: SceneAnalysis,
  checks: SafetyCheck[]
): Promise<RetrievedCheck[]> {

  if (
    !scene.visible_items.length
  ) {
    return [];
  }

  const all =
    new Map<
      string,
      RetrievedCheck
    >();

  /*
   * Search each visible safety-relevant
   * object/activity independently.
   */

  for (
    const item of
    scene.visible_items
  ) {

    const query =
      [
        item.category,

        item.item,

        item.visible_details,
      ]
        .filter(Boolean)
        .join(
          " - "
        );

    try {

      const matches =
        await searchVectorize(
          env,
          query,
          checks
        );

      for (
        const match of matches
      ) {

        const existing =
          all.get(
            match.check.id
          );

        if (
          !existing ||
          match.score >
            existing.score
        ) {
          all.set(
            match.check.id,
            match
          );
        }
      }

    } catch {
      /*
       * Do not fail the whole inspection
       * if one Vectorize query fails.
       */
    }
  }

  return Array.from(
    all.values()
  )
    .sort(
      (a, b) =>
        b.score -
        a.score
    )
    .slice(
      0,
      MAX_RETRIEVED_CHECKS
    );
}

/* =========================================================
   CATEGORY NORMALIZATION
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
    ) ||
    lower.includes(
      "access platform"
    ) ||
    lower.includes(
      "ladder"
    )
  ) {
    return "Work at Height";
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
      "chemical"
    )
  ) {
    return "Chemical Safety";
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
      "hot work"
    ) ||
    lower.includes(
      "welding"
    ) ||
    lower.includes(
      "cutting"
    )
  ) {
    return "Hot Work";
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
      "noise"
    )
  ) {
    return "Noise";
  }

  if (
    lower.includes(
      "risk"
    )
  ) {
    return "Risk Assessment";
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

  return value;
}

/* =========================================================
   SAFETY ASSESSMENT
   ========================================================= */

function assessmentSchema() {
  return {
    type: "object",

    properties: {

      findings: {
        type: "array",

        items: {
          type: "object",

          properties: {

            category: {
              type: "string",
            },

            title: {
              type: "string",
            },

            observation: {
              type: "string",
            },

            status: {
              type: "string",

              enum: [
                "PASS",
                "FAIL",
                "CHECK_REQUIRED",
              ],
            },

            risk: {
              type: "string",

              enum: [
                "LOW",
                "MEDIUM",
                "HIGH",
              ],
            },

            confidence: {
              type: "number",
            },

            check_id: {
              type: [
                "string",
                "null",
              ],
            },
          },

          required: [
            "category",
            "title",
            "observation",
            "status",
            "risk",
            "confidence",
            "check_id",
          ],
        },
      },
    },

    required: [
      "findings",
    ],
  };
}

function buildAssessmentPrompt(
  scene: SceneAnalysis,
  retrieved: RetrievedCheck[]
): string {

  const visible =
    scene.visible_items
      .map(
        item =>
          `
ITEM:
${item.item}

CATEGORY:
${item.category}

CONFIDENCE:
${item.confidence}

VISIBLE DETAILS:
${item.visible_details}
`
      )
      .join("\n");

  const checks =
    retrieved
      .map(
        item =>
          `
CHECK ID:
${item.check.id}

CATEGORY:
${item.check.category}

SOURCE TYPE:
${item.check.source_type}

CHECK QUESTION:
${item.check.check_question}

GUIDANCE:
${item.check.guidance}

SOURCE:
${item.check.source_title}

URL:
${item.check.source_url}

VECTOR SCORE:
${item.score.toFixed(3)}
`
      )
      .join("\n");

  return `
You are the final safety assessment stage for a Singapore shipping and container depot inspection.

You must assess ONLY safety conditions that are visibly relevant to the photograph.

Do not invent hazards.

Do not assume an operation is occurring if it cannot be seen.

However, if safety-related equipment, machinery, access equipment or a work activity is visibly present and the photograph is insufficient to verify its safe condition, create a CHECK_REQUIRED finding.

This is important.

Do NOT return an empty result merely because there is no obvious failure.

For example:

If a mobile access platform is visible:
create a Work at Height CHECK_REQUIRED finding if the photograph cannot establish stability, condition, safe access or other compliance requirements.

If a reach stacker is visible:
create a Reach Stacker Safety CHECK_REQUIRED or PASS finding depending on what can actually be verified.

If a forklift is visible:
assess only visible forklift-related conditions.

If PPE is clearly visible:
assess the PPE that can actually be seen.

PASS:
The visible condition appears satisfactory.

FAIL:
A visible unsafe condition is clearly identified.

CHECK_REQUIRED:
A relevant safety condition/equipment/activity is visible, but the photograph is insufficient to verify compliance.

Do NOT create negative findings such as:

"No visible lifting operation"
"No visible electrical equipment"
"No visible fire hazard"
"No visible work at height"

Those must be omitted.

IMPORTANT:

Use only the supplied WSHC-derived checks.

Every finding MUST use one of the supplied CHECK IDs.

Never invent a CHECK ID.

If no supplied check is relevant to a visible safety item, omit that item rather than inventing a check.

Confidence must be between 0 and 1.

Risk rules:

LOW:
Visible condition appears satisfactory or minor concern.

MEDIUM:
Potential safety concern or verification is needed.

HIGH:
Serious visible unsafe condition.

VISIBLE SCENE:

${visible}

RETRIEVED WSHC CHECKS:

${checks}

Return JSON only.
`.trim();
}

/* =========================================================
   RUN FINAL AI
   ========================================================= */

async function runAssessmentAI(
  env: Env,
  photo: PhotoInput,
  scene: SceneAnalysis,
  retrieved: RetrievedCheck[]
): Promise<any[]> {

  if (
    retrieved.length ===
    0
  ) {

    /*
     * We intentionally do not ask AI to
     * invent a WSHC check.
     *
     * Scene items can still become
     * CHECK_REQUIRED only when a matching
     * check exists.
     */

    return [];
  }

  const image =
    imageDataUrl(
      photo.bytes,
      photo.contentType
    );

  let response: any;

  try {

    response =
      await env.AI.run(
        VISION_MODEL,
        {
          messages: [
            {
              role: "system",

              content:
                "You are a careful workplace safety inspector. Assess only visible evidence and use only the supplied safety checks.",
            },

            {
              role: "user",

              content:
                buildAssessmentPrompt(
                  scene,
                  retrieved
                ),
            },
          ],

          image,

          max_tokens:
            1200,

          temperature:
            0.05,

          top_p:
            0.8,

          response_format: {
            type:
              "json_object",
          },
        } as any
      );

  } catch (error) {

    throw new Error(
      `Safety assessment failed: ${
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
        : typeof response?.result ===
            "string"
          ? response.result
          : "";

  if (!raw.trim()) {

    throw new Error(
      `Safety assessment returned no text. Response: ${JSON.stringify(
        response
      ).substring(0, 3000)}`
    );
  }

  let parsed: any;

  try {

    parsed =
      JSON.parse(
        raw
          .replace(
            /^```json\s*/i,
            ""
          )
          .replace(
            /^```\s*/i,
            ""
          )
          .replace(
            /\s*```$/i,
            ""
          )
          .trim()
      );

  } catch {

    throw new Error(
      `Safety assessment returned invalid JSON: ${raw.substring(
        0,
        3000
      )}`
    );
  }

  if (
    !Array.isArray(
      parsed?.findings
    )
  ) {
    return [];
  }

  return parsed.findings
    .slice(
      0,
      MAX_FINDINGS
    );
}

/* =========================================================
   STATUS / RISK
   ========================================================= */

function normalizeStatus(
  value: unknown
): Status {

  const text =
    cleanMarkdown(
      value,
      100
    ).toUpperCase();

  if (
    text === "PASS"
  ) {
    return "PASS";
  }

  if (
    text === "FAIL"
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
      value,
      100
    ).toUpperCase();

  if (
    text === "HIGH"
  ) {
    return "HIGH";
  }

  if (
    text === "MEDIUM"
  ) {
    return "MEDIUM";
  }

  if (
    text === "LOW"
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

function parseConfidence(
  value: unknown
): number {

  let number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    number = 0.6;
  }

  if (
    number > 1
  ) {
    number /=
      100;
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
   NEGATIVE FINDINGS
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

  const negativePatterns = [
    "no visible",
    "not visible",
    "there is no visible",
    "no evidence",
    "cannot be determined",
    "not observed",
    "not apparent",
    "no visible work at height",
    "no visible lifting",
    "no visible electrical",
    "no visible fire",
    "no visible storage",
    "no work at height",
    "no lifting operation",
    "no electrical equipment",
    "no fire hazards",
    "no storage hazards",
  ];

  return negativePatterns.some(
    pattern =>
      text.includes(
        pattern
      )
  );
}

/* =========================================================
   NORMALIZE FINAL FINDINGS
   ========================================================= */

function normalizeFinalFindings(
  rawFindings: any[],
  checks: SafetyCheck[],
  retrieved: RetrievedCheck[]
): Finding[] {

  const output:
    Finding[] = [];

  const seen =
    new Set<string>();

  for (
    const raw of rawFindings
  ) {

    const category =
      normalizeCategory(
        clean(
          raw?.category,
          100
        )
      );

    const title =
      cleanMarkdown(
        raw?.title,
        250
      );

    const observation =
      cleanMarkdown(
        raw?.observation,
        1200
      );

    const checkId =
      cleanMarkdown(
        raw?.check_id,
        100
      );

    if (
      !category ||
      !observation ||
      !checkId
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

    /*
     * IMPORTANT:
     *
     * Only accept a check ID that actually
     * exists in D1 and was retrieved from
     * Vectorize.
     *
     * This prevents FK failures.
     */

    const check =
      checks.find(
        item =>
          item.id ===
          checkId
      );

    if (!check) {
      continue;
    }

    const retrievedCheck =
      retrieved.find(
        item =>
          item.check.id ===
          checkId
      );

    if (!retrievedCheck) {
      continue;
    }

    const status =
      normalizeStatus(
        raw?.status
      );

    const risk =
      normalizeRisk(
        raw?.risk,
        status
      );

    const confidence =
      parseConfidence(
        raw?.confidence
      );

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

    output.push({
      category,

      title:
        title ||
        `${category} observation`,

      observation,

      status,

      risk_level:
        risk,

      confidence,

      check_id:
        check.id,

      source_type:
        check.source_type ||
        "WSHC_DERIVED",

      source_title:
        check.source_title ||
        null,

      source_url:
        check.source_url ||
        null,
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
   OVERALL RESULT
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
    return "No structured safety findings were generated. Physical/site verification is required.";
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

  const values:
    Record<
      string,
      unknown
    > = {

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
  };

  const insert =
    buildInsert(
      "inspections",
      columns,
      values
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

  const values:
    Record<
      string,
      unknown
    > = {

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
  };

  const insert =
    buildInsert(
      "inspection_photos",
      columns,
      values
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
   INSERT INSPECTION ITEMS
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

        const values:
          Record<
            string,
            unknown
          > = {

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

          source_title:
            finding.source_title,

          source_url:
            finding.source_url,

          created_at:
            nowISO(),
        };

        const insert =
          buildInsert(
            "inspection_items",
            columns,
            values
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

  try {

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

  } catch (error) {

    throw new Error(
      `R2 upload failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }
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

    /*
     * 1. Parse photo
     */

    stage =
      "parse image";

    const input =
      await parseRequest(
        request
      );

    const photo =
      input.photo;

    /*
     * 2. IDs
     */

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

    /*
     * 3. R2 key
     */

    stage =
      "generate R2 object key";

    objectKey =
      `inspections/${inspectionId}/${photoId}.${extension(
        photo.contentType
      )}`;

    /*
     * 4. D1 inspection
     */

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

    /*
     * 5. R2
     */

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

    /*
     * 6. D1 photo
     */

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

    /*
     * 7. Load WSHC checks
     */

    stage =
      "D1 load safety checks";

    const checks =
      await loadSafetyChecks(
        env
      );

    /*
     * 8. Vision scene detection
     */

    stage =
      "scene analysis";

    const scene =
      await runSceneAnalysis(
        env,
        photo
      );

    /*
     * 9. Vectorize retrieval
     */

    stage =
      "Vectorize safety check retrieval";

    const retrieved =
      await retrieveRelevantChecks(
        env,
        scene,
        checks
      );

    /*
     * 10. Final safety assessment
     */

    stage =
      "safety assessment";

    const aiFindings =
      await runAssessmentAI(
        env,
        photo,
        scene,
        retrieved
      );

    /*
     * 11. Validate findings
     */

    stage =
      "validate findings";

    const findings =
      normalizeFinalFindings(
        aiFindings,
        checks,
        retrieved
      );

    /*
     * 12. Save findings
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
     * 13. Overall
     */

    stage =
      "calculate overall result";

    const result =
      overall(
        findings
      );

    /*
     * 14. Update inspection
     */

    stage =
      "D1 update inspection";

    await updateInspection(
      env,
      inspectionId,
      result
    );

    /*
     * 15. Response
     */

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

      scene: {

        summary:
          scene.scene_summary,

        visible_items:
          scene.visible_items,
      },

      vectorize: {

        index:
          VECTORIZE_INDEX,

        threshold:
          VECTOR_MATCH_THRESHOLD,

        matches:
          retrieved.map(
            item => ({

              id:
                item.check.id,

              category:
                item.check.category,

              source_type:
                item.check.source_type,

              score:
                Number(
                  item.score.toFixed(
                    4
                  )
                ),
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

    /*
     * Remove R2 object if analysis
     * failed after upload.
     */

    if (
      r2Uploaded &&
      objectKey
    ) {

      try {

        await env.PHOTOS.delete(
          objectKey
        );

      } catch {
        // Ignore cleanup error.
      }
    }

    /*
     * Mark inspection as
     * CHECK_REQUIRED.
     */

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

    if (!inspection) {

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

    vectorize =
      !!env.VECTORIZE;

  } catch {

    vectorize =
      false;
  }

  try {

    r2 =
      !!env.PHOTOS;

  } catch {

    r2 =
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

    timestamp:
      nowISO(),
  });
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
   VECTORIZE SEED
   ========================================================= */

async function seedVectorize(
  request: Request,
  env: Env
): Promise<Response> {

  /*
   * Protect this endpoint.
   */

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
      503
    );
  }

  const suppliedKey =
    request.headers.get(
      "X-Vectorize-Seed-Key"
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
            "No active safety checks were found in D1.",
        },
        400
      );
    }

    /*
     * Create embeddings in batches.
     *
     * BGE supports batched input.
     */

    const indexedIds:
      string[] = [];

    const batchSize =
      20;

    for (
      let start = 0;
      start < checks.length;
      start += batchSize
    ) {

      const batch =
        checks.slice(
          start,
          start +
            batchSize
        );

      const texts =
        batch.map(
          check =>
            [
              check.category,

              check.check_question,

              check.guidance,

              check.keywords,
            ]
              .filter(Boolean)
              .join(
                " | "
              )
        );

      const embeddings =
        await env.AI.run(
          EMBEDDING_MODEL,
          {
            text: texts,
          }
        ) as unknown as
          EmbeddingResponse;

      if (
        !embeddings?.data
      ) {

        throw new Error(
          "Embedding model returned no data during seed."
        );
      }

      const vectors:
        any[] = [];

      for (
        let i = 0;
        i < batch.length;
        i++
      ) {

        const check =
          batch[i];

        const vector =
          embeddings.data[i];

        if (
          !vector ||
          vector.length !==
            768
        ) {

          throw new Error(
            `Invalid embedding for safety check ${check.id}.`
          );
        }

        vectors.push({

          id:
            check.id,

          values:
            vector,

          metadata: {

            category:
              check.category,

            source_type:
              check.source_type,

            source_title:
              check.source_title,
          },
        });

        indexedIds.push(
          check.id
        );
      }

      await env.VECTORIZE.upsert(
        vectors
      );
    }

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
        indexedIds.length,

      ids:
        indexedIds,
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
   VECTORIZE TEST
   ========================================================= */

async function vectorizeTest(
  request: Request,
  env: Env
): Promise<Response> {

  try {

    let text =
      "container depot safety";

    if (
      request.method ===
      "POST"
    ) {

      try {

        const body =
          await request.json();

        text =
          clean(
            body?.text,
            1000
          ) ||
          text;

      } catch {
        // Use default query.
      }
    }

    const checks =
      await loadSafetyChecks(
        env
      );

    const matches =
      await searchVectorize(
        env,
        text,
        checks
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
              item.check.id,

            category:
              item.check.category,

            source_type:
              item.check.source_type,

            source_title:
              item.check.source_title,

            score:
              Number(
                item.score.toFixed(
                  4
                )
              ),
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
   * RECENT INSPECTIONS
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
   * VECTORIZE SEED
   */

  if (
    request.method ===
      "POST" &&
    path ===
      "/api/vectorize/seed"
  ) {

    return seedVectorize(
      request,
      env
    );
  }

  /*
   * VECTORIZE TEST
   */

  if (
    (
      request.method ===
        "GET" ||
      request.method ===
        "POST"
    ) &&
    path ===
      "/api/vectorize/test"
  ) {

    return vectorizeTest(
      request,
      env
    );
  }

  /*
   * NOT FOUND
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

      /*
       * CORS preflight
       */

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
                "Content-Type, X-Vectorize-Seed-Key",
            },
          }
        );
      }

      const url =
        new URL(
          request.url
        );

      /*
       * API
       */

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

      /*
       * Static assets
       */

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
