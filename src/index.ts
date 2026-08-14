export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
  VECTORIZE: VectorizeIndex;
  ASSETS: Fetcher;

  /*
   * Worker secret used only by:
   *
   * POST /api/vectorize/seed
   */
  VECTORIZE_SEED_KEY?: string;
}

const MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const EMBEDDING_MODEL =
  "@cf/baai/bge-base-en-v1.5";

const VECTOR_INDEX =
  "safety-checks";

const VECTOR_MATCH_THRESHOLD =
  0.45;

const MAX_IMAGE_SIZE =
  12 * 1024 * 1024;

const MAX_FINDINGS = 8;

const MAX_RETRIEVED_CHECKS = 8;

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
  check_question: string;
  guidance: string;
  source_title: string;
  source_url: string;
  keywords: string;
  source_type?: string;
  active?: number;
}

interface Finding {
  category: string;
  title: string;
  observation: string;
  evidence: string;
  status: Status;
  risk_level: Risk;
  confidence: number;
  check_id: string | null;
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

interface SceneAnalysis {
  scene_summary: string;
  visible_objects: string[];
  visible_activities: string[];
  visible_hazards: string[];
  visible_controls: string[];
  people_visible: boolean;
  vehicles_visible: boolean;
  machinery_visible: boolean;
  lifting_visible: boolean;
  hot_work_visible: boolean;
  electrical_visible: boolean;
  chemicals_visible: boolean;
  cylinders_visible: boolean;
  elevated_work_visible: boolean;
  storage_visible: boolean;
  relevant_categories: string[];
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
        const [, value] of form.entries()
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
        ) ||
        "Unspecified",

      inspector:
        clean(
          form.get("inspector"),
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

  const sourceType =
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
          ${sourceType}
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

function defaultScene(): SceneAnalysis {
  return {
    scene_summary:
      "",

    visible_objects:
      [],

    visible_activities:
      [],

    visible_hazards:
      [],

    visible_controls:
      [],

    people_visible:
      false,

    vehicles_visible:
      false,

    machinery_visible:
      false,

    lifting_visible:
      false,

    hot_work_visible:
      false,

    electrical_visible:
      false,

    chemicals_visible:
      false,

    cylinders_visible:
      false,

    elevated_work_visible:
      false,

    storage_visible:
      false,

    relevant_categories:
      [],
  };
}

function extractJsonObject(
  raw: string
): any | null {
  let text =
    clean(
      raw,
      10000
    );

  text =
    text
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

  try {
    return JSON.parse(
      text
    );
  } catch {
    // Continue.
  }

  const first =
    text.indexOf("{");

  const last =
    text.lastIndexOf("}");

  if (
    first < 0 ||
    last <= first
  ) {
    return null;
  }

  try {
    return JSON.parse(
      text.substring(
        first,
        last + 1
      )
    );
  } catch {
    return null;
  }
}

function booleanValue(
  value: unknown
): boolean {
  if (
    value === true
  ) {
    return true;
  }

  const text =
    String(value || "")
      .toLowerCase()
      .trim();

  return (
    text === "true" ||
    text === "yes" ||
    text === "1"
  );
}

function stringArray(
  value: unknown,
  max = 20
): string[] {
  if (
    !Array.isArray(value)
  ) {
    return [];
  }

  return value
    .map(
      item =>
        clean(
          item,
          200
        )
    )
    .filter(Boolean)
    .slice(0, max);
}

function normalizeScene(
  value: any
): SceneAnalysis {
  const fallback =
    defaultScene();

  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return fallback;
  }

  return {
    scene_summary:
      clean(
        value.scene_summary,
        1200
      ),

    visible_objects:
      stringArray(
        value.visible_objects
      ),

    visible_activities:
      stringArray(
        value.visible_activities
      ),

    visible_hazards:
      stringArray(
        value.visible_hazards
      ),

    visible_controls:
      stringArray(
        value.visible_controls
      ),

    people_visible:
      booleanValue(
        value.people_visible
      ),

    vehicles_visible:
      booleanValue(
        value.vehicles_visible
      ),

    machinery_visible:
      booleanValue(
        value.machinery_visible
      ),

    lifting_visible:
      booleanValue(
        value.lifting_visible
      ),

    hot_work_visible:
      booleanValue(
        value.hot_work_visible
      ),

    electrical_visible:
      booleanValue(
        value.electrical_visible
      ),

    chemicals_visible:
      booleanValue(
        value.chemicals_visible
      ),

    cylinders_visible:
      booleanValue(
        value.cylinders_visible
      ),

    elevated_work_visible:
      booleanValue(
        value.elevated_work_visible
      ),

    storage_visible:
      booleanValue(
        value.storage_visible
      ),

    relevant_categories:
      stringArray(
        value.relevant_categories
      ),
  };
}

async function analyzeScene(
  env: Env,
  image: ArrayBuffer,
  contentType: string
): Promise<{
  scene: SceneAnalysis;
  raw: string;
}> {
  const imageData =
    imageDataUrl(
      image,
      contentType
    );

  const prompt = `
Analyse this workplace photograph BEFORE performing a safety inspection.

This is a Singapore shipping/container depot and container repair yard.

Identify ONLY things that are visibly supported by the photograph.

Do not guess.

Do not infer hidden activities.

Do not assume a worker exists if no worker is visible.

Do not assume lifting, hot work, electrical work, confined-space work or work-at-height simply because the location is a depot.

Return ONLY valid JSON.

Use exactly:

{
  "scene_summary": "short factual description",
  "visible_objects": [],
  "visible_activities": [],
  "visible_hazards": [],
  "visible_controls": [],
  "people_visible": false,
  "vehicles_visible": false,
  "machinery_visible": false,
  "lifting_visible": false,
  "hot_work_visible": false,
  "electrical_visible": false,
  "chemicals_visible": false,
  "cylinders_visible": false,
  "elevated_work_visible": false,
  "storage_visible": false,
  "relevant_categories": []
}

Examples of visible objects:

worker
hard hat
high visibility vest
forklift
Hyster forklift
reach stacker
container
oxygen cylinder
gas cylinder cage
welding machine
grinder
electrical cable
fire extinguisher
chemical container
storage rack
ladder
platform
vehicle
truck

Important:

"visible_objects" must contain only objects actually visible.

"visible_activities" must contain only activities actually visible.

"visible_hazards" must contain only hazards actually visible.

"relevant_categories" should contain safety categories that are genuinely relevant to the visible scene.

Do NOT include categories merely because they exist in the safety checklist.
`.trim();

  let response: any;

  try {
    response =
      await env.AI.run(
        MODEL,
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

              content: [
                {
                  type:
                    "text",

                  text:
                    prompt,
                },

                {
                  type:
                    "image",

                  source: {
                    type:
                      "base64",

                    media_type:
                      contentType,

                    data:
                      arrayBufferToBase64(
                        image
                      ),
                  },
                },
              ],
            },
          ],

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
      "Scene analysis returned no text."
    );
  }

  const parsed =
    extractJsonObject(
      raw
    );

  return {
    scene:
      normalizeScene(
        parsed
      ),

    raw:
      raw.trim(),
  };
}

/* =========================================================
   VECTORIZE EMBEDDINGS
   ========================================================= */

async function createEmbedding(
  env: Env,
  text: string
): Promise<number[]> {
  const response: any =
    await env.AI.run(
      EMBEDDING_MODEL,
      {
        text: [
          text.substring(
            0,
            6000
          ),
        ],
      } as any
    );

  const vector =
    response?.data?.[0];

  if (
    !Array.isArray(vector) ||
    vector.length !== 768
  ) {
    throw new Error(
      `Embedding model returned an invalid vector. Expected 768 dimensions, received ${
        Array.isArray(vector)
          ? vector.length
          : 0
      }.`
    );
  }

  return vector.map(
    Number
  );
}

function sceneSearchText(
  scene: SceneAnalysis
): string {
  return [
    `Scene: ${scene.scene_summary}`,

    `Visible objects: ${scene.visible_objects.join(
      ", "
    )}`,

    `Visible activities: ${scene.visible_activities.join(
      ", "
    )}`,

    `Visible hazards: ${scene.visible_hazards.join(
      ", "
    )}`,

    `Visible controls: ${scene.visible_controls.join(
      ", "
    )}`,

    `People visible: ${scene.people_visible}`,

    `Vehicles visible: ${scene.vehicles_visible}`,

    `Machinery visible: ${scene.machinery_visible}`,

    `Lifting visible: ${scene.lifting_visible}`,

    `Hot work visible: ${scene.hot_work_visible}`,

    `Electrical visible: ${scene.electrical_visible}`,

    `Chemicals visible: ${scene.chemicals_visible}`,

    `Cylinders visible: ${scene.cylinders_visible}`,

    `Elevated work visible: ${scene.elevated_work_visible}`,

    `Storage visible: ${scene.storage_visible}`,

    `Relevant categories: ${scene.relevant_categories.join(
      ", "
    )}`,
  ].join("\n");
}

/* =========================================================
   VECTORIZE SEARCH
   ========================================================= */

async function retrieveRelevantChecks(
  env: Env,
  scene: SceneAnalysis
): Promise<RetrievedCheck[]> {
  if (!env.VECTORIZE) {
    throw new Error(
      "VECTORIZE binding is not configured."
    );
  }

  const searchText =
    sceneSearchText(
      scene
    );

  const vector =
    await createEmbedding(
      env,
      searchText
    );

  let result: any;

  try {
    result =
      await (env.VECTORIZE as any)
        .query(
          vector,
          {
            topK:
              MAX_RETRIEVED_CHECKS,

            returnMetadata:
              "all",
          }
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

  const output: RetrievedCheck[] =
    [];

  for (
    const match of matches
  ) {
    const score =
      Number(
        match?.score
      );

    if (
      !Number.isFinite(
        score
      )
    ) {
      continue;
    }

    if (
      score <
      VECTOR_MATCH_THRESHOLD
    ) {
      continue;
    }

    const metadata =
      match?.metadata ||
      {};

    const id =
      clean(
        match?.id ||
          metadata.id,
        200
      );

    if (!id) {
      continue;
    }

    const check: SafetyCheck =
      {
        id,

        category:
          clean(
            metadata.category,
            200
          ),

        check_question:
          clean(
            metadata.check_question,
            1000
          ),

        guidance:
          clean(
            metadata.guidance,
            1500
          ),

        source_title:
          clean(
            metadata.source_title,
            500
          ),

        source_url:
          clean(
            metadata.source_url,
            1000
          ),

        keywords:
          clean(
            metadata.keywords,
            1000
          ),

        source_type:
          clean(
            metadata.source_type,
            100
          ),
      };

    if (
      !check.category ||
      !check.check_question
    ) {
      continue;
    }

    output.push({
      check,
      score:
        Math.round(
          score * 1000
        ) / 1000,
    });
  }

  /*
   * Remove duplicates.
   */

  const seen =
    new Set<string>();

  return output.filter(
    item => {
      if (
        seen.has(
          item.check.id
        )
      ) {
        return false;
      }

      seen.add(
        item.check.id
      );

      return true;
    }
  );
}

/* =========================================================
   CATEGORY VISIBILITY VALIDATION
   ========================================================= */

function sceneText(
  scene: SceneAnalysis
): string {
  return [
    scene.scene_summary,

    ...scene.visible_objects,

    ...scene.visible_activities,

    ...scene.visible_hazards,

    ...scene.visible_controls,

    ...scene.relevant_categories,
  ]
    .join(" ")
    .toLowerCase();
}

function categoryVisible(
  category: string,
  scene: SceneAnalysis
): boolean {
  const c =
    normalizeCategory(
      category
    );

  const text =
    sceneText(
      scene
    );

  switch (c) {
    case "PPE":
      return (
        scene.people_visible ||
        text.includes("worker") ||
        text.includes("ppe") ||
        text.includes("hard hat") ||
        text.includes("helmet") ||
        text.includes(
          "high visibility"
        ) ||
        text.includes(
          "safety vest"
        )
      );

    case "Housekeeping":
      return true;

    case "Vehicular Safety":
      return (
        scene.vehicles_visible ||
        text.includes("vehicle") ||
        text.includes("truck") ||
        text.includes("forklift") ||
        text.includes(
          "reach stacker"
        ) ||
        text.includes("traffic")
      );

    case "Work at Height":
      return (
        scene.elevated_work_visible ||
        text.includes("ladder") ||
        text.includes("platform") ||
        text.includes("elevated") ||
        text.includes("height")
      );

    case "Lifting":
      return (
        scene.lifting_visible ||
        text.includes("lifting") ||
        text.includes(
          "suspended load"
        ) ||
        text.includes("crane") ||
        text.includes("spreader") ||
        text.includes(
          "container lifting"
        )
      );

    case "Electrical Safety":
      return (
        scene.electrical_visible ||
        text.includes("electrical") ||
        text.includes("cable") ||
        text.includes("plug") ||
        text.includes("socket") ||
        text.includes(
          "welding machine"
        )
      );

    case "Fire Safety":
      return (
        scene.hot_work_visible ||
        text.includes("fire") ||
        text.includes(
          "fire extinguisher"
        ) ||
        text.includes(
          "combustible"
        ) ||
        text.includes("flame") ||
        text.includes(
          "spark"
        ) ||
        text.includes(
          "welding"
        ) ||
        text.includes(
          "gas cylinder"
        ) ||
        scene.cylinders_visible
      );

    case "Chemical Safety":
      return (
        scene.chemicals_visible ||
        scene.cylinders_visible ||
        text.includes("chemical") ||
        text.includes("oxygen") ||
        text.includes(
          "gas cylinder"
        ) ||
        text.includes(
          "solvent"
        ) ||
        text.includes("paint") ||
        text.includes(
          "fuel"
        )
      );

    case "Machinery Safety":
      return (
        scene.machinery_visible ||
        text.includes(
          "machine"
        ) ||
        text.includes(
          "grinder"
        ) ||
        text.includes(
          "cutting machine"
        ) ||
        text.includes(
          "power tool"
        ) ||
        text.includes(
          "forklift"
        ) ||
        text.includes(
          "reach stacker"
        )
      );

    case "Forklift Safety":
      return (
        text.includes(
          "forklift"
        ) ||
        text.includes(
          "hyster"
        ) ||
        text.includes(
          "fork truck"
        )
      );

    case "Reach Stacker Safety":
      return (
        text.includes(
          "reach stacker"
        ) ||
        text.includes(
          "container handler"
        ) ||
        text.includes(
          "container stacker"
        ) ||
        text.includes(
          "telescopic"
        )
      );

    case "Hot Work":
      return (
        scene.hot_work_visible ||
        text.includes(
          "welding"
        ) ||
        text.includes(
          "cutting"
        ) ||
        text.includes(
          "grinding"
        ) ||
        text.includes(
          "hot work"
        ) ||
        text.includes(
          "sparks"
        )
      );

    case "Confined Space":
      return (
        text.includes(
          "confined space"
        ) ||
        text.includes(
          "enclosed space"
        ) ||
        text.includes(
          "container interior"
        ) ||
        text.includes(
          "gas testing"
        )
      );

    case "Noise":
      return (
        scene.machinery_visible ||
        text.includes(
          "grinding"
        ) ||
        text.includes(
          "cutting"
        ) ||
        text.includes(
          "impact tool"
        ) ||
        text.includes(
          "noise"
        )
      );

    case "Slips, Trips and Falls":
      return (
        true
      );

    case "Manual Handling":
      return (
        scene.people_visible ||
        text.includes(
          "manual handling"
        ) ||
        text.includes(
          "carrying"
        ) ||
        text.includes(
          "lifting"
        )
      );

    case "Storage and Stacking":
      return (
        scene.storage_visible ||
        text.includes(
          "storage"
        ) ||
        text.includes(
          "stack"
        ) ||
        text.includes(
          "rack"
        ) ||
        text.includes(
          "cage"
        ) ||
        scene.cylinders_visible
      );

    case "Risk Assessment":
      /*
       * Risk assessment is only relevant where
       * a visible work activity exists.
       */
      return (
        scene.visible_activities
          .length > 0 ||
        scene.machinery_visible ||
        scene.vehicles_visible ||
        scene.people_visible ||
        scene.hot_work_visible ||
        scene.lifting_visible
      );

    case "Loading and Unloading":
      return (
        text.includes(
          "loading"
        ) ||
        text.includes(
          "unloading"
        ) ||
        text.includes(
          "cargo"
        ) ||
        text.includes(
          "container"
        ) ||
        text.includes(
          "trailer"
        )
      );

    default:
      return true;
  }
}

/* =========================================================
   AI PROMPT
   ========================================================= */

function buildFinalPrompt(
  scene: SceneAnalysis,
  retrieved: RetrievedCheck[]
): string {
  const checks =
    retrieved
      .map(
        item =>
          `
CHECK ID: ${item.check.id}
VECTOR SCORE: ${item.score}
CATEGORY: ${item.check.category}
QUESTION: ${item.check.check_question}
GUIDANCE: ${item.check.guidance}
SOURCE: ${item.check.source_title}
URL: ${item.check.source_url}
SOURCE TYPE: ${item.check.source_type || "WSHC_DERIVED"}
`
      )
      .join("\n");

  return `
You are a strict workplace safety visual inspection assistant for a Singapore shipping/container depot and container repair yard.

You have already been given a scene analysis produced from the photograph.

SCENE ANALYSIS

${sceneSearchText(scene)}

RETRIEVED WSHC SAFETY CHECKS

${checks}

==================================================
CRITICAL EVIDENCE RULES
==================================================

1. Analyse ONLY what is visibly supported by the photograph.

2. A retrieved safety check does NOT automatically become a finding.

3. Do NOT create a PASS simply because the check exists.

4. Do NOT create a CHECK_REQUIRED simply because the check exists.

5. There must be visible photographic evidence relevant to the category.

6. If there is no visible evidence for a category, OMIT the category.

7. Never invent workers, vehicles, lifting operations, welding, electrical work, confined-space entry, fire equipment, chemicals or hazards.

8. Do NOT report negative observations such as:
"No visible lifting operation"
"No visible work at height"
"No visible electrical equipment"
"No visible fire hazards"
"No visible storage"

9. PASS means the visible condition appears satisfactory.

10. FAIL means a visible unsafe condition is identified.

11. CHECK_REQUIRED means a relevant visible condition exists, but the photograph does not provide enough evidence to determine compliance.

12. Do not use CHECK_REQUIRED for something that is simply absent from the photograph.

13. Confidence must reflect the visible photographic evidence.

14. If a worker is NOT visible, do not create a PPE finding.

15. If lifting is NOT visible, do not create a lifting finding.

16. If a forklift is NOT visible, do not create a forklift finding.

17. If a reach stacker/container handler is NOT visible, do not create a reach stacker finding.

18. If hot work is NOT visible, do not create a hot-work finding.

19. If electrical equipment is NOT visible, do not create an electrical finding.

20. If a confined-space activity is NOT visible, do not create a confined-space finding.

21. If elevated work is NOT visible, do not create a work-at-height finding.

22. Do not use general depot knowledge as photographic evidence.

==================================================
OUTPUT FORMAT
==================================================

Return ONLY findings.

For each relevant visible finding use exactly:

**CATEGORY**

* **Title:** short title
* **Observation:** factual visible observation
* **Evidence:** what is visibly supporting the finding
* **Status:** PASS
* **Risk:** LOW
* **Confidence:** 0.90
* **Check ID:** check-id

Example:

**Storage and Stacking**

* **Title:** Oxygen cylinders stored in secured cage
* **Observation:** Oxygen cylinders are visibly stored inside a metal storage cage.
* **Evidence:** Multiple oxygen cylinders and a metal cylinder cage are clearly visible.
* **Status:** PASS
* **Risk:** LOW
* **Confidence:** 0.91
* **Check ID:** storage-001

Do NOT add an explanation before or after the findings.

If there are no valid visible safety findings, return:

NO_VALID_VISIBLE_FINDINGS
`.trim();
}

/* =========================================================
   FINAL AI
   ========================================================= */

async function runFinalAI(
  env: Env,
  image: ArrayBuffer,
  contentType: string,
  scene: SceneAnalysis,
  retrieved: RetrievedCheck[]
): Promise<{
  raw: string;
  result: any;
}> {
  if (
    retrieved.length === 0
  ) {
    return {
      raw:
        "NO_VALID_VISIBLE_FINDINGS",

      result: null,
    };
  }

  const prompt =
    buildFinalPrompt(
      scene,
      retrieved
    );

  const imageBase64 =
    arrayBufferToBase64(
      image
    );

  let response: any;

  try {
    response =
      await env.AI.run(
        MODEL,
        {
          messages: [
            {
              role:
                "system",

              content:
                "You are a strict evidence-based Singapore workplace safety visual inspection assistant. Never invent objects, people, hazards or activities.",
            },

            {
              role:
                "user",

              content: [
                {
                  type:
                    "text",

                  text:
                    prompt,
                },

                {
                  type:
                    "image",

                  source: {
                    type:
                      "base64",

                    media_type:
                      contentType,

                    data:
                      imageBase64,
                  },
                },
              ],
            },
          ],

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
      `Final Workers AI request failed: ${
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
      "Final Workers AI returned no text."
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
   CONFIDENCE / STATUS / RISK
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
    status ===
    "FAIL"
  ) {
    return "HIGH";
  }

  if (
    status ===
    "PASS"
  ) {
    return "LOW";
  }

  return "MEDIUM";
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

  return negativePatterns.some(
    pattern =>
      text.includes(
        pattern
      )
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
      "storage"
    )
  ) {
    return "Storage and Stacking";
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
    ) ||
    lower.includes(
      "container handler"
    )
  ) {
    return "Reach Stacker Safety";
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
      "machinery"
    ) ||
    lower.includes(
      "machine safety"
    )
  ) {
    return "Machinery Safety";
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
      "noise"
    )
  ) {
    return "Noise";
  }

  if (
    lower.includes(
      "slip"
    ) ||
    lower.includes(
      "trip"
    )
  ) {
    return "Slips, Trips and Falls";
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
      "risk assessment"
    ) ||
    lower ===
      "risk assessment"
  ) {
    return "Risk Assessment";
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

  return value;
}

/* =========================================================
   AI RESPONSE PARSER
   ========================================================= */

function parseAIResponse(
  raw: string
): Array<{
  category: string;
  title: string;
  observation: string;
  evidence: string;
  status: Status;
  risk: Risk;
  confidence: number;
  checkId: string;
}> {
  const results: Array<{
    category: string;
    title: string;
    observation: string;
    evidence: string;
    status: Status;
    risk: Risk;
    confidence: number;
    checkId: string;
  }> = [];

  if (
    raw
      .trim()
      .toUpperCase() ===
    "NO_VALID_VISIBLE_FINDINGS"
  ) {
    return [];
  }

  const text =
    raw
      .replace(
        /\r/g,
        ""
      )
      .trim();

  const headingRegex =
    /(?:^|\n)\s*\*\*([^*\n]+)\*\*\s*(?=\n)/g;

  const headings: Array<{
    index: number;
    category: string;
  }> = [];

  let match:
    RegExpExecArray | null;

  while (
    (match =
      headingRegex.exec(
        text
      )) !== null
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
        "Evidence",
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
      headings[i].index;

    const end =
      i + 1 <
      headings.length
        ? headings[i + 1]
            .index
        : text.length;

    const body =
      text.substring(
        start,
        end
      );

    const category =
      normalizeCategory(
        headings[i].category
      );

    const titleMatch =
      body.match(
        /(?:^|\n)\s*(?:\*\s*)?\*\*Title:\*\*\s*(.+?)(?=\n|$)/i
      );

    const observationMatch =
      body.match(
        /(?:^|\n)\s*(?:\*\s*)?\*\*Observation:\*\*\s*(.+?)(?=\n|$)/i
      );

    const evidenceMatch =
      body.match(
        /(?:^|\n)\s*(?:\*\s*)?\*\*Evidence:\*\*\s*(.+?)(?=\n|$)/i
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

    const evidence =
      cleanMarkdown(
        evidenceMatch?.[1] ||
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

      evidence:
        evidence ||
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

  if (
    results.length === 0
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
  evidence: string;
  status: Status;
  risk: Risk;
  confidence: number;
  checkId: string;
}> {
  const results: Array<{
    category: string;
    title: string;
    observation: string;
    evidence: string;
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

    const evidenceMatch =
      block.match(
        /\*\*Evidence:\*\*\s*(.+?)(?=\n|$)/i
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

    const evidence =
      cleanMarkdown(
        evidenceMatch?.[1] ||
          observation
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
      evidence,
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
    SafetyCheck | null =
      null;

  let bestScore = 0;

  const candidates =
    categoryMatches.length
      ? categoryMatches
      : checks;

  for (
    const check of candidates
  ) {
    const keywordText =
      clean(
        check.keywords,
        1000
      ).toLowerCase();

    const keywords =
      keywordText
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
   FINDING EVIDENCE VALIDATION
   ========================================================= */

function evidenceLooksValid(
  item: {
    category: string;
    title: string;
    observation: string;
    evidence: string;
  },
  scene: SceneAnalysis
): boolean {
  if (
    !item.observation ||
    !item.evidence
  ) {
    return false;
  }

  if (
    isNegativeVisibilityFinding(
      item.category,
      item.title,
      item.observation
    )
  ) {
    return false;
  }

  if (
    !categoryVisible(
      item.category,
      scene
    )
  ) {
    return false;
  }

  /*
   * Prevent obvious hallucination of a worker.
   */

  const combined =
    `${item.title} ${item.observation} ${item.evidence}`
      .toLowerCase();

  const workerClaims = [
    "worker",
    "operator",
    "person",
    "employee",
    "wearing",
    "hard hat",
    "helmet",
    "high-visibility vest",
  ];

  if (
    !scene.people_visible &&
    workerClaims.some(
      word =>
        combined.includes(
          word
        )
    )
  ) {
    return false;
  }

  /*
   * Prevent false lifting findings.
   */

  if (
    !scene.lifting_visible &&
    (
      item.category ===
        "Lifting" ||
      combined.includes(
        "suspended load"
      ) ||
      combined.includes(
        "lifting operation"
      )
    )
  ) {
    return false;
  }

  /*
   * Prevent false forklift findings.
   */

  if (
    !scene.vehicles_visible &&
    (
      item.category ===
        "Forklift Safety" ||
      combined.includes(
        "forklift"
      ) ||
      combined.includes(
        "hyster"
      )
    )
  ) {
    return false;
  }

  /*
   * Prevent false reach-stacker findings.
   */

  if (
    !scene.vehicles_visible &&
    (
      item.category ===
        "Reach Stacker Safety" ||
      combined.includes(
        "reach stacker"
      ) ||
      combined.includes(
        "container handler"
      )
    )
  ) {
    return false;
  }

  /*
   * Prevent false hot-work findings.
   */

  if (
    !scene.hot_work_visible &&
    (
      item.category ===
        "Hot Work" ||
      combined.includes(
        "welding"
      ) ||
      combined.includes(
        "grinding"
      ) ||
      combined.includes(
        "hot work"
      )
    )
  ) {
    return false;
  }

  /*
   * Prevent false electrical findings.
   */

  if (
    !scene.electrical_visible &&
    item.category ===
      "Electrical Safety"
  ) {
    return false;
  }

  /*
   * Prevent false work-at-height findings.
   */

  if (
    !scene.elevated_work_visible &&
    item.category ===
      "Work at Height"
  ) {
    return false;
  }

  /*
   * Prevent false confined-space findings.
   */

  if (
    item.category ===
      "Confined Space" &&
    !combined.includes(
      "confined"
    ) &&
    !combined.includes(
      "enclosed"
    ) &&
    !combined.includes(
      "container interior"
    )
  ) {
    return false;
  }

  return true;
}

/* =========================================================
   NORMALIZE FINDINGS
   ========================================================= */

function normalizeFindings(
  parsed: Array<{
    category: string;
    title: string;
    observation: string;
    evidence: string;
    status: Status;
    risk: Risk;
    confidence: number;
    checkId: string;
  }>,
  checks: SafetyCheck[],
  scene: SceneAnalysis
): Finding[] {
  const output: Finding[] =
    [];

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

    const evidence =
      cleanMarkdown(
        item.evidence,
        1000
      );

    if (
      !category ||
      !observation ||
      !evidence
    ) {
      continue;
    }

    if (
      !evidenceLooksValid(
        {
          category,
          title,
          observation,
          evidence,
        },
        scene
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
     * Only accept a finding when it maps to
     * one of the retrieved/current safety checks.
     */

    if (!check) {
      continue;
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
      confidence = 0.6;
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

      evidence,

      status:
        item.status,

      risk_level:
        item.risk,

      confidence:
        Math.round(
          confidence * 100
        ) / 100,

      check_id:
        check.id,

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
    return "No valid visible safety conditions were identified from the photograph.";
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

  const values: Record<
    string,
    unknown
  > = {
    id,

    inspection_no:
      inspectionNo,

    location:
      location || null,

    inspector:
      inspector || null,

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
    .prepare(insert.sql)
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

  const values: Record<
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
    .prepare(insert.sql)
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
        const values: Record<
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

          /*
           * Added only when the database
           * has the evidence column.
           */

          evidence:
            finding.evidence,

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
          .prepare(insert.sql)
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
   VECTORIZE SEED
   ========================================================= */

async function seedVectorize(
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
            "No active safety checks were found.",
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
          `Safety category: ${check.category}`,

          `Check question: ${check.check_question}`,

          `Guidance: ${check.guidance}`,

          `Keywords: ${check.keywords}`,

          `Source: ${check.source_title}`,

          `Source type: ${
            check.source_type ||
            "WSHC_DERIVED"
          }`,
        ].join("\n");

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
          id:
            check.id,

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

    /*
     * Vectorize supports batches.
     * 22 checks is comfortably within
     * the normal batch size.
     */

    await (env.VECTORIZE as any)
      .upsert(
        vectors
      );

    return jsonResponse({
      ok: true,

      message:
        "Safety checks successfully indexed into Vectorize.",

      index:
        VECTOR_INDEX,

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
     * -------------------------------------------------------
     * 1. Parse image
     * -------------------------------------------------------
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
     * -------------------------------------------------------
     * 2. Create IDs
     * -------------------------------------------------------
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
     * -------------------------------------------------------
     * 3. Generate R2 key
     * -------------------------------------------------------
     */

    stage =
      "generate R2 object key";

    objectKey =
      `inspections/${inspectionId}/${photoId}.${extension(
        photo.contentType
      )}`;

    /*
     * -------------------------------------------------------
     * 4. D1 inspection
     * -------------------------------------------------------
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
     * -------------------------------------------------------
     * 5. R2
     * -------------------------------------------------------
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
     * -------------------------------------------------------
     * 6. D1 photo
     * -------------------------------------------------------
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
     * -------------------------------------------------------
     * 7. Load 22 WSHC checks
     * -------------------------------------------------------
     */

    stage =
      "D1 load safety checks";

    const checks =
      await loadSafetyChecks(
        env
      );

    /*
     * -------------------------------------------------------
     * 8. Scene analysis
     * -------------------------------------------------------
     */

    stage =
      "scene analysis";

    const sceneResult =
      await analyzeScene(
        env,
        photo.bytes,
        photo.contentType
      );

    const scene =
      sceneResult.scene;

    /*
     * -------------------------------------------------------
     * 9. Vectorize retrieval
     * -------------------------------------------------------
     */

    stage =
      "Vectorize retrieve relevant safety checks";

    const retrieved =
      await retrieveRelevantChecks(
        env,
        scene
      );

    /*
     * -------------------------------------------------------
     * 10. Final evidence-based AI
     * -------------------------------------------------------
     */

    stage =
      "evidence-based Workers AI";

    const ai =
      await runFinalAI(
        env,
        photo.bytes,
        photo.contentType,
        scene,
        retrieved
      );

    /*
     * -------------------------------------------------------
     * 11. Parse AI
     * -------------------------------------------------------
     */

    stage =
      "parse final AI response";

    const parsed =
      parseAIResponse(
        ai.raw
      );

    /*
     * -------------------------------------------------------
     * 12. Validate against scene
     * -------------------------------------------------------
     */

    stage =
      "evidence validation";

    const findings =
      normalizeFindings(
        parsed,
        checks,
        scene
      );

    /*
     * -------------------------------------------------------
     * 13. Save findings
     * -------------------------------------------------------
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
     * -------------------------------------------------------
     * 14. Overall
     * -------------------------------------------------------
     */

    stage =
      "calculate overall result";

    const result =
      overall(
        findings
      );

    /*
     * -------------------------------------------------------
     * 15. Update inspection
     * -------------------------------------------------------
     */

    stage =
      "D1 update inspection";

    await updateInspection(
      env,
      inspectionId,
      result
    );

    /*
     * -------------------------------------------------------
     * 16. Response
     * -------------------------------------------------------
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

      /*
       * Scene information is returned so
       * you can debug the AI behaviour.
       */

      scene: {
        summary:
          scene.scene_summary,

        visible_objects:
          scene.visible_objects,

        visible_activities:
          scene.visible_activities,

        visible_hazards:
          scene.visible_hazards,

        visible_controls:
          scene.visible_controls,

        people_visible:
          scene.people_visible,

        vehicles_visible:
          scene.vehicles_visible,

        machinery_visible:
          scene.machinery_visible,

        lifting_visible:
          scene.lifting_visible,

        hot_work_visible:
          scene.hot_work_visible,

        electrical_visible:
          scene.electrical_visible,

        chemicals_visible:
          scene.chemicals_visible,

        cylinders_visible:
          scene.cylinders_visible,

        elevated_work_visible:
          scene.elevated_work_visible,

        storage_visible:
          scene.storage_visible,

        relevant_categories:
          scene.relevant_categories,
      },

      vectorize: {
        index:
          VECTOR_INDEX,

        embedding_model:
          EMBEDDING_MODEL,

        threshold:
          VECTOR_MATCH_THRESHOLD,

        retrieved:
          retrieved.map(
            item => ({
              id:
                item.check.id,

              category:
                item.check.category,

              score:
                item.score,
            })
          ),
      },

      ai: {
        model:
          MODEL,

        response_length:
          ai.raw.length,

        response_preview:
          ai.raw.substring(
            0,
            3000
          ),

        scene_response_preview:
          sceneResult.raw.substring(
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
     * Cleanup R2 if analysis failed.
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
     * Keep inspection record for
     * troubleshooting.
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

  let vectorizeIndex =
    VECTOR_INDEX;

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
      MODEL,

    embedding_model:
      EMBEDDING_MODEL,

    database,

    safety_checks:
      safetyChecks,

    r2,

    vectorize,

    vectorize_index:
      vectorizeIndex,

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
   * Health
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
   * Main AI analysis.
   *
   * Both /api/analyze and /api/analysis
   * are supported.
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
   * Vectorize seed.
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
   * Recent inspections.
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
   * Individual inspection.
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
   * Safety checks.
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
   * Photo.
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
       * Frontend assets
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
