export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
}

/*
 * ============================================================
 * DEPOT SAFETY INSPECTION AI
 * ============================================================
 *
 * Cloudflare Worker
 *
 * AI:
 *   @cf/meta/llama-3.2-11b-vision-instruct
 *
 * Database:
 *   D1
 *
 * Main endpoints:
 *
 *   GET  /api/health
 *   POST /api/analyze
 *   POST /api/analyse
 *   GET  /api/inspections
 *   GET  /api/inspections/:id
 *   GET  /api/safety-checks
 *
 * Vectorize is NOT required for this version.
 *
 * ============================================================
 */

const MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const WSH_DEFAULT_URL =
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

interface Finding {
  category: string;
  title: string;
  observation: string;
  status:
    | "PASS"
    | "FAIL"
    | "CHECK_REQUIRED";
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
  findings: Finding[];
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


/*
 * ============================================================
 * JSON RESPONSE
 * ============================================================
 */

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

        "Cache-Control":
          "no-store",

        ...corsHeaders(),
      },
    }
  );
}


/*
 * ============================================================
 * GENERAL HELPERS
 * ============================================================
 */

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

  const result =
    value.trim();

  return result || fallback;
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
    Math.min(
      1,
      number
    )
  );
}


/*
 * ============================================================
 * NORMALISE STATUS
 * ============================================================
 */

function normalizeStatus(
  value: unknown
): Finding["status"] {

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


/*
 * ============================================================
 * NORMALISE RISK
 * ============================================================
 */

function normalizeRisk(
  value: unknown
): Finding["risk_level"] {

  const text =
    String(value || "")
      .trim()
      .toUpperCase();

  if (
    text === "HIGH"
  ) {
    return "HIGH";
  }

  if (
    text === "LOW"
  ) {
    return "LOW";
  }

  return "MEDIUM";
}


/*
 * ============================================================
 * NORMALISE CATEGORY
 * ============================================================
 */

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
 * IMAGE NORMALISATION
 * ============================================================
 *
 * Frontend sends:
 *
 * data:image/jpeg;base64,...
 *
 * Cloudflare Vision accepts the image as a string.
 *
 * IMPORTANT:
 *
 * image must NOT be:
 *
 * [
 *   "data:image/jpeg..."
 * ]
 *
 * It must be:
 *
 * "data:image/jpeg..."
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
   * Image URL.
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
   * Raw Base64.
   */

  let mime =
    contentType;

  if (
    !mime.startsWith(
      "image/"
    )
  ) {
    mime =
      "image/jpeg";
  }

  /*
   * Remove accidental data URL prefix.
   */

  const base64 =
    value.replace(
      /^data:[^;]+;base64,/i,
      ""
    );

  return (
    `data:${mime};base64,${base64}`
  );
}


/*
 * ============================================================
 * DATABASE TABLE COLUMNS
 * ============================================================
 */

async function getTableColumns(
  db: D1Database,
  tableName: string
): Promise<string[]> {

  try {

    const result =
      await db
        .prepare(
          `PRAGMA table_info("${tableName}")`
        )
        .all<{
          name: string;
        }>();

    return (
      result.results || []
    ).map(
      row => row.name
    );

  } catch (error) {

    console.error(
      `Unable to read table ${tableName}:`,
      error
    );

    return [];
  }
}


/*
 * ============================================================
 * LOAD WSH SAFETY CHECKS
 * ============================================================
 *
 * Your safety_checks table:
 *
 * id
 * category
 * check_question
 * guidance
 * source_title
 * source_url
 * keywords
 * active
 *
 * ============================================================
 */

async function loadSafetyChecks(
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
      "SAFETY CHECKS ERROR:",
      error
    );

    return [];
  }
}


/*
 * ============================================================
 * BUILD SAFETY CHECK PROMPT
 * ============================================================
 */

function buildSafetyCheckText(
  checks: SafetyCheck[]
): string {

  if (!checks.length) {

    return `
No active safety checks were found in D1.

Use general visible workplace safety principles only.

Do NOT invent specific WSH requirements.
`;
  }


  return checks
    .map(
      (check, index) => {

        return `
--------------------------------------------------
SAFETY CHECK ${index + 1}
--------------------------------------------------

CHECK ID:
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
`;
      }
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
supporting a safety inspector in Singapore.

Analyse the uploaded workplace photograph.

The photograph may show:
- container depot activity
- trucks
- containers
- workers
- lifting equipment
- traffic routes
- housekeeping
- PPE
- work at height
- electrical equipment
- fire safety
- storage
- other workplace conditions

Your task is to identify safety checks that are relevant
to what is actually visible in the photograph.

IMPORTANT SAFETY RULES:

1. Only report things that are visible or reasonably supported
   by the photograph.

2. Do not invent hazards.

3. Do not assume that something is unsafe just because it
   cannot be seen.

4. If the photograph is insufficient to determine whether
   something is safe, use CHECK_REQUIRED.

5. Use FAIL only when a clearly unsafe condition is visible.

6. Use PASS only when there is reasonable visual evidence
   that the particular condition is satisfactory.

7. Do not claim that the whole workplace is compliant.

8. Do not claim legal compliance based only on one photograph.

9. Do not invent a WSH requirement.

10. Match the finding to the supplied safety check library
    whenever possible.

11. If no relevant safety check exists, use:
    check_id = ""

12. Maximum 8 findings.

13. Avoid duplicate findings.

14. Keep observations factual and concise.

15. Confidence must be between 0 and 1.

16. If no meaningful safety issue can be determined,
    return CHECK_REQUIRED rather than inventing a problem.

EXAMPLES:

If a worker is clearly wearing a safety helmet:
- PPE may be PASS.

However, do not conclude that all PPE requirements
are satisfied.

If a vehicle and pedestrian are visibly sharing an unsafe
space:
- Vehicular Safety may be FAIL.

If a guardrail is visible but its condition cannot be
confirmed:
- use CHECK_REQUIRED.

If there is visible oil or liquid on a walking/working area:
- Housekeeping may be FAIL.

If a lifting operation is visible:
- assess only what can actually be seen.

If a crane or lifting machine is present but there is
no visible unsafe condition:
- do not automatically report FAIL.

WSH SAFETY CHECK LIBRARY:

${buildSafetyCheckText(checks)}

RETURN ONLY JSON.

The JSON must have this exact structure:

{
  "scene_summary": "Brief description of the visible scene.",
  "findings": [
    {
      "category": "PPE",
      "title": "Short finding title",
      "observation": "What is visibly observed.",
      "status": "PASS",
      "risk_level": "LOW",
      "confidence": 0.90,
      "check_id": "matching check ID",
      "source_title": "WSH source",
      "source_url": "WSH source URL"
    }
  ]
}

Allowed status values:

PASS
FAIL
CHECK_REQUIRED

Allowed risk values:

LOW
MEDIUM
HIGH

Do not use Markdown.
Do not use code fences.
Do not add text before the JSON.
Do not add text after the JSON.
`;
}


/*
 * ============================================================
 * EXTRACT AI RESPONSE TEXT
 * ============================================================
 *
 * Cloudflare's current Llama Vision synchronous output
 * is normally:
 *
 * {
 *   "response": "..."
 * }
 *
 * ============================================================
 */

function extractAIResponseText(
  result: unknown
): string {

  if (
    typeof result === "string"
  ) {
    return result;
  }


  if (
    !result ||
    typeof result !== "object"
  ) {
    return "";
  }


  const object =
    result as Record<
      string,
      unknown
    >;


  /*
   * Normal Workers AI response.
   */

  if (
    typeof object.response ===
    "string"
  ) {

    return object.response;
  }


  /*
   * Some runtimes may return result.
   */

  if (
    typeof object.result ===
    "string"
  ) {

    return object.result;
  }


  /*
   * Some wrappers use text.
   */

  if (
    typeof object.text ===
    "string"
  ) {

    return object.text;
  }


  return "";
}


/*
 * ============================================================
 * CLEAN AI JSON
 * ============================================================
 */

function cleanAIText(
  text: string
): string {

  let result =
    text.trim();


  /*
   * Remove code fences.
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


/*
 * ============================================================
 * PARSE JSON FROM AI
 * ============================================================
 */

function parseAIJSON(
  text: string
): unknown {

  const cleaned =
    cleanAIText(text);


  /*
   * First try the whole response.
   */

  try {

    return JSON.parse(
      cleaned
    );

  } catch {
    // Continue.
  }


  /*
   * Find JSON object inside text.
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
    "Workers AI did not return valid JSON."
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
   * If response itself is a JSON string.
   */

  if (
    typeof object ===
    "string"
  ) {

    object =
      parseAIJSON(
        object
      );
  }


  /*
   * If result contains response.
   */

  if (
    object &&
    typeof object ===
    "object" &&
    typeof object.response ===
    "string"
  ) {

    object =
      parseAIJSON(
        object.response
      );
  }


  if (
    !object ||
    typeof object !==
      "object"
  ) {

    throw new Error(
      "Invalid AI result."
    );
  }


  const rawFindings =
    Array.isArray(
      object.findings
    )
      ? object.findings
      : [];


  const findings:
    Finding[] = [];


  for (
    const rawFinding
    of rawFindings.slice(
      0,
      8
    )
  ) {

    if (
      !rawFinding ||
      typeof rawFinding !==
        "object"
    ) {
      continue;
    }


    const raw =
      rawFinding as Record<
        string,
        unknown
      >;


    const title =
      cleanString(
        raw.title,
        "Safety observation"
      );


    const observation =
      cleanString(
        raw.observation,
        "Physical/site verification required."
      );


    findings.push({

      category:
        normalizeCategory(
          raw.category
        ),

      title,

      observation,

      status:
        normalizeStatus(
          raw.status
        ),

      risk_level:
        normalizeRisk(
          raw.risk_level
        ),

      confidence:
        clampConfidence(
          raw.confidence
        ),

      check_id:
        cleanString(
          raw.check_id
        ),

      source_title:
        cleanString(
          raw.source_title,
          "WSH Council"
        ),

      source_url:
        cleanString(
          raw.source_url,
          WSH_DEFAULT_URL
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
 * RUN VISION AI
 * ============================================================
 *
 * IMPORTANT:
 *
 * No response_format.
 * No JSON schema.
 *
 * We first make the basic Vision request work.
 *
 * Cloudflare documentation shows:
 *
 * const response = await env.AI.run(
 *   "@cf/meta/llama-3.2-11b-vision-instruct",
 *   {
 *     messages,
 *     image: imageBase64
 *   }
 * );
 *
 * ============================================================
 */

async function runVisionAI(
  env: Env,
  image: string,
  prompt: string
): Promise<AIResult> {

  const messages = [

    {
      role: "system",

      content:
        "You are a careful Singapore workplace safety inspection assistant. Return ONLY valid JSON.",

    },

    {
      role: "user",

      content:
        prompt,

    },

  ];


  /*
   * This is the documented Cloudflare Vision format.
   */

  const aiInput = {

    messages,

    image,

    temperature:
      0.1,

    max_tokens:
      1800,

    top_p:
      0.9,

  };


  console.log(
    "Calling Workers AI Vision model..."
  );


  let response: unknown;


  try {

    response =
      await env.AI.run(
        MODEL,
        aiInput as any
      );

  } catch (error) {

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    throw new Error(
      `Workers AI request failed: ${message}`
    );
  }


  console.log(
    "Workers AI response received."
  );


  /*
   * Get the actual generated text.
   */

  const text =
    extractAIResponseText(
      response
    );


  if (!text) {

    throw new Error(
      "Workers AI returned no response text. Raw response: " +
      JSON.stringify(response).substring(
        0,
        3000
      )
    );
  }


  console.log(
    "Workers AI response length:",
    text.length
  );


  /*
   * Parse JSON.
   */

  try {

    const parsed =
      parseAIJSON(
        text
      );

    return normalizeAIResult(
      parsed
    );

  } catch (error) {

    /*
     * Return the actual model response in the
     * error. This is important for the next
     * troubleshooting step if the model does
     * not obey the JSON instruction.
     */

    const detail =
      error instanceof Error
        ? error.message
        : String(error);


    throw new Error(
      `${detail} Model response: ${text.substring(
        0,
        4000
      )}`
    );
  }
}


/*
 * ============================================================
 * MATCH FINDING TO WSH CHECK
 * ============================================================
 */

function matchSafetyCheck(
  finding: Finding,
  checks: SafetyCheck[]
): SafetyCheck | null {

  /*
   * 1. Exact ID.
   */

  if (
    finding.check_id
  ) {

    const exact =
      checks.find(
        check =>
          check.id ===
          finding.check_id
      );

    if (exact) {
      return exact;
    }
  }


  /*
   * 2. Category.
   */

  const category =
    finding.category
      .toLowerCase();


  const categoryMatch =
    checks.find(
      check =>
        check.category
          .toLowerCase() ===
        category
    );


  if (
    categoryMatch
  ) {
    return categoryMatch;
  }


  /*
   * 3. Keywords.
   */

  const searchText =
    (
      finding.title +
      " " +
      finding.observation
    )
      .toLowerCase();


  let best:
    SafetyCheck | null =
    null;

  let bestScore =
    0;


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
          keyword =>
            keyword.trim()
        )
        .filter(Boolean);


    let score =
      0;


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
      score >
      bestScore
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
 * CALCULATE OVERALL RESULT
 * ============================================================
 */

function calculateOverall(
  findings: Finding[]
): string {

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


/*
 * ============================================================
 * CREATE INSPECTION
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
    "SI-" +
    new Date()
      .toISOString()
      .slice(
        0,
        10
      )
      .replaceAll(
        "-",
        ""
      ) +
    "-" +
    crypto
      .randomUUID()
      .replaceAll(
        "-",
        ""
      )
      .slice(
        0,
        6
      )
      .toUpperCase();


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


  const values:
    Record<
      string,
      unknown
    > = {};


  if (
    columns.includes("id")
  ) {
    values.id =
      id;
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
      location;
  }


  if (
    columns.includes(
      "inspector"
    )
  ) {

    values.inspector =
      inspector;
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


  if (
    columns.includes(
      "status"
    ) &&
    !(
      "overall_result"
      in values
    )
  ) {

    values.status =
      "CHECK_REQUIRED";
  }


  const names =
    Object.keys(
      values
    );


  if (!names.length) {

    throw new Error(
      "No usable columns were found in inspections."
    );
  }


  const placeholders =
    names
      .map(
        () => "?"
      )
      .join(", ");


  const sql =
    `
    INSERT INTO inspections
    (${names.join(", ")})
    VALUES
    (${placeholders})
    `;


  await db
    .prepare(sql)
    .bind(
      ...names.map(
        name =>
          values[name]
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


  const values:
    Record<
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
      "filename"
    ) &&
    !(
      "file_name"
      in values
    )
  ) {

    values.filename =
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
      "mime_type"
    ) &&
    !(
      "content_type"
      in values
    )
  ) {

    values.mime_type =
      contentType;
  }


  if (
    columns.includes(
      "object_key"
    )
  ) {

    values.object_key =
      `inspection/${inspectionId}/${photoId}`;
  }


  if (
    columns.includes(
      "created_at"
    )
  ) {

    values.created_at =
      nowISO();
  }


  const names =
    Object.keys(
      values
    );


  if (!names.length) {

    throw new Error(
      "No usable columns were found in inspection_photos."
    );
  }


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
      VALUES
      (${placeholders})
      `
    )
    .bind(
      ...names.map(
        name =>
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
 * YOUR ACTUAL TABLE:
 *
 * inspection_items
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
  findings: Finding[],
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


    const id =
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
      WSH_DEFAULT_URL;


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
        id,
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

async function handleAnalyse(
  request: Request,
  env: Env
): Promise<Response> {

  let body:
    AnalyseRequest;


  /*
   * ----------------------------------------------------------
   * JSON REQUEST
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
   * VALIDATE IMAGE
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


  /*
   * ----------------------------------------------------------
   * FORM DATA
   * ----------------------------------------------------------
   */

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
   * IMAGE
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
   * CHECK IMAGE SIZE
   * ----------------------------------------------------------
   */

  if (
    image.length >
    15_000_000
  ) {

    return jsonResponse(
      {
        success: false,

        error:
          "Image is too large. Please select a smaller photo."
      },
      413
    );
  }


  /*
   * ----------------------------------------------------------
   * LOAD WSH CHECKS
   * ----------------------------------------------------------
   */

  const checks =
    await loadSafetyChecks(
      env.SAFETY_DB
    );


  /*
   * ----------------------------------------------------------
   * CREATE INSPECTION
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
   * SAVE PHOTO RECORD
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
      "PHOTO RECORD ERROR:",
      error
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
   * PROMPT
   * ----------------------------------------------------------
   */

  const prompt =
    buildAIPrompt(
      checks
    );


  /*
   * ----------------------------------------------------------
   * RUN VISION AI
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
   * MATCH FINDINGS TO WSH CHECKS
   * ----------------------------------------------------------
   */

  const findings =
    aiResult.findings.map(
      finding => {

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
            WSH_DEFAULT_URL,

        };
      }
    );


  /*
   * ----------------------------------------------------------
   * OVERALL RESULT
   * ----------------------------------------------------------
   */

  const overall =
    calculateOverall(
      findings
    );


  /*
   * ----------------------------------------------------------
   * SAVE INSPECTION ITEMS
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

    const detail =
      error instanceof Error
        ? error.message
        : String(error);


    console.error(
      "INSPECTION ITEMS ERROR:",
      detail
    );


    return jsonResponse(
      {
        success: false,

        error:
          "AI analysis completed but the result could not be saved.",

        detail,

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
   * UPDATE INSPECTION
   * ----------------------------------------------------------
   */

  try {

    await updateInspection(
      env.SAFETY_DB,
      inspection.id,
      overall
    );

  } catch (error) {

    console.error(
      "INSPECTION UPDATE ERROR:",
      error
    );
  }


  /*
   * ----------------------------------------------------------
   * RETURN RESULT
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
          overall,

      },

      summary:
        aiResult.scene_summary,

      findings,

    },
    200
  );
}


/*
 * ============================================================
 * RECENT INSPECTIONS
 * ============================================================
 */

async function handleRecentInspections(
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


    return jsonResponse(
      {
        success: true,

        inspections:
          result.results ||
          [],
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
 * SINGLE INSPECTION
 * ============================================================
 */

async function handleSingleInspection(
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
          items.results ||
          [],

        photos:
          photos.results ||
          [],
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
 * SAFETY CHECK API
 * ============================================================
 */

async function handleSafetyChecks(
  db: D1Database
): Promise<Response> {

  const checks =
    await loadSafetyChecks(
      db
    );


  return jsonResponse(
    {
      success: true,

      count:
        checks.length,

      checks,
    }
  );
}


/*
 * ============================================================
 * HEALTH
 * ============================================================
 */

async function handleHealth(
  db: D1Database
): Promise<Response> {

  let database =
    false;

  let safetyChecks =
    0;


  try {

    await db
      .prepare(
        "SELECT 1"
      )
      .first();

    database =
      true;


    const checks =
      await loadSafetyChecks(
        db
      );

    safetyChecks =
      checks.length;

  } catch {

    database =
      false;
  }


  return jsonResponse(
    {
      success: true,

      service:
        "Depot Safety Inspection AI",

      status:
        "running",

      model:
        MODEL,

      database,

      safety_checks:
        safetyChecks,

      vectorize:
        false,

      timestamp:
        nowISO(),
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

    return handleHealth(
      env.SAFETY_DB
    );
  }


  /*
   * ----------------------------------------------------------
   * ANALYZE
   * ----------------------------------------------------------
   *
   * American spelling.
   * ----------------------------------------------------------
   */

  if (
    path ===
      "/api/analyze" &&
    request.method ===
      "POST"
  ) {

    return handleAnalyse(
      request,
      env
    );
  }


  /*
   * ----------------------------------------------------------
   * ANALYSE
   * ----------------------------------------------------------
   *
   * British spelling.
   * ----------------------------------------------------------
   */

  if (
    path ===
      "/api/analyse" &&
    request.method ===
      "POST"
  ) {

    return handleAnalyse(
      request,
      env
    );
  }


  /*
   * ----------------------------------------------------------
   * EXTRA COMPATIBILITY ROUTES
   * ----------------------------------------------------------
   */

  if (
    (
      path ===
        "/api/analyze-photo" ||

      path ===
        "/api/analyse-photo"
    ) &&
    request.method ===
      "POST"
  ) {

    return handleAnalyse(
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

    return handleRecentInspections(
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


    return handleSingleInspection(
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

    return handleSafetyChecks(
      env.SAFETY_DB
    );
  }


  /*
   * ----------------------------------------------------------
   * ROOT
   * ----------------------------------------------------------
   */

  if (
    path === "/" &&
    request.method ===
      "GET"
  ) {

    return jsonResponse(
      {
        success: true,

        service:
          "Depot Safety Inspection AI",

        status:
          "running",

        model:
          MODEL,

        endpoints: [

          "GET /api/health",

          "POST /api/analyze",

          "POST /api/analyse",

          "GET /api/inspections",

          "GET /api/safety-checks",

        ],
      }
    );
  }


  /*
   * ----------------------------------------------------------
   * NOT FOUND
   * ----------------------------------------------------------
   *
   * Include path/method so we can immediately see
   * what the frontend is requesting.
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

        "GET /api/safety-checks",

      ],
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
            corsHeaders(),
        }
      );
    }


    /*
     * Route request.
     */

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

          detail,
        },
        500
      );
    }
  },

} satisfies ExportedHandler<Env>;
