export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
  VECTORIZE: VectorizeIndex;
  ASSETS: Fetcher;

  /*
   * Worker secret:
   *
   * VECTORIZE_SEED_KEY
   */
  VECTORIZE_SEED_KEY: string;
}

/* =========================================================
   CONFIGURATION
   ========================================================= */

const VISION_MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const EMBEDDING_MODEL =
  "@cf/baai/bge-base-en-v1.5";

const VECTORIZE_INDEX =
  "safety-checks";

const VECTORIZE_DIMENSIONS =
  768;

const VECTOR_MATCH_THRESHOLD =
  0.45;

const MAX_IMAGE_SIZE =
  12 * 1024 * 1024;

const MAX_FINDINGS = 8;

const MAX_SCENE_ITEMS = 20;

const MAX_VECTOR_CHECKS = 12;

type Status =
  | "PASS"
  | "FAIL"
  | "CHECK_REQUIRED";

type Risk =
  | "LOW"
  | "MEDIUM"
  | "HIGH";

/* =========================================================
   TYPES
   ========================================================= */

interface SafetyCheck {
  id: string;
  category: string;
  check_question: string;
  guidance: string;
  source_title: string;
  source_url: string;
  keywords: string;
  source_type?: string;
}

interface Finding {
  category: string;
  title: string;
  observation: string;
  status: Status;
  risk_level: Risk;
  confidence: number;
  check_id: string | null;
  source_title: string | null;
  source_url: string | null;
  source_type?: string | null;
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
          "Content-Type, X-Vectorize-Seed-Key",
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
    ).padStart(
      2,
      "0"
    );

  const day =
    String(
      d.getUTCDate()
    ).padStart(
      2,
      "0"
    );

  const random =
    crypto
      .randomUUID()
      .replace(
        /-/g,
        ""
      )
      .substring(
        0,
        6
      )
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
    String(
      value || ""
    )
      .toLowerCase()
      .split(";")[0]
      .trim();

  if (
    type ===
    "image/png"
  ) {
    return "image/png";
  }

  if (
    type ===
    "image/webp"
  ) {
    return "image/webp";
  }

  if (
    type ===
    "image/gif"
  ) {
    return "image/gif";
  }

  if (
    type ===
    "image/heic"
  ) {
    return "image/heic";
  }

  if (
    type ===
    "image/heif"
  ) {
    return "image/heif";
  }

  return "image/jpeg";
}

function extension(
  contentType: string
): string {

  switch (
    contentType
  ) {

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
      .substring(
        0,
        150
      );

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
    new Uint8Array(
      buffer
    );

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

  return btoa(
    binary
  );
}

function imageDataUrl(
  bytes: ArrayBuffer,
  contentType: string
): string {

  return (
    `data:${contentType};base64,` +
    arrayBufferToBase64(
      bytes
    )
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
      File | null = null;

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
        const [, value]
        of form.entries()
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

    if (
      !bytes.byteLength
    ) {

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
      atob(
        base64
      );

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

  if (
    !bytes.byteLength
  ) {

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
    (
      result.results ||
      []
    ).map(
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
    Object.entries(
      values
    ).filter(
      ([column]) =>
        columns.has(
          column
        )
    );

  if (
    !selected.length
  ) {

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
      "forklift"
    )
  ) {
    return "Forklift Safety";
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
      "machinery"
    ) ||
    lower.includes(
      "machine"
    )
  ) {
    return "Machinery Safety";
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
    )
  ) {
    return "Hot Work";
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
      "risk assessment"
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

  const hasSourceType =
    columns.has(
      "source_type"
    );

  const sourceTypeSQL =
    hasSourceType
      ? ", source_type"
      : "";

  const result =
    await env.SAFETY_DB
      .prepare(
        `
        SELECT
          id,
          category,
          check_question,
          guidance,
          source_title,
          source_url,
          keywords
          ${sourceTypeSQL}
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
   NEGATIVE VISIBILITY FILTER
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

    "no visible forklift",
    "no visible reach stacker",
    "no visible machinery",
    "no visible chemical",
    "no visible manual handling",
    "no visible hot work",
    "no visible noise",
  ];

  return patterns.some(
    pattern =>
      text.includes(
        pattern
      )
  );
}

/* =========================================================
   EMBEDDINGS
   ========================================================= */

async function createEmbedding(
  env: Env,
  text: string
): Promise<number[]> {

  const input =
    clean(
      text,
      4000
    );

  if (!input) {

    throw new Error(
      "Cannot create embedding from empty text."
    );
  }

  let response: any;

  try {

    response =
      await env.AI.run(
        EMBEDDING_MODEL,
        {
          text: [
            input,
          ],
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
    response?.data?.[0] ||
    response?.result?.[0] ||
    response?.data ||
    response?.result;

  if (
    !Array.isArray(
      vector
    )
  ) {

    throw new Error(
      `Embedding model returned an invalid vector: ${JSON.stringify(
        response
      ).substring(
        0,
        2000
      )}`
    );
  }

  if (
    vector.length !==
    VECTORIZE_DIMENSIONS
  ) {

    throw new Error(
      `Embedding dimensions are ${vector.length}, expected ${VECTORIZE_DIMENSIONS}.`
    );
  }

  return vector.map(
    Number
  );
}

/* =========================================================
   VECTORIZE SEED
   ========================================================= */

async function seedVectorize(
  env: Env
): Promise<Response> {

  const checks =
    await loadSafetyChecks(
      env
    );

  if (
    checks.length === 0
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

  const vectors: any[] =
    [];

  for (
    const check of checks
  ) {

    const text =
      [
        check.category,
        check.check_question,
        check.guidance,
        check.keywords,
        check.source_title,
      ]
        .filter(Boolean)
        .join(
          ". "
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

        check_question:
          check.check_question,

        guidance:
          check.guidance,

        source_title:
          check.source_title,

        source_url:
          check.source_url,

        keywords:
          check.keywords,

        source_type:
          check.source_type ||
          "WSHC_DERIVED",
      },
    });
  }

  try {

    const result =
      await (
        env.VECTORIZE as any
      ).upsert(
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
        VECTORIZE_DIMENSIONS,

      indexed:
        vectors.length,

      ids:
        vectors.map(
          vector =>
            vector.id
        ),

      mutation:
        result || null,
    });

  } catch (error) {

    throw new Error(
      `Vectorize upsert failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }
}

/* =========================================================
   VECTORIZE SEARCH
   ========================================================= */

async function vectorSearch(
  env: Env,
  text: string
): Promise<string[]> {

  const vector =
    await createEmbedding(
      env,
      text
    );

  try {

    const result =
      await (
        env.VECTORIZE as any
      ).query(
        vector,
        {
          topK:
            MAX_VECTOR_CHECKS,

          returnMetadata:
            "all",
        }
      );

    const matches =
      result?.matches ||
      [];

    return matches
      .filter(
        (match: any) =>
          typeof match?.id ===
            "string" &&
          Number(
            match?.score
          ) >=
            VECTOR_MATCH_THRESHOLD
      )
      .map(
        (match: any) =>
          String(
            match.id
          )
      )
      .slice(
        0,
        MAX_VECTOR_CHECKS
      );

  } catch (error) {

    throw new Error(
      `Vectorize search failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }
}

/* =========================================================
   FIND RELEVANT CHECKS
   ========================================================= */

async function findRelevantChecks(
  env: Env,
  scene: SceneAnalysis,
  allChecks: SafetyCheck[]
): Promise<SafetyCheck[]> {

  const selected =
    new Map<
      string,
      SafetyCheck
    >();

  /*
   * Search each positive visible object.
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
          ". "
        );

    try {

      const ids =
        await vectorSearch(
          env,
          query
        );

      for (
        const id of ids
      ) {

        const check =
          allChecks.find(
            candidate =>
              candidate.id ===
              id
          );

        if (
          check
        ) {

          selected.set(
            check.id,
            check
          );
        }
      }

    } catch {
      /*
       * Vectorize failure should not
       * destroy the inspection.
       *
       * Fall back to category matching.
       */

      const category =
        normalizeCategory(
          item.category
        );

      for (
        const check
        of allChecks
      ) {

        if (
          normalizeCategory(
            check.category
          ).toLowerCase() ===
          category.toLowerCase()
        ) {

          selected.set(
            check.id,
            check
          );
        }
      }
    }
  }

  /*
   * Category fallback if Vectorize
   * returned no matches.
   */

  if (
    selected.size === 0
  ) {

    for (
      const item of
        scene.visible_items
    ) {

      const category =
        normalizeCategory(
          item.category
        );

      for (
        const check
        of allChecks
      ) {

        if (
          normalizeCategory(
            check.category
          ).toLowerCase() ===
          category.toLowerCase()
        ) {

          selected.set(
            check.id,
            check
          );
        }
      }
    }
  }

  return Array.from(
    selected.values()
  ).slice(
    0,
    MAX_VECTOR_CHECKS
  );
}

/* =========================================================
   SCENE ANALYSIS PROMPT
   ========================================================= */

function buildScenePrompt(): string {

  return `
You are the visual scene identification stage of a Singapore workplace safety inspection system.

Analyse ONLY what is visibly supported by the photograph.

Identify positive visible safety-relevant objects, equipment, people and activities.

DO NOT create negative findings.

DO NOT write:
"No visible forklift"
"No visible lifting equipment"
"No visible fire equipment"
"No visible electrical equipment"
"No visible chemical container"

Simply omit things that are not visible.

Relevant categories include:

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
Slips, Trips and Falls
Other

Pay particular attention to:

- hard hats
- high visibility vests
- ladders
- access platforms
- guardrails
- forklifts
- reach stackers
- container handlers
- vehicles
- lifting equipment
- lifting slings
- gas cylinders
- welding
- electrical equipment
- machinery
- spills
- obstructions
- damaged equipment
- unsafe access
- storage
- stacking

Return JSON if possible:

{
  "scene_summary": "short description",
  "visible_items": [
    {
      "item": "Ladder",
      "category": "Work at Height",
      "confidence": 0.95,
      "visible_details": "Metal ladder positioned beside the worker."
    }
  ]
}

If JSON cannot be produced, return a normal text description containing ONLY positive visible observations.
`.trim();
}

/* =========================================================
   SCENE ANALYSIS
   ========================================================= */

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
                "You are a careful workplace safety visual scene analysis assistant. Only report positive visible evidence.",
            },

            {
              role: "user",

              content:
                buildScenePrompt(),
            },
          ],

          image,

          max_tokens:
            900,

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
          : typeof response?.output_text ===
              "string"
            ? response.output_text
            : "";

  if (
    !raw.trim()
  ) {

    throw new Error(
      `Scene analysis returned no text. Response: ${JSON.stringify(
        response
      ).substring(
        0,
        3000
      )}`
    );
  }

  /*
   * First try JSON.
   */

  let parsed:
    any = null;

  try {

    let jsonText =
      raw.trim();

    jsonText =
      jsonText
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
        .trim();

    parsed =
      JSON.parse(
        jsonText
      );

  } catch {

    parsed =
      null;
  }

  /*
   * JSON succeeded.
   */

  if (
    parsed &&
    Array.isArray(
      parsed.visible_items
    )
  ) {

    const items:
      SceneItem[] =
      parsed.visible_items
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
          (item: SceneItem) =>
            item.item
        )
        .filter(
          (item: SceneItem) =>
            !isNegativeVisibilityFinding(
              item.category,
              item.item,
              item.visible_details
            )
        )
        .slice(
          0,
          MAX_SCENE_ITEMS
        );

    return {

      scene_summary:
        clean(
          parsed.scene_summary,
          1000
        ),

      visible_items:
        items,
    };
  }

  /*
   * JSON failed.
   *
   * Use tolerant text fallback.
   */

  return parseSceneTextFallback(
    raw
  );
}

/* =========================================================
   SCENE TEXT FALLBACK
   ========================================================= */

function parseSceneTextFallback(
  raw: string
): SceneAnalysis {

  const text =
    raw
      .replace(
        /\r/g,
        ""
      )
      .trim();

  const items:
    SceneItem[] = [];

  function addItem(
    item: string,
    category: string,
    confidence: number,
    details: string
  ) {

    const exists =
      items.some(
        existing =>
          existing.item
            .toLowerCase() ===
          item.toLowerCase()
      );

    if (
      exists
    ) {
      return;
    }

    items.push({

      item,

      category:
        normalizeCategory(
          category
        ),

      confidence,

      visible_details:
        clean(
          details,
          500
        ),
    });
  }

  /*
   * PPE
   */

  if (
    /\bhard hat\b|\bsafety helmet\b|\bhelmet\b/i
      .test(text)
  ) {

    addItem(
      "Hard hat",
      "PPE",
      0.90,
      "A hard hat is visibly worn by the worker."
    );
  }

  if (
    /\bhigh[- ]visibility vest\b|\bhi[- ]vis vest\b|\bhigh visibility\b/i
      .test(text)
  ) {

    addItem(
      "High-visibility vest",
      "PPE",
      0.90,
      "A high-visibility vest is visibly worn by the worker."
    );
  }

  if (
    /\bsafety shoes\b|\bsafety boots\b/i
      .test(text)
  ) {

    addItem(
      "Safety footwear",
      "PPE",
      0.75,
      "Safety footwear is described as visible."
    );
  }

  if (
    /\bgloves\b/i
      .test(text)
  ) {

    addItem(
      "Protective gloves",
      "PPE",
      0.75,
      "Protective gloves are described as visible."
    );
  }

  /*
   * Work at Height
   */

  if (
    /\bladder\b/i
      .test(text)
  ) {

    addItem(
      "Ladder",
      "Work at Height",
      0.95,
      "A ladder is visibly present."
    );
  }

  if (
    /\bmobile access platform\b|\baccess platform\b|\bworking platform\b/i
      .test(text)
  ) {

    addItem(
      "Access platform",
      "Work at Height",
      0.90,
      "An access or working platform is visibly present."
    );
  }

  if (
    /\bguardrail\b|\bguard rail\b|\bhandrail\b/i
      .test(text)
  ) {

    addItem(
      "Guardrail / handrail",
      "Work at Height",
      0.85,
      "A guardrail or handrail is visibly present."
    );
  }

  /*
   * Reach stacker
   */

  if (
    /\breach stacker\b/i
      .test(text)
  ) {

    addItem(
      "Reach stacker",
      "Reach Stacker Safety",
      0.95,
      "A reach stacker is visibly present."
    );
  }

  /*
   * Forklift
   */

  if (
    /\bforklift\b/i
      .test(text)
  ) {

    addItem(
      "Forklift",
      "Forklift Safety",
      0.95,
      "A forklift is visibly present."
    );
  }

  /*
   * Lifting
   */

  if (
    /\blifting equipment\b|\bcrane\b|\bsling\b|\bchain sling\b|\bhook\b|\bshackle\b/i
      .test(text)
  ) {

    addItem(
      "Lifting equipment",
      "Lifting",
      0.85,
      "Lifting equipment is described as visible."
    );
  }

  /*
   * Hot work
   */

  if (
    /\bwelding\b|\bwelding equipment\b|\bcutting equipment\b|\bhot work\b/i
      .test(text)
  ) {

    addItem(
      "Hot work equipment/activity",
      "Hot Work",
      0.90,
      "Hot work or associated equipment is visibly described."
    );
  }

  /*
   * Chemical / gas cylinder
   */

  if (
    /\bgas cylinder\b|\bgas bottle\b/i
      .test(text)
  ) {

    addItem(
      "Gas cylinder",
      "Chemical Safety",
      0.85,
      "A gas cylinder is described as visible."
    );
  }

  /*
   * Electrical
   */

  if (
    /\belectrical equipment\b|\belectrical cable\b|\belectrical panel\b|\bpower cable\b/i
      .test(text)
  ) {

    addItem(
      "Electrical equipment",
      "Electrical Safety",
      0.80,
      "Electrical equipment is described as visible."
    );
  }

  /*
   * Machinery
   */

  if (
    /\bmachinery\b|\bmachine\b|\bmechanical equipment\b/i
      .test(text)
  ) {

    addItem(
      "Machinery",
      "Machinery Safety",
      0.75,
      "Machinery is described as visible."
    );
  }

  /*
   * Vehicles
   */

  if (
    /\btruck\b|\bvehicle\b|\blorry\b|\bprime mover\b/i
      .test(text)
  ) {

    addItem(
      "Vehicle",
      "Vehicular Safety",
      0.80,
      "A vehicle is described as visible."
    );
  }

  /*
   * Housekeeping
   */

  if (
    /\bspill\b|\boil spill\b|\bslippery\b|\bclutter\b|\bobstruction\b|\btrip hazard\b/i
      .test(text)
  ) {

    addItem(
      "Potential housekeeping condition",
      "Housekeeping",
      0.75,
      "A potential housekeeping-related condition is described."
    );
  }

  /*
   * Summary
   */

  let summary =
    text
      .split("\n")
      .find(
        line => {

          const lower =
            line.toLowerCase();

          return (
            lower.includes(
              "the image"
            ) ||
            lower.includes(
              "the photo"
            )
          );
        }
      ) ||
    "";

  summary =
    clean(
      summary,
      1000
    );

  if (
    !summary
  ) {

    const firstSentence =
      text.match(
        /^(.{20,500}?)(?:\.|\n)/
      );

    summary =
      clean(
        firstSentence?.[1] ||
          "Safety-relevant objects were identified from the photograph.",
        1000
      );
  }

  return {

    scene_summary:
      summary,

    visible_items:
      items
        .slice(
          0,
          MAX_SCENE_ITEMS
        ),
  };
}

/* =========================================================
   ASSESSMENT PROMPT
   ========================================================= */

function buildAssessmentPrompt(
  scene: SceneAnalysis,
  checks: SafetyCheck[]
): string {

  const visible =
    scene.visible_items
      .map(
        item =>
          `
VISIBLE ITEM:
Category: ${item.category}
Item: ${item.item}
Confidence: ${Math.round(
            item.confidence * 100
          )}%
Details: ${item.visible_details}
`
      )
      .join("\n");

  const available =
    checks
      .map(
        check =>
          `
CHECK ID: ${check.id}
CATEGORY: ${check.category}
QUESTION: ${clean(
            check.check_question,
            500
          )}
GUIDANCE: ${clean(
            check.guidance,
            700
          )}
KEYWORDS: ${clean(
            check.keywords,
            300
          )}
SOURCE TYPE: ${clean(
            check.source_type ||
              "WSHC_DERIVED",
            100
          )}
SOURCE: ${clean(
            check.source_title,
            300
          )}
URL: ${clean(
            check.source_url,
            600
          )}
`
      )
      .join("\n");

  return `
You are a workplace safety inspection assistant for a Singapore container depot and container repair yard.

Assess ONLY the safety conditions that are actually visible in the photograph.

Do not invent hazards.

Do not assess categories that are not represented by visible evidence.

The scene analysis has identified:

${visible}

Use the following WSH safety checks because they are relevant to the visible scene:

${available}

IMPORTANT:

Do not create negative findings.

Never return:
"No visible forklift"
"No visible lifting"
"No visible electrical equipment"
"No visible fire equipment"
"No visible chemical"
"No visible storage"
"No visible work at height"

If something is not visible, omit it.

PASS:
The visible condition appears satisfactory.

FAIL:
A visible unsafe condition is identified.

CHECK_REQUIRED:
A relevant safety condition is visible, but the photograph does not provide enough evidence to determine compliance.

For example, if a ladder is visible but the image cannot confirm its stability, condition, footing or safe use, use CHECK_REQUIRED rather than PASS.

Risk:

LOW:
Satisfactory or minor concern.

MEDIUM:
Potential safety concern requiring attention or verification.

HIGH:
Serious visible safety concern.

Confidence:
Use a number between 0 and 1.

Return ONLY findings.

Use exactly:

**PPE**

* **Title:** Visible PPE appears appropriate
* **Observation:** The worker is visibly wearing a hard hat and high-visibility vest.
* **Status:** PASS
* **Risk:** LOW
* **Confidence:** 0.88
* **Check ID:** ppe-001

For a ladder example:

**Work at Height**

* **Title:** Ladder requires verification
* **Observation:** A ladder is visible beside the worker, but the photograph does not provide enough evidence to confirm its stability and safe condition.
* **Status:** CHECK_REQUIRED
* **Risk:** MEDIUM
* **Confidence:** 0.88
* **Check ID:** work-height-001

Do not include explanations before or after the findings.
`.trim();
}

/* =========================================================
   RUN FINAL AI ASSESSMENT
   ========================================================= */

async function runAssessmentAI(
  env: Env,
  photo: PhotoInput,
  scene: SceneAnalysis,
  checks: SafetyCheck[]
): Promise<{
  raw: string;
  result: any;
}> {

  if (
    checks.length === 0
  ) {

    return {
      raw: "",
      result: null,
    };
  }

  const image =
    imageDataUrl(
      photo.bytes,
      photo.contentType
    );

  const prompt =
    buildAssessmentPrompt(
      scene,
      checks
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
                "You are a careful Singapore workplace safety inspection assistant. Only report visible evidence and only use the supplied relevant safety checks.",
            },

            {
              role: "user",

              content:
                prompt,
            },
          ],

          image,

          max_tokens:
            1000,

          temperature:
            0.05,

          top_p:
            0.8,
        } as any
      );

  } catch (error) {

    throw new Error(
      `Workers AI assessment failed: ${
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

  if (
    !raw.trim()
  ) {

    throw new Error(
      `Workers AI returned no assessment text. Response: ${JSON.stringify(
        response
      ).substring(
        0,
        3000
      )}`
    );
  }

  return {

    raw:
      raw.trim(),

    result:
      response,
  };
}

/* =========================================================
   CONFIDENCE
   ========================================================= */

function parseConfidence(
  value: string
): number {

  if (!value) {
    return 0.6;
  }

  const match =
    value.match(
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
    !Number.isFinite(
      number
    )
  ) {
    return 0.6;
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
   STATUS / RISK
   ========================================================= */

function normalizeStatus(
  value: string,
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
  value: string,
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
   AI RESULT PARSER
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

  const results:
    Array<{
      category: string;
      title: string;
      observation: string;
      status: Status;
      risk: Risk;
      confidence: number;
      checkId: string;
    }> = [];

  const text =
    raw
      .replace(
        /\r/g,
        ""
      )
      .trim();

  const headingRegex =
    /(?:^|\n)\s*\*\*([^*\n]+)\*\*\s*(?=\n)/g;

  const headings:
    Array<{
      index: number;
      category: string;
    }> = [];

  let match:
    RegExpExecArray | null;

  while (
    (
      match =
        headingRegex.exec(
          text
        )
    ) !== null
  ) {

    const category =
      cleanMarkdown(
        match[1]
      );

    if (
      category &&
      ![
        "Title",
        "Observation",
        "Status",
        "Risk",
        "Confidence",
        "Check ID",
        "Category",
      ].includes(
        category
      )
    ) {

      headings.push({

        index:
          match.index,

        category,
      });
    }
  }

  for (
    let i = 0;
    i < headings.length;
    i++
  ) {

    const start =
      headings[i]
        .index;

    const end =
      i + 1 <
      headings.length
        ? headings[
            i + 1
          ].index
        : text.length;

    const body =
      text.substring(
        start,
        end
      );

    const titleMatch =
      body.match(
        /(?:^|\n)\s*(?:\*\s*)?\*\*Title:\*\*\s*(.+?)(?=\n|$)/i
      );

    const observationMatch =
      body.match(
        /(?:^|\n)\s*(?:\*\s*)?\*\*Observation:\*\*\s*(.+?)(?=\n|$)/i
      );

    const statusMatch =
      body.match(
        /(?:^|\n)\s*(?:\*\s*)?\*\*Status:\*\*\s*(PASS|FAIL|CHECK_REQUIRED)/i
      );

    const riskMatch =
      body.match(
        /(?:^|\n)\s*(?:\*\s*)?\*\*Risk:\*\*\s*(LOW|MEDIUM|HIGH)/i
      );

    const confidenceMatch =
      body.match(
        /(?:^|\n)\s*(?:\*\s*)?\*\*Confidence:\*\*\s*([0-9.]+)/i
      );

    const checkIdMatch =
      body.match(
        /(?:^|\n)\s*(?:\*\s*)?\*\*Check ID:\*\*\s*([^\s\n]+)/i
      );

    const category =
      normalizeCategory(
        headings[i]
          .category
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

    if (
      isNegativeVisibilityFinding(
        category,
        title,
        observation
      )
    ) {
      continue;
    }

    const status =
      normalizeStatus(
        statusMatch?.[1] ||
          "",
        observation
      );

    const risk =
      normalizeRisk(
        riskMatch?.[1] ||
          "",
        status
      );

    const confidence =
      parseConfidence(
        confidenceMatch?.[1] ||
          ""
      );

    const checkId =
      cleanMarkdown(
        checkIdMatch?.[1] ||
          ""
      );

    results.push({

      category,

      title,

      observation,

      status,

      risk,

      confidence,

      checkId,
    });

    if (
      results.length >=
      MAX_FINDINGS
    ) {
      break;
    }
  }

  /*
   * Legacy fallback.
   */

  if (
    results.length ===
    0
  ) {

    return parseLegacyAIResponse(
      raw
    );
  }

  return results;
}

/* =========================================================
   LEGACY PARSER
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

  const results:
    Array<{
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

    if (
      !block.trim()
    ) {
      continue;
    }

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

    if (
      isNegativeVisibilityFinding(
        category,
        title,
        observation
      )
    ) {
      continue;
    }

    const status =
      normalizeStatus(
        statusMatch?.[1] ||
          "",
        observation
      );

    results.push({

      category,

      title,

      observation,

      status,

      risk:
        normalizeRisk(
          riskMatch?.[1] ||
            "",
          status
        ),

      confidence:
        parseConfidence(
          confidenceMatch?.[1] ||
            ""
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
   CHECK MATCHING
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

  /*
   * Exact ID.
   */

  if (
    finding.checkId
  ) {

    const exact =
      checks.find(
        check =>
          check.id ===
          finding.checkId
      );

    if (
      exact
    ) {
      return exact;
    }
  }

  /*
   * Exact category.
   */

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

  /*
   * Keyword matching.
   */

  const combined =
    `${category} ${finding.title} ${finding.observation}`
      .toLowerCase();

  let best:
    SafetyCheck | null =
    null;

  let bestScore =
    0;

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
            word.length >=
            3
        );

    let score =
      0;

    for (
      const keyword
      of keywords
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
  checks: SafetyCheck[]
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
      seen.has(
        key
      )
    ) {
      continue;
    }

    seen.add(
      key
    );

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

    /*
     * Only attach a foreign key if
     * the safety_check really exists.
     *
     * This prevents:
     *
     * FOREIGN KEY constraint failed
     */

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

      source_title:
        check?.source_title ||
        null,

      source_url:
        check?.source_url ||
        null,

      source_type:
        check?.source_type ||
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

    return (
      "No visible safety conditions were identified from the photograph."
    );
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

          /*
           * IMPORTANT:
           * null is used if the check
           * does not exist.
           */

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
   R2 UPLOAD
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
     * 1. Parse image.
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
     * 2. IDs.
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
     * 3. R2 key.
     */

    stage =
      "generate R2 object key";

    objectKey =
      `inspections/${inspectionId}/${photoId}.${extension(
        photo.contentType
      )}`;

    /*
     * 4. Create inspection.
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
     * 5. Upload photo.
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
     * 6. Save photo record.
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
     * 7. Load all WSH checks.
     */

    stage =
      "D1 load safety checks";

    const allChecks =
      await loadSafetyChecks(
        env
      );

    /*
     * 8. Scene analysis.
     *
     * This is the important fix.
     *
     * If Vision returns prose instead
     * of JSON, parseSceneTextFallback()
     * handles it.
     */

    stage =
      "scene analysis";

    const scene =
      await runSceneAnalysis(
        env,
        photo
      );

    /*
     * 9. Vectorize search.
     */

    stage =
      "Vectorize relevance search";

    const relevantChecks =
      await findRelevantChecks(
        env,
        scene,
        allChecks
      );

    /*
     * 10. Final safety assessment.
     */

    stage =
      "final safety assessment";

    const ai =
      await runAssessmentAI(
        env,
        photo,
        scene,
        relevantChecks
      );

    /*
     * 11. Parse findings.
     */

    stage =
      "parse AI response";

    const parsed =
      parseAIResponse(
        ai.raw
      );

    /*
     * 12. Match checks.
     */

    stage =
      "match WSH checks";

    const findings =
      normalizeFindings(
        parsed,
        allChecks
      );

    /*
     * 13. Save findings.
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
     * 14. Overall result.
     */

    stage =
      "calculate overall result";

    const result =
      overall(
        findings
      );

    /*
     * 15. Update inspection.
     */

    stage =
      "D1 update inspection";

    await updateInspection(
      env,
      inspectionId,
      result
    );

    /*
     * 16. Return.
     */

    return jsonResponse({

      ok:
        true,

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

        embedding_model:
          EMBEDDING_MODEL,

        match_threshold:
          VECTOR_MATCH_THRESHOLD,

        relevant_checks:
          relevantChecks.map(
            check => ({
              id:
                check.id,

              category:
                check.category,

              source_title:
                check.source_title,

              source_type:
                check.source_type ||
                "WSHC_DERIVED",
            })
          ),
      },

      ai: {

        model:
          VISION_MODEL,

        response_length:
          ai.raw.length,

        response_preview:
          ai.raw.substring(
            0,
            3000
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
     * Remove R2 object if the analysis failed.
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
        // Ignore cleanup failure.
      }
    }

    /*
     * Keep inspection record but
     * mark it CHECK_REQUIRED.
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
        .join(
          "\n"
        );

    return jsonResponse(
      {
        ok:
          false,

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
          ok:
            false,

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

      ok:
        true,

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
        ok:
          false,

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

      ok:
        true,

      inspections:
        result.results ||
        [],
    });

  } catch (error) {

    return jsonResponse(
      {
        ok:
          false,

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

      ok:
        true,

      count:
        checks.length,

      checks,
    });

  } catch (error) {

    return jsonResponse(
      {
        ok:
          false,

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

    if (
      !object
    ) {

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
        status:
          200,

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
      VECTORIZE_DIMENSIONS,

    vector_match_threshold:
      VECTOR_MATCH_THRESHOLD,

    timestamp:
      nowISO(),
  });
}

/* =========================================================
   VECTORIZE SEED API
   ========================================================= */

async function vectorizeSeed(
  request: Request,
  env: Env
): Promise<Response> {

  /*
   * Secret must be configured in
   * Worker Variables and Secrets.
   */

  if (
    !env.VECTORIZE_SEED_KEY
  ) {

    return jsonResponse(
      {
        ok:
          false,

        error:
          "VECTORIZE_SEED_KEY is not configured. Create this Worker secret before running the seed operation.",
      },
      500
    );
  }

  const suppliedKey =
    request.headers.get(
      "X-Vectorize-Seed-Key"
    );

  if (
    !suppliedKey ||
    suppliedKey !==
      env.VECTORIZE_SEED_KEY
  ) {

    return jsonResponse(
      {
        ok:
          false,

        error:
          "Invalid Vectorize seed key.",
      },
      401
    );
  }

  try {

    return await seedVectorize(
      env
    );

  } catch (error) {

    return jsonResponse(
      {
        ok:
          false,

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

    if (
      !id
    ) {

      return jsonResponse(
        {
          ok:
            false,

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

    if (
      !key
    ) {

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
      ok:
        false,

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
       * CORS preflight.
       */

      if (
        request.method ===
        "OPTIONS"
      ) {

        return new Response(
          null,
          {

            status:
              204,

            headers: {

              "Access-Control-Allow-Origin":
                "*",

              "Access-Control-Allow-Methods":
                "GET, POST, OPTIONS",

              "Access-Control-Allow-Headers":
                "Content-Type, X-Vectorize-Seed-Key",

              "Access-Control-Max-Age":
                "86400",
            },
          }
        );
      }

      const url =
        new URL(
          request.url
        );

      /*
       * API.
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
       * Static assets.
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

          status:
            200,

          headers: {

            "Content-Type":
              "text/plain; charset=utf-8",
          },
        }
      );

    } catch (error) {

      return jsonResponse(
        {

          ok:
            false,

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
