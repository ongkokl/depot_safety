export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
}

const MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const MAX_IMAGE_SIZE = 12 * 1024 * 1024;
const MAX_FINDINGS = 8;

type Status = "PASS" | "FAIL" | "CHECK_REQUIRED";
type Risk = "LOW" | "MEDIUM" | "HIGH";

interface SafetyCheck {
  id: string;
  category: string;
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
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods":
          "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type",
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
      "Access-Control-Allow-Origin": "*",
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

  const chunkSize = 0x8000;

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

  if (
    contentType
      .toLowerCase()
      .includes(
        "multipart/form-data"
      )
  ) {
    const form =
      await request.formData();

    let file: File | null = null;

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
        ) || "Unspecified",

      inspector:
        clean(
          form.get("inspector"),
          200
        ) || "Unspecified",
    };
  }

  let body: any;

  try {
    body = await request.json();
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
    typeof base64 !== "string" ||
    !base64.trim()
  ) {
    throw new Error(
      "No image was supplied."
    );
  }

  base64 = base64.trim();

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

    base64 = match[2];
  }

  let binary: string;

  try {
    binary = atob(base64);
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
      bytes: bytes.buffer,
      contentType: imageType,
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
    !ALLOWED_TABLES.includes(table)
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
        (row) => row.name
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
    !ALLOWED_TABLES.includes(table)
  ) {
    throw new Error(
      `Invalid insert table: ${table}`
    );
  }

  const selected =
    Object.entries(values)
      .filter(
        ([column]) =>
          columns.has(column)
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
      (column) =>
        !columns.has(column)
    );

  if (missing.length) {
    throw new Error(
      `safety_checks is missing columns: ${missing.join(
        ", "
      )}`
    );
  }

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
        FROM safety_checks
        WHERE active = 1
        ORDER BY category, id
        LIMIT 40
        `
      )
      .all<SafetyCheck>();

  return result.results || [];
}

/* =========================================================
   AI PROMPT
   ========================================================= */

function buildPrompt(
  checks: SafetyCheck[]
): string {
  const available =
    checks
      .map(
        (check) =>
          `
CHECK ID: ${check.id}
CATEGORY: ${check.category}
QUESTION: ${clean(
            check.check_question,
            350
          )}
GUIDANCE: ${clean(
            check.guidance,
            500
          )}
KEYWORDS: ${clean(
            check.keywords,
            250
          )}
SOURCE: ${clean(
            check.source_title,
            250
          )}
URL: ${clean(
            check.source_url,
            500
          )}
`
      )
      .join("\n");

  return `
You are a workplace safety inspection assistant for a Singapore shipping/container depot.

Analyse ONLY what is visibly supported by the photograph.

Do not invent hazards.

Do not assume every safety category applies.

Only assess a category when there is visible evidence relevant to that category.

If a category is not visibly relevant, OMIT it completely.

Do NOT create findings such as:
"No visible lifting operation"
"No visible work at height"
"No visible electrical equipment"
"No visible fire hazards"
"No visible storage"

These are NOT findings and must be omitted.

CHECK_REQUIRED should only be used when a relevant safety condition IS visible but the photograph is insufficient to determine whether it is safe.

PASS means the visible condition appears satisfactory.

FAIL means a visible unsafe condition is identified.

RISK:
LOW = satisfactory/minor concern.
MEDIUM = potential safety concern.
HIGH = serious visible safety concern.

CONFIDENCE must be between 0 and 1.

Return only relevant visible findings.

Use exactly this structure:

**PPE**

* **Title:** Visible PPE appears appropriate
* **Observation:** The worker is visibly wearing a hard hat and high-visibility vest.
* **Status:** PASS
* **Risk:** LOW
* **Confidence:** 0.88
* **Check ID:** ppe-001

Then repeat for other relevant visible categories.

Do not include explanations before or after the findings.

AVAILABLE WSH CHECKS:

${available}
`.trim();
}

/* =========================================================
   WORKERS AI
   ========================================================= */

async function runAI(
  env: Env,
  image: ArrayBuffer,
  contentType: string,
  checks: SafetyCheck[]
): Promise<{
  raw: string;
  result: any;
}> {
  const prompt =
    buildPrompt(checks);

  const imageData =
    imageDataUrl(
      image,
      contentType
    );

  let response: any;

  try {
    response =
      await env.AI.run(
        MODEL,
        {
          messages: [
            {
              role: "system",
              content:
                "You are a careful Singapore workplace safety visual inspection assistant. Only report visible evidence.",
            },

            {
              role: "user",
              content: prompt,
            },
          ],

          image: imageData,

          max_tokens: 900,

          temperature: 0.05,

          top_p: 0.8,
        } as any
      );
  } catch (error) {
    throw new Error(
      `Workers AI request failed: ${
        error instanceof Error
          ? error.message
          : String(error)
      }`
    );
  }

  const raw =
    typeof response === "string"
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
      `Workers AI returned no text. Response: ${JSON.stringify(
        response
      ).substring(0, 3000)}`
    );
  }

  return {
    raw: raw.trim(),
    result: response,
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
    Number(match[1]);

  if (
    !Number.isFinite(number)
  ) {
    return 0.6;
  }

  if (number > 1) {
    number /= 100;
  }

  return (
    Math.round(
      Math.max(
        0,
        Math.min(1, number)
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
    text.includes("FAIL")
  ) {
    return "FAIL";
  }

  if (
    text.includes("PASS")
  ) {
    return "PASS";
  }

  if (
    text.includes("CHECK")
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
      (word) =>
        lower.includes(word)
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
    text.includes("HIGH")
  ) {
    return "HIGH";
  }

  if (
    text.includes("MEDIUM")
  ) {
    return "MEDIUM";
  }

  if (
    text.includes("LOW")
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
   IGNORE NON-VISIBLE FINDINGS
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
    (pattern) =>
      text.includes(pattern)
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
    lower.includes("lifting")
  ) {
    return "Lifting";
  }

  if (
    lower.includes("electrical")
  ) {
    return "Electrical Safety";
  }

  if (
    lower.includes("fire")
  ) {
    return "Fire Safety";
  }

  if (
    lower.includes("storage")
  ) {
    return "Storage";
  }

  return value;
}

/* =========================================================
   NEW AI PARSER
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
  const results: Array<{
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
      .replace(/\r/g, "")
      .trim();

  /*
   * Current format:
   *
   * **Housekeeping**
   *
   * * **Title:** ...
   * * **Observation:** ...
   * * **Status:** PASS
   * * **Risk:** LOW
   * * **Confidence:** 0.9
   * * **Check ID:** house-001
   */

  const headingRegex =
    /(?:^|\n)\s*\*\*([^*\n]+)\*\*\s*(?=\n)/g;

  const headings: Array<{
    index: number;
    category: string;
  }> = [];

  let match: RegExpExecArray | null;

  while (
    (match =
      headingRegex.exec(text)) !==
    null
  ) {
    const category =
      cleanMarkdown(
        match[1]
      );

    /*
     * Don't mistake field names for categories.
     */

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
      ].includes(category)
    ) {
      headings.push({
        index: match.index,
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
        ? headings[i + 1].index
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

    /*
     * Extract each field.
     *
     * The regex accepts:
     *
     * **Title:** text
     * * **Title:** text
     * **Title:** text
     */

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

    /*
     * Do not save "No visible..." as a finding.
     */

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
   * Legacy format:
   *
   * **Category:** PPE
   * **Title:** ...
   */

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
   * 1. Exact check ID.
   */

  if (
    finding.checkId
  ) {
    const exact =
      checks.find(
        (check) =>
          check.id ===
          finding.checkId
      );

    if (exact) {
      return exact;
    }
  }

  /*
   * 2. Exact category.
   */

  const category =
    normalizeCategory(
      finding.category
    );

  const categoryMatches =
    checks.filter(
      (check) =>
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
   * 3. Keyword match.
   */

  const combined =
    `${category} ${finding.title} ${finding.observation}`
      .toLowerCase();

  let best:
    SafetyCheck | null = null;

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
        500
      ).toLowerCase();

    const keywords =
      keywordText
        .split(
          /[,;|]+/
        )
        .map(
          (word) =>
            word.trim()
        )
        .filter(
          (word) =>
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
      bestScore = score;
      best = check;
    }
  }

  /*
   * IMPORTANT:
   *
   * Never use checks[0] as fallback.
   */

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
  const output: Finding[] = [];

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
      status:
        item.status,
      risk_level:
        item.risk,
      confidence:
        Math.round(
          confidence * 100
        ) / 100,
      check_id:
        check?.id || null,
      source_title:
        check?.source_title ||
        null,
      source_url:
        check?.source_url ||
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
      (finding) =>
        finding.status ===
        "FAIL"
    )
  ) {
    return "ATTENTION";
  }

  if (
    findings.some(
      (finding) =>
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
    return "No visible safety conditions were identified from the photograph.";
  }

  const pass =
    findings.filter(
      (finding) =>
        finding.status ===
        "PASS"
    ).length;

  const fail =
    findings.filter(
      (finding) =>
        finding.status ===
        "FAIL"
    ).length;

  const check =
    findings.filter(
      (finding) =>
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
    .bind(...insert.params)
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
    id: photoId,

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
    .bind(...insert.params)
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
      (finding) => {
        const values: Record<
          string,
          unknown
        > = {
          id: uuid(),

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
    /*
     * Existing R2 flow is retained.
     */

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
  let stage = "starting";
  let inspectionId = "";
  let photoId = "";
  let objectKey = "";
  let r2Uploaded = false;

  try {
    stage = "parse image";

    const input =
      await parseRequest(
        request
      );

    const photo =
      input.photo;

    stage = "create IDs";

    inspectionId = uuid();
    photoId = uuid();

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

    stage = "R2 upload";

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

    r2Uploaded = true;

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

    stage = "Workers AI";

    const ai =
      await runAI(
        env,
        photo.bytes,
        photo.contentType,
        checks
      );

    stage =
      "parse AI response";

    const parsed =
      parseAIResponse(
        ai.raw
      );

    stage =
      "match WSH checks";

    const findings =
      normalizeFindings(
        parsed,
        checks
      );

    stage =
      "D1 save inspection items";

    await insertInspectionItems(
      env,
      inspectionId,
      photoId,
      findings
    );

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
        model:
          MODEL,

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
            (f) =>
              f.status ===
              "PASS"
          ).length,

        fail:
          findings.filter(
            (f) =>
              f.status ===
              "FAIL"
          ).length,

        check_required:
          findings.filter(
            (f) =>
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
        error: diagnostic,
        stage,
        detail,
        inspectionId:
          inspectionId || null,
        photoId:
          photoId || null,
        objectKey:
          objectKey || null,
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
            sc.guidance
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
        photos.results || [],

      findings:
        items.results || [],
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
        result.results || [],
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
  let database = false;
  let safetyChecks = false;
  let r2 = false;

  try {
    await env.SAFETY_DB
      .prepare(
        "SELECT 1 AS ok"
      )
      .first();

    database = true;
  } catch {
    database = false;
  }

  try {
    await loadSafetyChecks(
      env
    );

    safetyChecks = true;
  } catch {
    safetyChecks = false;
  }

  try {
    r2 = !!env.PHOTOS;
  } catch {
    r2 = false;
  }

  return jsonResponse({
    ok:
      database &&
      safetyChecks &&
      r2,

    worker:
      "depot-safety",

    model:
      MODEL,

    database,

    safety_checks:
      safetyChecks,

    r2,

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

  if (
    request.method === "GET" &&
    path === "/api/health"
  ) {
    return health(env);
  }

  if (
    request.method === "POST" &&
    (
      path === "/api/analyze" ||
      path === "/api/analysis"
    )
  ) {
    return analyze(
      request,
      env
    );
  }

  if (
    request.method === "GET" &&
    path === "/api/inspections"
  ) {
    return recentInspections(
      env
    );
  }

  if (
    request.method === "GET" &&
    path.startsWith(
      "/api/inspection/"
    )
  ) {
    const id =
      decodeURIComponent(
        path.substring(
          "/api/inspection/".length
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

  if (
    request.method === "GET" &&
    path === "/api/safety-checks"
  ) {
    return safetyChecks(
      env
    );
  }

  if (
    request.method === "GET" &&
    path === "/api/photo"
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
                "Content-Type",
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
          asset.status !== 404
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
