export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
}

/*
 * ============================================================
 * SAFETY INSPECTION AI
 * ============================================================
 *
 * Cloudflare Worker
 *
 * Main API:
 *
 * POST /api/analyze
 * POST /api/analyse
 *
 * GET /api/health
 * GET /api/inspections
 * GET /api/inspections/:id
 * GET /api/safety-checks
 *
 * This version:
 *
 * - Uses Workers AI Vision
 * - Uses D1 safety_checks
 * - Saves AI results into inspection_items
 * - Does NOT require Vectorize
 *
 * ============================================================
 */

const MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const DEFAULT_WSH_URL =
  "https://www.tal.sg/wshc";

/*
 * ============================================================
 * TYPES
 * ============================================================
 */

interface SafetyCheck {
  id: string;
  category: string;
  check_question: string;
  guidance: string;
  source_title: string;
  source_url: string;
  keywords: string;
  active: number;
}

interface AIFinding {
  category: string;
  title: string;
  observation: string;
  status:
    | "PASS"
    | "CHECK_REQUIRED"
    | "FAIL";
  risk_level:
    | "LOW"
    | "MEDIUM"
    | "HIGH";
  confidence: number;
  check_id: string;
  source_title: string;
  source_url: string;
}

interface AIResult {
  scene_summary: string;
  findings: AIFinding[];
}

interface AnalyseRequest {
  image?: string;
  location?: string;
  inspector?: string;
  fileName?: string;
  contentType?: string;
}

/*
 * ============================================================
 * CORS
 * ============================================================
 */

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",
  };
}

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
          "application/json; charset=UTF-8",
        ...corsHeaders(),
      },
    }
  );
}

/*
 * ============================================================
 * BASIC HELPERS
 * ============================================================
 */

function makeId(
  prefix = ""
): string {
  const id =
    crypto.randomUUID();

  return prefix
    ? `${prefix}-${id}`
    : id;
}

function nowISO(): string {
  return new Date().toISOString();
}

function cleanString(
  value: unknown,
  fallback = ""
): string {
  if (
    typeof value !== "string"
  ) {
    return fallback;
  }

  return value.trim();
}

function clampConfidence(
  value: unknown
): number {
  const number =
    Number(value);

  if (
    !Number.isFinite(number)
  ) {
    return 0.5;
  }

  return Math.max(
    0,
    Math.min(1, number)
  );
}

function normalizeStatus(
  value: unknown
): AIFinding["status"] {
  const text =
    String(value || "")
      .trim()
      .toUpperCase();

  if (
    text === "FAIL" ||
    text === "FAILED" ||
    text === "UNSAFE"
  ) {
    return "FAIL";
  }

  if (
    text === "PASS" ||
    text === "PASSED" ||
    text === "SAFE"
  ) {
    return "PASS";
  }

  return "CHECK_REQUIRED";
}

function normalizeRisk(
  value: unknown
): AIFinding["risk_level"] {
  const text =
    String(value || "")
      .trim()
      .toUpperCase();

  if (text === "HIGH") {
    return "HIGH";
  }

  if (text === "LOW") {
    return "LOW";
  }

  return "MEDIUM";
}

function normalizeCategory(
  value: unknown
): string {
  const text =
    String(value || "")
      .trim();

  if (!text) {
    return "Other";
  }

  return text;
}

/*
 * ============================================================
 * IMAGE
 * ============================================================
 *
 * IMPORTANT:
 *
 * The Llama Vision model expects:
 *
 * image: string
 *
 * NOT:
 *
 * image: []
 *
 * The browser sends a data URL:
 *
 * data:image/jpeg;base64,...
 *
 * ============================================================
 */

function normalizeImage(
  image: string,
  contentType = "image/jpeg"
): string {
  const value =
    image.trim();

  if (!value) {
    throw new Error(
      "No image was supplied."
    );
  }

  /*
   * Already a data URL.
   */
  if (
    value.startsWith(
      "data:image/"
    )
  ) {
    return value;
  }

  /*
   * If the frontend somehow sends a URL.
   */
  if (
    value.startsWith(
      "https://"
    ) ||
    value.startsWith(
      "http://"
    )
  ) {
    return value;
  }

  /*
   * Raw base64.
   */
  const safeType =
    contentType &&
    contentType.startsWith(
      "image/"
    )
      ? contentType
      : "image/jpeg";

  return (
    `data:${safeType};base64,` +
    value.replace(
      /^data:[^;]+;base64,/i,
      ""
    )
  );
}

/*
 * ============================================================
 * DATABASE HELPERS
 * ============================================================
 */

/*
 * Get table column names dynamically.
 *
 * This protects the Worker against small differences between
 * the database schema and the application code.
 */
async function getTableColumns(
  db: D1Database,
  table: string
): Promise<string[]> {
  try {
    const result =
      await db
        .prepare(
          `PRAGMA table_info("${table}")`
        )
        .all<{
          name: string;
        }>();

    return (
      result.results || []
    ).map(
      (row) => row.name
    );
  } catch {
    return [];
  }
}

/*
 * ============================================================
 * SAFETY CHECKS
 * ============================================================
 */

async function getSafetyChecks(
  db: D1Database
): Promise<SafetyCheck[]> {
  try {
    const result =
      await db
        .prepare(
          `
          SELECT
            id,
            category,
            check_question,
            guidance,
            source_title,
            source_url,
            keywords,
            active
          FROM safety_checks
          WHERE active = 1
          ORDER BY category, id
          `
        )
        .all<SafetyCheck>();

    return (
      result.results || []
    );
  } catch (error) {
    console.error(
      "Unable to load safety_checks:",
      error
    );

    return [];
  }
}

/*
 * ============================================================
 * SAFETY CHECK TEXT FOR AI
 * ============================================================
 */

function buildSafetyCheckPrompt(
  checks: SafetyCheck[]
): string {
  if (!checks.length) {
    return `
No safety checks are currently loaded from D1.

Use only general visible workplace safety observations.
Do not invent WSH requirements.
`;
  }

  return checks
    .map(
      (check, index) => `
SAFETY CHECK ${index + 1}

CHECK_ID:
${check.id}

CATEGORY:
${check.category}

CHECK QUESTION:
${check.check_question}

GUIDANCE:
${check.guidance}

SOURCE:
${check.source_title}

SOURCE URL:
${check.source_url}

KEYWORDS:
${check.keywords || ""}
`
    )
    .join("\n");
}

/*
 * ============================================================
 * AI PROMPT
 * ============================================================
 */

function buildAIPrompt(
  checks: SafetyCheck[]
): string {
  return `
You are an AI workplace safety inspection assistant
for a Singapore workplace.

Your job is to analyse the supplied workplace photograph
and identify safety conditions that can actually be observed
from the photograph.

The application uses Singapore WSH Council guidance as
its reference framework.

IMPORTANT RULES:

1. Only report things that are visible or reasonably supported
   by the photograph.

2. Do not invent hazards.

3. Do not assume something is unsafe merely because it cannot
   be seen.

4. If physical verification is required, use:
   CHECK_REQUIRED.

5. Use FAIL only when a clearly unsafe condition is visible.

6. Use PASS only when the photograph provides reasonable
   visual evidence of a positive safety condition.

7. Do not claim complete legal compliance from a photograph.

8. Do not assume that a worker requires a particular PPE item
   unless the visible activity provides a reasonable basis.

9. Do not assume that a crane means a lifting hazard.

10. Do not assume that a railing means work-at-height exposure.

11. For vehicular safety, only apply the check when vehicles,
    traffic routes or pedestrians are visible.

12. For housekeeping, look for visible spills, debris,
    obstruction, poor storage and unsafe access.

13. For equipment, look for visible damage, missing guards,
    unsafe positioning or other obvious hazards.

14. Generate a maximum of 8 findings.

15. Avoid duplicate findings.

16. Keep observations factual and concise.

17. Use the provided safety check IDs whenever possible.

18. Return JSON only.

WSH SAFETY CHECK LIBRARY:

${buildSafetyCheckPrompt(checks)}
`;
}

/*
 * ============================================================
 * AI JSON SCHEMA
 * ============================================================
 */

const AI_SCHEMA = {
  type: "object",

  properties: {
    scene_summary: {
      type: "string",
    },

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
              "CHECK_REQUIRED",
              "FAIL",
            ],
          },

          risk_level: {
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
            type: "string",
          },

          source_title: {
            type: "string",
          },

          source_url: {
            type: "string",
          },
        },

        required: [
          "category",
          "title",
          "observation",
          "status",
          "risk_level",
          "confidence",
          "check_id",
          "source_title",
          "source_url",
        ],
      },
    },
  },

  required: [
    "scene_summary",
    "findings",
  ],
};

/*
 * ============================================================
 * AI RESPONSE PARSING
 * ============================================================
 */

function extractResponseText(
  response: unknown
): string {
  if (
    typeof response === "string"
  ) {
    return response;
  }

  if (
    !response ||
    typeof response !== "object"
  ) {
    return "";
  }

  const object =
    response as Record<
      string,
      unknown
    >;

  if (
    typeof object.response ===
    "string"
  ) {
    return object.response;
  }

  if (
    typeof object.text ===
    "string"
  ) {
    return object.text;
  }

  if (
    typeof object.output ===
    "string"
  ) {
    return object.output;
  }

  return "";
}

function cleanJSONText(
  text: string
): string {
  let result =
    text.trim();

  /*
   * Remove Markdown code fences.
   */
  result =
    result.replace(
      /^```json\s*/i,
      ""
    );

  result =
    result.replace(
      /^```\s*/i,
      ""
    );

  result =
    result.replace(
      /\s*```$/i,
      ""
    );

  return result.trim();
}

function parseAIJSON(
  text: string
): unknown {
  const cleaned =
    cleanJSONText(text);

  /*
   * Try direct JSON.
   */
  try {
    return JSON.parse(
      cleaned
    );
  } catch {
    // Continue.
  }

  /*
   * Try extracting the first JSON object.
   */
  const first =
    cleaned.indexOf("{");

  const last =
    cleaned.lastIndexOf("}");

  if (
    first >= 0 &&
    last > first
  ) {
    const candidate =
      cleaned.substring(
        first,
        last + 1
      );

    try {
      return JSON.parse(
        candidate
      );
    } catch {
      // Continue.
    }
  }

  throw new Error(
    "Workers AI returned an invalid structured response."
  );
}

/*
 * ============================================================
 * NORMALISE AI RESULT
 * ============================================================
 */

function normalizeAIResult(
  value: unknown
): AIResult {
  let object: any =
    value;

  /*
   * If response is:
   *
   * { response: "..." }
   *
   * parse it.
   */
  if (
    object &&
    typeof object === "object" &&
    typeof object.response ===
      "string"
  ) {
    object =
      parseAIJSON(
        object.response
      );
  }

  if (
    typeof object === "string"
  ) {
    object =
      parseAIJSON(
        object
      );
  }

  if (
    !object ||
    typeof object !== "object"
  ) {
    throw new Error(
      "Workers AI returned an invalid structured response."
    );
  }

  const rawFindings =
    Array.isArray(
      object.findings
    )
      ? object.findings
      : [];

  const findings:
    AIFinding[] = [];

  for (
    const raw
    of rawFindings.slice(
      0,
      8
    )
  ) {
    if (
      !raw ||
      typeof raw !== "object"
    ) {
      continue;
    }

    const finding =
      raw as Record<
        string,
        unknown
      >;

    const title =
      cleanString(
        finding.title,
        "Safety observation"
      );

    const observation =
      cleanString(
        finding.observation,
        "Physical/site verification is required."
      );

    findings.push({
      category:
        normalizeCategory(
          finding.category
        ),

      title,

      observation,

      status:
        normalizeStatus(
          finding.status
        ),

      risk_level:
        normalizeRisk(
          finding.risk_level
        ),

      confidence:
        clampConfidence(
          finding.confidence
        ),

      check_id:
        cleanString(
          finding.check_id
        ),

      source_title:
        cleanString(
          finding.source_title,
          "WSH Council"
        ),

      source_url:
        cleanString(
          finding.source_url,
          DEFAULT_WSH_URL
        ),
    });
  }

  return {
    scene_summary:
      cleanString(
        object.scene_summary,
        "Workplace scene analysed."
      ),

    findings,
  };
}

/*
 * ============================================================
 * RUN WORKERS AI
 * ============================================================
 */

async function runVisionAI(
  env: Env,
  image: string,
  prompt: string
): Promise<AIResult> {
  /*
   * IMPORTANT:
   *
   * content MUST be a STRING.
   *
   * image MUST be a STRING.
   *
   * Do not change these to arrays.
   */

  const aiInput = {
    messages: [
      {
        role: "system",

        content:
          "You are a careful Singapore workplace safety inspection assistant. Return valid JSON only.",
      },

      {
        role: "user",

        content: prompt,
      },
    ],

    image,

    response_format: {
      type: "json_schema",

      json_schema:
        AI_SCHEMA,
    },

    temperature: 0.1,

    max_tokens: 1800,

    top_p: 0.9,
  };

  try {
    const response =
      await env.AI.run(
        MODEL,
        aiInput as any
      );

    /*
     * Some Workers AI responses can already be an object.
     */
    if (
      response &&
      typeof response ===
        "object"
    ) {
      const object =
        response as any;

      if (
        Array.isArray(
          object.findings
        )
      ) {
        return normalizeAIResult(
          object
        );
      }

      if (
        object.result &&
        typeof object.result ===
          "object"
      ) {
        return normalizeAIResult(
          object.result
        );
      }
    }

    /*
     * Otherwise parse response text.
     */
    const text =
      extractResponseText(
        response
      );

    if (!text) {
      throw new Error(
        "Workers AI returned an empty response."
      );
    }

    return normalizeAIResult(
      text
    );

  } catch (error) {
    /*
     * Do one fallback request without response_format.
     *
     * This is useful if JSON Schema is rejected by the
     * deployed model/runtime.
     */

    const firstError =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      "Primary AI request failed:",
      firstError
    );

    try {
      const fallbackInput = {
        messages: [
          {
            role: "system",

            content:
              "You are a workplace safety inspection assistant. Return ONLY valid JSON. Do not use Markdown.",
          },

          {
            role: "user",

            content:
              `${prompt}

IMPORTANT:
Return ONLY this JSON structure:

{
  "scene_summary": "short summary",
  "findings": [
    {
      "category": "category",
      "title": "short title",
      "observation": "visible observation",
      "status": "PASS",
      "risk_level": "LOW",
      "confidence": 0.9,
      "check_id": "matching check ID",
      "source_title": "source",
      "source_url": "source URL"
    }
  ]
}

No Markdown.
No text before the JSON.
No text after the JSON.`,
          },
        ],

        image,

        temperature: 0.1,

        max_tokens: 1800,

        top_p: 0.9,
      };

      const fallbackResponse =
        await env.AI.run(
          MODEL,
          fallbackInput as any
        );

      const fallbackText =
        extractResponseText(
          fallbackResponse
        );

      if (!fallbackText) {
        throw new Error(
          "Workers AI returned an empty fallback response."
        );
      }

      return normalizeAIResult(
        fallbackText
      );

    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof
        Error
          ? fallbackError.message
          : String(
              fallbackError
            );

      throw new Error(
        `Workers AI failed. Primary: ${firstError}. Fallback: ${fallbackMessage}`
      );
    }
  }
}

/*
 * ============================================================
 * MATCH AI FINDING TO SAFETY CHECK
 * ============================================================
 */

function matchSafetyCheck(
  finding: AIFinding,
  checks: SafetyCheck[]
): SafetyCheck | null {
  /*
   * Exact ID first.
   */
  if (
    finding.check_id
  ) {
    const exact =
      checks.find(
        (check) =>
          check.id ===
          finding.check_id
      );

    if (exact) {
      return exact;
    }
  }

  /*
   * Category match.
   */
  const category =
    finding.category
      .toLowerCase();

  const categoryMatch =
    checks.find(
      (check) =>
        check.category
          .toLowerCase() ===
        category
    );

  if (categoryMatch) {
    return categoryMatch;
  }

  /*
   * Keyword match.
   */
  const searchText =
    (
      finding.title +
      " " +
      finding.observation
    ).toLowerCase();

  let best:
    SafetyCheck | null =
    null;

  let bestScore = 0;

  for (
    const check
    of checks
  ) {
    const keywords =
      String(
        check.keywords ||
          ""
      )
        .toLowerCase()
        .split(",")
        .map(
          (item) =>
            item.trim()
        )
        .filter(Boolean);

    let score = 0;

    for (
      const keyword
      of keywords
    ) {
      if (
        searchText.includes(
          keyword
        )
      ) {
        score++;
      }
    }

    if (
      score > bestScore
    ) {
      bestScore =
        score;

      best =
        check;
    }
  }

  return best;
}

/*
 * ============================================================
 * OVERALL RESULT
 * ============================================================
 */

function calculateOverallResult(
  findings: AIFinding[]
): string {
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

/*
 * ============================================================
 * INSPECTION INSERT
 * ============================================================
 *
 * Your exact inspections table schema has not been shown in
 * the latest screenshots, so this function dynamically checks
 * which columns actually exist.
 *
 * It avoids the earlier problem where code attempted to insert
 * into columns that were not present.
 * ============================================================
 */

async function createInspection(
  db: D1Database,
  location: string,
  inspector: string
): Promise<{
  id: string;
  inspectionNo: string;
}> {
  const id =
    crypto.randomUUID();

  const inspectionNo =
    `SI-${new Date()
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "")}-${crypto
      .randomUUID()
      .replaceAll("-", "")
      .slice(0, 6)
      .toUpperCase()}`;

  const columns =
    await getTableColumns(
      db,
      "inspections"
    );

  if (!columns.length) {
    throw new Error(
      "The inspections table could not be found."
    );
  }

  /*
   * Only insert columns that really exist.
   */
  const values: Record<
    string,
    unknown
  > = {};

  if (
    columns.includes("id")
  ) {
    values.id = id;
  }

  if (
    columns.includes(
      "inspection_no"
    )
  ) {
    values.inspection_no =
      inspectionNo;
  }

  if (
    columns.includes(
      "location"
    )
  ) {
    values.location =
      location ||
      "Unspecified";
  }

  if (
    columns.includes(
      "inspector"
    )
  ) {
    values.inspector =
      inspector ||
      "Unspecified";
  }

  if (
    columns.includes(
      "created_at"
    )
  ) {
    values.created_at =
      nowISO();
  }

  if (
    columns.includes(
      "overall_result"
    )
  ) {
    values.overall_result =
      "CHECK_REQUIRED";
  }

  /*
   * Some versions may use status instead.
   */
  if (
    columns.includes(
      "status"
    ) &&
    !("overall_result" in values)
  ) {
    values.status =
      "CHECK_REQUIRED";
  }

  const columnNames =
    Object.keys(values);

  const placeholders =
    columnNames
      .map(
        () => "?"
      )
      .join(", ");

  const sql =
    `
      INSERT INTO inspections
      (${columnNames.join(", ")})
      VALUES (${placeholders})
    `;

  await db
    .prepare(sql)
    .bind(
      ...columnNames.map(
        (column) =>
          values[column]
      )
    )
    .run();

  return {
    id,
    inspectionNo,
  };
}

/*
 * ============================================================
 * UPDATE INSPECTION
 * ============================================================
 */

async function updateInspection(
  db: D1Database,
  inspectionId: string,
  result: string
): Promise<void> {
  const columns =
    await getTableColumns(
      db,
      "inspections"
    );

  if (
    columns.includes(
      "overall_result"
    )
  ) {
    await db
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

    return;
  }

  if (
    columns.includes(
      "status"
    )
  ) {
    await db
      .prepare(
        `
        UPDATE inspections
        SET status = ?
        WHERE id = ?
        `
      )
      .bind(
        result,
        inspectionId
      )
      .run();
  }
}

/*
 * ============================================================
 * SAVE PHOTO
 * ============================================================
 */

async function savePhoto(
  db: D1Database,
  inspectionId: string,
  fileName: string,
  contentType: string
): Promise<string> {
  const photoId =
    crypto.randomUUID();

  const columns =
    await getTableColumns(
      db,
      "inspection_photos"
    );

  if (!columns.length) {
    throw new Error(
      "The inspection_photos table could not be found."
    );
  }

  const values: Record<
    string,
    unknown
  > = {};

  if (
    columns.includes("id")
  ) {
    values.id =
      photoId;
  }

  if (
    columns.includes(
      "inspection_id"
    )
  ) {
    values.inspection_id =
      inspectionId;
  }

  if (
    columns.includes(
      "file_name"
    )
  ) {
    values.file_name =
      fileName;
  }

  if (
    columns.includes(
      "content_type"
    )
  ) {
    values.content_type =
      contentType;
  }

  if (
    columns.includes(
      "created_at"
    )
  ) {
    values.created_at =
      nowISO();
  }

  if (
    columns.includes(
      "object_key"
    )
  ) {
    values.object_key =
      `inspection/${inspectionId}/${photoId}`;
  }

  /*
   * Some previous versions may use different names.
   */
  if (
    columns.includes(
      "filename"
    ) &&
    !("file_name" in values)
  ) {
    values.filename =
      fileName;
  }

  if (
    columns.includes(
      "mime_type"
    ) &&
    !("content_type" in values)
  ) {
    values.mime_type =
      contentType;
  }

  const names =
    Object.keys(values);

  const placeholders =
    names
      .map(
        () => "?"
      )
      .join(", ");

  await db
    .prepare(
      `
      INSERT INTO inspection_photos
      (${names.join(", ")})
      VALUES (${placeholders})
      `
    )
    .bind(
      ...names.map(
        (name) =>
          values[name]
      )
    )
    .run();

  return photoId;
}

/*
 * ============================================================
 * SAVE INSPECTION ITEMS
 * ============================================================
 *
 * THIS USES YOUR ACTUAL TABLE:
 *
 * inspection_items
 *
 * Based on the schema you supplied:
 *
 * id
 * inspection_id
 * photo_id
 * category
 * title
 * observation
 * status
 * risk_level
 * confidence
 * check_id
 * source_title
 * source_url
 * created_at
 *
 * ============================================================
 */

async function saveInspectionItems(
  db: D1Database,
  inspectionId: string,
  photoId: string,
  findings: AIFinding[],
  checks: SafetyCheck[]
): Promise<void> {
  for (
    const finding
    of findings
  ) {
    const matched =
      matchSafetyCheck(
        finding,
        checks
      );

    const itemId =
      crypto.randomUUID();

    const category =
      matched?.category ||
      finding.category ||
      "Other";

    const checkId =
      matched?.id ||
      finding.check_id ||
      null;

    const sourceTitle =
      matched?.source_title ||
      finding.source_title ||
      "WSH Council";

    const sourceUrl =
      matched?.source_url ||
      finding.source_url ||
      DEFAULT_WSH_URL;

    await db
      .prepare(
        `
        INSERT INTO inspection_items
        (
          id,
          inspection_id,
          photo_id,
          category,
          title,
          observation,
          status,
          risk_level,
          confidence,
          check_id,
          source_title,
          source_url,
          created_at
        )
        VALUES
        (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        `
      )
      .bind(
        itemId,
        inspectionId,
        photoId,
        category,
        finding.title,
        finding.observation,
        finding.status,
        finding.risk_level,
        finding.confidence,
        checkId,
        sourceTitle,
        sourceUrl,
        nowISO()
      )
      .run();
  }
}

/*
 * ============================================================
 * ANALYSE PHOTO
 * ============================================================
 */

async function analysePhoto(
  request: Request,
  env: Env
): Promise<Response> {
  let body:
    AnalyseRequest;

  /*
   * ----------------------------------------------------------
   * Read JSON
   * ----------------------------------------------------------
   */

  try {
    body =
      await request.json();
  } catch {
    return jsonResponse(
      {
        success: false,
        error:
          "Invalid JSON request body."
      },
      400
    );
  }

  /*
   * ----------------------------------------------------------
   * Validate image
   * ----------------------------------------------------------
   */

  if (
    !body.image ||
    typeof body.image !==
      "string"
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "Image is required."
      },
      400
    );
  }

  const location =
    cleanString(
      body.location,
      "Unspecified"
    );

  const inspector =
    cleanString(
      body.inspector,
      "Unspecified"
    );

  const fileName =
    cleanString(
      body.fileName,
      "inspection.jpg"
    );

  const contentType =
    cleanString(
      body.contentType,
      "image/jpeg"
    );

  /*
   * ----------------------------------------------------------
   * Normalise image
   * ----------------------------------------------------------
   */

  let image: string;

  try {
    image =
      normalizeImage(
        body.image,
        contentType
      );
  } catch (error) {
    return jsonResponse(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      },
      400
    );
  }

  /*
   * ----------------------------------------------------------
   * Load WSH checks
   * ----------------------------------------------------------
   */

  const checks =
    await getSafetyChecks(
      env.SAFETY_DB
    );

  /*
   * ----------------------------------------------------------
   * Create inspection
   * ----------------------------------------------------------
   */

  let inspection:
    {
      id: string;
      inspectionNo: string;
    };

  try {
    inspection =
      await createInspection(
        env.SAFETY_DB,
        location,
        inspector
      );
  } catch (error) {
    return jsonResponse(
      {
        success: false,
        error:
          "Unable to create inspection.",
        detail:
          error instanceof Error
            ? error.message
            : String(error)
      },
      500
    );
  }

  /*
   * ----------------------------------------------------------
   * Save photo record
   * ----------------------------------------------------------
   */

  let photoId: string;

  try {
    photoId =
      await savePhoto(
        env.SAFETY_DB,
        inspection.id,
        fileName,
        contentType
      );
  } catch (error) {
    console.error(
      "PHOTO SAVE ERROR:",
      error
    );

    await updateInspection(
      env.SAFETY_DB,
      inspection.id,
      "CHECK_REQUIRED"
    );

    return jsonResponse(
      {
        success: false,
        error:
          "Unable to save inspection photo record.",
        detail:
          error instanceof Error
            ? error.message
            : String(error),
        inspection_id:
          inspection.id
      },
      500
    );
  }

  /*
   * ----------------------------------------------------------
   * Build AI prompt
   * ----------------------------------------------------------
   */

  const prompt =
    buildAIPrompt(
      checks
    );

  /*
   * ----------------------------------------------------------
   * RUN AI
   * ----------------------------------------------------------
   */

  let aiResult:
    AIResult;

  try {
    aiResult =
      await runVisionAI(
        env,
        image,
        prompt
      );
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      "WORKERS AI ERROR:",
      detail
    );

    await updateInspection(
      env.SAFETY_DB,
      inspection.id,
      "CHECK_REQUIRED"
    );

    return jsonResponse(
      {
        success: false,

        error:
          "AI analysis failed.",

        detail,

        inspection_id:
          inspection.id
      },
      500
    );
  }

  /*
   * ----------------------------------------------------------
   * Match findings to WSH checks
   * ----------------------------------------------------------
   */

  const findings =
    aiResult.findings.map(
      (finding) => {
        const matched =
          matchSafetyCheck(
            finding,
            checks
          );

        return {
          ...finding,

          category:
            matched?.category ||
            finding.category,

          check_id:
            matched?.id ||
            finding.check_id,

          source_title:
            matched?.source_title ||
            finding.source_title ||
            "WSH Council",

          source_url:
            matched?.source_url ||
            finding.source_url ||
            DEFAULT_WSH_URL
        };
      }
    );

  /*
   * ----------------------------------------------------------
   * Overall result
   * ----------------------------------------------------------
   */

  const overallResult =
    calculateOverallResult(
      findings
    );

  /*
   * ----------------------------------------------------------
   * Save inspection items
   * ----------------------------------------------------------
   */

  try {
    await saveInspectionItems(
      env.SAFETY_DB,
      inspection.id,
      photoId,
      findings,
      checks
    );
  } catch (error) {
    console.error(
      "INSPECTION ITEMS ERROR:",
      error
    );

    await updateInspection(
      env.SAFETY_DB,
      inspection.id,
      "CHECK_REQUIRED"
    );

    return jsonResponse(
      {
        success: false,

        error:
          "AI analysis completed but the inspection result could not be saved.",

        detail:
          error instanceof Error
            ? error.message
            : String(error),

        inspection_id:
          inspection.id,

        ai_result: {
          scene_summary:
            aiResult.scene_summary,

          findings
        }
      },
      500
    );
  }

  /*
   * ----------------------------------------------------------
   * Update overall inspection status
   * ----------------------------------------------------------
   */

  try {
    await updateInspection(
      env.SAFETY_DB,
      inspection.id,
      overallResult
    );
  } catch (error) {
    console.error(
      "INSPECTION UPDATE ERROR:",
      error
    );
  }

  /*
   * ----------------------------------------------------------
   * SUCCESS
   * ----------------------------------------------------------
   */

  return jsonResponse(
    {
      success: true,

      inspection: {
        id:
          inspection.id,

        inspection_no:
          inspection.inspectionNo,

        location,

        inspector,

        created_at:
          nowISO(),

        overall_result:
          overallResult
      },

      summary:
        aiResult.scene_summary,

      findings
    },
    200
  );
}

/*
 * ============================================================
 * GET RECENT INSPECTIONS
 * ============================================================
 */

async function getRecentInspections(
  db: D1Database
): Promise<Response> {
  try {
    const result =
      await db
        .prepare(
          `
          SELECT *
          FROM inspections
          ORDER BY created_at DESC
          LIMIT 20
          `
        )
        .all();

    const rows =
      result.results || [];

    return jsonResponse(
      {
        success: true,

        inspections:
          rows
      }
    );
  } catch (error) {
    return jsonResponse(
      {
        success: false,

        error:
          "Unable to load recent inspections.",

        detail:
          error instanceof Error
            ? error.message
            : String(error)
      },
      500
    );
  }
}

/*
 * ============================================================
 * GET SINGLE INSPECTION
 * ============================================================
 */

async function getInspection(
  db: D1Database,
  inspectionId: string
): Promise<Response> {
  try {
    const inspection =
      await db
        .prepare(
          `
          SELECT *
          FROM inspections
          WHERE id = ?
          LIMIT 1
          `
        )
        .bind(
          inspectionId
        )
        .first();

    if (!inspection) {
      return jsonResponse(
        {
          success: false,
          error:
            "Inspection not found."
        },
        404
      );
    }

    const items =
      await db
        .prepare(
          `
          SELECT *
          FROM inspection_items
          WHERE inspection_id = ?
          ORDER BY created_at ASC
          `
        )
        .bind(
          inspectionId
        )
        .all();

    const photos =
      await db
        .prepare(
          `
          SELECT *
          FROM inspection_photos
          WHERE inspection_id = ?
          ORDER BY created_at ASC
          `
        )
        .bind(
          inspectionId
        )
        .all();

    return jsonResponse(
      {
        success: true,

        inspection,

        items:
          items.results || [],

        photos:
          photos.results || []
      }
    );
  } catch (error) {
    return jsonResponse(
      {
        success: false,

        error:
          "Unable to load inspection.",

        detail:
          error instanceof Error
            ? error.message
            : String(error)
      },
      500
    );
  }
}

/*
 * ============================================================
 * GET SAFETY CHECKS
 * ============================================================
 */

async function getSafetyChecksAPI(
  db: D1Database
): Promise<Response> {
  const checks =
    await getSafetyChecks(
      db
    );

  return jsonResponse(
    {
      success: true,

      count:
        checks.length,

      checks
    }
  );
}

/*
 * ============================================================
 * HEALTH CHECK
 * ============================================================
 */

async function health(): Promise<Response> {
  return jsonResponse(
    {
      success: true,

      service:
        "Safety Inspection AI",

      status:
        "running",

      model:
        MODEL,

      vectorize:
        false,

      timestamp:
        nowISO()
    }
  );
}

/*
 * ============================================================
 * ROUTER
 * ============================================================
 */

async function route(
  request: Request,
  env: Env
): Promise<Response> {
  const url =
    new URL(
      request.url
    );

  const path =
    url.pathname;

  /*
   * ----------------------------------------------------------
   * HEALTH
   * ----------------------------------------------------------
   */

  if (
    path ===
      "/api/health" &&
    request.method ===
      "GET"
  ) {
    return health();
  }

  /*
   * ----------------------------------------------------------
   * ANALYSE / ANALYZE
   *
   * IMPORTANT:
   *
   * Both spellings are supported.
   *
   * This fixes the "Not found" problem.
   * ----------------------------------------------------------
   */

  if (
    (
      path ===
        "/api/analyze" ||

      path ===
        "/api/analyse" ||

      path ===
        "/api/analyze-photo" ||

      path ===
        "/api/analyse-photo"
    ) &&
    request.method ===
      "POST"
  ) {
    return analysePhoto(
      request,
      env
    );
  }

  /*
   * ----------------------------------------------------------
   * RECENT INSPECTIONS
   * ----------------------------------------------------------
   */

  if (
    path ===
      "/api/inspections" &&
    request.method ===
      "GET"
  ) {
    return getRecentInspections(
      env.SAFETY_DB
    );
  }

  /*
   * ----------------------------------------------------------
   * SINGLE INSPECTION
   * ----------------------------------------------------------
   */

  if (
    path.startsWith(
      "/api/inspections/"
    ) &&
    request.method ===
      "GET"
  ) {
    const id =
      decodeURIComponent(
        path.substring(
          "/api/inspections/"
            .length
        )
      );

    if (!id) {
      return jsonResponse(
        {
          success: false,
          error:
            "Inspection ID is required."
        },
        400
      );
    }

    return getInspection(
      env.SAFETY_DB,
      id
    );
  }

  /*
   * ----------------------------------------------------------
   * SAFETY CHECKS
   * ----------------------------------------------------------
   */

  if (
    path ===
      "/api/safety-checks" &&
    request.method ===
      "GET"
  ) {
    return getSafetyChecksAPI(
      env.SAFETY_DB
    );
  }

  /*
   * ----------------------------------------------------------
   * DEBUG ROUTE
   * ----------------------------------------------------------
   *
   * If the browser calls an incorrect endpoint,
   * this tells us exactly what it called.
   * ----------------------------------------------------------
   */

  return jsonResponse(
    {
      success: false,

      error:
        "Not found",

      path,

      method:
        request.method,

      available_endpoints: [
        "GET /api/health",
        "POST /api/analyze",
        "POST /api/analyse",
        "POST /api/analyze-photo",
        "POST /api/analyse-photo",
        "GET /api/inspections",
        "GET /api/inspections/:id",
        "GET /api/safety-checks"
      ]
    },
    404
  );
}

/*
 * ============================================================
 * WORKER ENTRY POINT
 * ============================================================
 */

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {

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
          status: 204,

          headers:
            corsHeaders()
        }
      );
    }

    try {
      return await route(
        request,
        env
      );
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        "WORKER ERROR:",
        detail
      );

      return jsonResponse(
        {
          success: false,

          error:
            "Server error.",

          detail
        },
        500
      );
    }
  }
} satisfies ExportedHandler<Env>;
