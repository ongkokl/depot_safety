/*
 * Safety Inspection AI
 * Cloudflare Worker
 *
 * Uses:
 *   - Workers AI
 *   - D1
 *
 * Does NOT require Vectorize.
 *
 * Current D1 tables expected:
 *
 * inspections
 *   id
 *   inspection_no
 *   location
 *   inspector
 *   created_at
 *   overall_result
 *
 * inspection_photos
 *   id
 *   inspection_id
 *   object_key
 *   file_name
 *   content_type
 *   created_at
 *
 * findings
 *   id
 *   inspection_id
 *   photo_id
 *   category
 *   title
 *   observation
 *   status
 *   risk_level
 *   confidence
 *   check_id
 *   source_title
 *   source_url
 *   created_at
 *
 * safety_checks
 *   id
 *   category
 *   check_question
 *   guidance
 *   source_title
 *   source_url
 *   keywords
 *   active
 *
 * corrective_actions
 *   id
 *   finding_id
 *   description
 *   responsible_person
 *   due_date
 *   status
 *   created_at
 *   completed_at
 */

export interface Env {
  AI: {
    run: (
      model: string,
      input: Record<string, unknown>
    ) => Promise<any>;
  };

  SAFETY_DB: D1Database;
}


/* =========================================================
   CONSTANTS
   ========================================================= */

const MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const ALLOWED_CATEGORIES = [
  "PPE",
  "Work at Height",
  "Lifting",
  "Vehicular Safety",
  "Housekeeping",
  "Other",
];

const ALLOWED_STATUS = [
  "PASS",
  "CHECK_REQUIRED",
  "FAIL",
];

const ALLOWED_RISK = [
  "LOW",
  "MEDIUM",
  "HIGH",
];


/* =========================================================
   UTILITY FUNCTIONS
   ========================================================= */

function json(
  data: unknown,
  status = 200
): Response {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "cache-control": "no-store",
      },
    }
  );
}


function text(
  value: unknown
): string {
  if (value === null || value === undefined) {
    return "";
  }

  return String(value).trim();
}


function generateId(): string {
  return crypto.randomUUID();
}


function inspectionNumber(): string {
  const now = new Date();

  const year = now.getUTCFullYear();

  const month = String(
    now.getUTCMonth() + 1
  ).padStart(2, "0");

  const day = String(
    now.getUTCDate()
  ).padStart(2, "0");

  const random = crypto
    .randomUUID()
    .replace(/-/g, "")
    .substring(0, 6)
    .toUpperCase();

  return `SI-${year}${month}${day}-${random}`;
}


function clampConfidence(
  value: unknown
): number {
  let n = Number(value);

  if (!Number.isFinite(n)) {
    return 0.5;
  }

  /*
   * Support either:
   *
   * 0.95
   * or
   * 95
   */

  if (n > 1) {
    n = n / 100;
  }

  if (n < 0) {
    n = 0;
  }

  if (n > 1) {
    n = 1;
  }

  return Number(n.toFixed(3));
}


function normaliseStatus(
  value: unknown
): string {
  const s = text(value)
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (s === "PASS") {
    return "PASS";
  }

  if (
    s === "FAIL" ||
    s === "FAILED"
  ) {
    return "FAIL";
  }

  return "CHECK_REQUIRED";
}


function normaliseRisk(
  value: unknown
): string {
  const s = text(value).toUpperCase();

  if (s === "LOW") {
    return "LOW";
  }

  if (s === "HIGH") {
    return "HIGH";
  }

  return "MEDIUM";
}


function normaliseCategory(
  value: unknown
): string {
  const s = text(value);

  for (const category of ALLOWED_CATEGORIES) {
    if (
      s.toLowerCase() ===
      category.toLowerCase()
    ) {
      return category;
    }
  }

  return "Other";
}


/* =========================================================
   IMAGE HANDLING
   ========================================================= */

function dataUrl(
  bytes: ArrayBuffer,
  contentType: string
): string {
  const bytesArray = new Uint8Array(bytes);

  let binary = "";

  const chunkSize = 0x8000;

  for (
    let i = 0;
    i < bytesArray.length;
    i += chunkSize
  ) {
    const chunk = bytesArray.subarray(
      i,
      Math.min(
        i + chunkSize,
        bytesArray.length
      )
    );

    binary += String.fromCharCode(...chunk);
  }

  const base64 = btoa(binary);

  return `data:${contentType};base64,${base64}`;
}


/* =========================================================
   WSH SAFETY CHECKS
   ========================================================= */

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


async function getSafetyChecks(
  db: D1Database
): Promise<SafetyCheck[]> {

  const result = await db
    .prepare(`
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
    `)
    .all<SafetyCheck>();

  return result.results || [];
}


/* =========================================================
   BUILD WSH GUIDANCE FOR AI
   ========================================================= */

function buildGuidanceText(
  checks: SafetyCheck[]
): string {

  if (!checks.length) {
    return `
No safety_checks records are currently available.

Use conservative visual safety assessment.
Do not invent WSH requirements.
`;
  }

  return checks
    .map((check, index) => {

      return `
WSH CHECK ${index + 1}

ID:
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
    })
    .join("\n-----------------------------\n");
}


/* =========================================================
   AI PROMPT
   ========================================================= */

function buildVisionPrompt(
  guidance: string
): string {

  return `
You are an AI assistant supporting a workplace safety inspection.

The photograph is from a Singapore workplace / depot / container terminal environment.

Your job is to identify ONLY safety conditions that can reasonably be observed from the photograph.

Use the WSH safety checks supplied below as guidance.

IMPORTANT:

1. Do not invent hazards.
2. Do not assume something is unsafe merely because it cannot be seen.
3. If something important cannot be confirmed from the photograph, use CHECK_REQUIRED.
4. Use FAIL only when an unsafe condition is clearly visible.
5. Use PASS only when the relevant condition is visibly satisfactory.
6. A visible hard hat should normally be treated as PPE PASS if the person is clearly wearing it.
7. A visible high-visibility vest should normally be treated as PPE PASS if clearly visible.
8. A guardrail that is visibly present must NOT be reported as "missing".
9. A crane in the background does NOT automatically mean the worker is exposed to a suspended load.
10. Do not assume a person is working at height merely because a guardrail is visible.
11. Do not classify a hazard when the photograph does not provide enough evidence.
12. Maximum 6 findings.
13. Prefer specific observations over generic safety statements.
14. Confidence must represent confidence in the visual observation.
15. WSH checks should be linked to the supplied safety_checks whenever reasonably applicable.

RETURN ONLY JSON.

DO NOT return Markdown.

DO NOT return a code fence.

DO NOT write an explanation before or after the JSON.

Use exactly this JSON structure:

{
  "summary": "Short description of the workplace scene",
  "findings": [
    {
      "category": "PPE",
      "title": "Short finding title",
      "observation": "What is visibly observed",
      "status": "PASS",
      "risk_level": "LOW",
      "confidence": 0.95,
      "check_id": "matching safety check ID or empty string"
    }
  ]
}

Allowed categories:

PPE
Work at Height
Lifting
Vehicular Safety
Housekeeping
Other

Allowed status:

PASS
CHECK_REQUIRED
FAIL

Allowed risk levels:

LOW
MEDIUM
HIGH

Only include a finding when there is useful safety information.

If there is no clear hazard but a safety item should be verified, use CHECK_REQUIRED.

WSH SAFETY GUIDANCE:

${guidance}
`;
}


/* =========================================================
   AI RESPONSE EXTRACTION
   ========================================================= */

function getAIText(
  response: any
): string {

  if (response === null ||
      response === undefined) {
    return "";
  }

  if (typeof response === "string") {
    return response;
  }

  /*
   * Common Workers AI response:
   *
   * {
   *   response: "..."
   * }
   */

  if (
    typeof response.response === "string"
  ) {
    return response.response;
  }

  if (
    response.result &&
    typeof response.result.response === "string"
  ) {
    return response.result.response;
  }

  if (
    response.result &&
    typeof response.result === "string"
  ) {
    return response.result;
  }

  if (
    typeof response.output === "string"
  ) {
    return response.output;
  }

  /*
   * Some models may return text
   * inside a message.
   */

  if (
    response.message &&
    typeof response.message.content === "string"
  ) {
    return response.message.content;
  }

  return "";
}


/* =========================================================
   JSON CLEANING
   ========================================================= */

function cleanAIText(
  raw: string
): string {

  let value = raw.trim();

  /*
   * Remove Markdown code fences.
   */

  value = value.replace(
    /^```(?:json)?\s*/i,
    ""
  );

  value = value.replace(
    /\s*```$/i,
    ""
  );

  value = value.trim();

  return value;
}


function extractJSONObject(
  raw: string
): string | null {

  const cleaned = cleanAIText(raw);

  /*
   * First try the entire response.
   */

  if (
    cleaned.startsWith("{") &&
    cleaned.endsWith("}")
  ) {
    return cleaned;
  }

  /*
   * Sometimes the model returns:
   *
   * Here is the JSON:
   * {...}
   */

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (
    first >= 0 &&
    last > first
  ) {
    return cleaned.substring(
      first,
      last + 1
    );
  }

  return null;
}


/* =========================================================
   PARSE AI JSON
   ========================================================= */

interface AIResult {
  summary: string;
  findings: any[];
  structured: boolean;
  raw: string;
}


function parseAIResponse(
  response: any
): AIResult {

  const raw = getAIText(response);

  if (!raw) {
    return {
      summary:
        "The AI did not return a usable observation.",
      findings: [],
      structured: false,
      raw: "",
    };
  }

  const jsonText =
    extractJSONObject(raw);

  if (!jsonText) {

    /*
     * IMPORTANT:
     *
     * Do not fail the whole inspection.
     *
     * Save the model response as
     * a CHECK_REQUIRED finding.
     */

    return {
      summary:
        "The AI returned an unstructured observation.",
      findings: [
        {
          category: "Other",
          title:
            "AI observation requires review",
          observation: raw,
          status: "CHECK_REQUIRED",
          risk_level: "MEDIUM",
          confidence: 0.5,
          check_id: "",
        },
      ],
      structured: false,
      raw,
    };
  }

  try {

    const parsed =
      JSON.parse(jsonText);

    /*
     * Sometimes model returns:
     *
     * {
     *   response: {
     *     summary: ...
     *   }
     * }
     */

    const data =
      parsed?.response &&
      typeof parsed.response === "object"
        ? parsed.response
        : parsed;

    const summary =
      text(data.summary) ||
      "Workplace scene analysed.";

    const findings =
      Array.isArray(data.findings)
        ? data.findings
        : [];

    return {
      summary,
      findings,
      structured: true,
      raw,
    };

  } catch (error) {

    /*
     * JSON.parse failure must NOT
     * cause the whole inspection to fail.
     */

    return {
      summary:
        "The AI returned an observation that requires review.",
      findings: [
        {
          category: "Other",
          title:
            "AI analysis requires review",
          observation: raw,
          status: "CHECK_REQUIRED",
          risk_level: "MEDIUM",
          confidence: 0.5,
          check_id: "",
        },
      ],
      structured: false,
      raw,
    };
  }
}


/* =========================================================
   MATCH SAFETY CHECK
   ========================================================= */

function findBestSafetyCheck(
  finding: any,
  checks: SafetyCheck[]
): SafetyCheck | null {

  const requestedId =
    text(finding.check_id);

  if (requestedId) {

    const exact =
      checks.find(
        c => c.id === requestedId
      );

    if (exact) {
      return exact;
    }
  }

  const category =
    normaliseCategory(
      finding.category
    ).toLowerCase();

  const title =
    text(finding.title)
      .toLowerCase();

  const observation =
    text(finding.observation)
      .toLowerCase();

  const combined =
    `${category} ${title} ${observation}`;

  /*
   * Score keyword/category matches.
   */

  let best:
    SafetyCheck | null = null;

  let bestScore = 0;

  for (const check of checks) {

    let score = 0;

    if (
      check.category
        .toLowerCase() === category
    ) {
      score += 5;
    }

    const keywords =
      text(check.keywords)
        .toLowerCase()
        .split(/[,\s;|]+/)
        .filter(Boolean);

    for (const keyword of keywords) {

      if (
        keyword.length >= 3 &&
        combined.includes(keyword)
      ) {
        score += 1;
      }
    }

    const questionWords =
      check.check_question
        .toLowerCase()
        .split(/\s+/)
        .filter(
          word => word.length >= 5
        );

    for (const word of questionWords) {

      if (
        combined.includes(
          word.replace(
            /[^a-z0-9]/g,
            ""
          )
        )
      ) {
        score += 0.25;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = check;
    }
  }

  return best;
}


/* =========================================================
   NORMALISE FINDING
   ========================================================= */

function normaliseFinding(
  raw: any,
  checks: SafetyCheck[]
): any {

  const category =
    normaliseCategory(
      raw?.category
    );

  const title =
    text(raw?.title) ||
    "Safety condition requires review";

  const observation =
    text(raw?.observation) ||
    "The photograph requires physical verification.";

  const status =
    normaliseStatus(
      raw?.status
    );

  const risk =
    normaliseRisk(
      raw?.risk_level
    );

  const confidence =
    clampConfidence(
      raw?.confidence
    );

  const check =
    findBestSafetyCheck(
      {
        ...raw,
        category,
        title,
        observation,
      },
      checks
    );

  return {
    category,
    title,
    observation,
    status,
    risk_level: risk,
    confidence,

    check_id:
      text(raw?.check_id) ||
      check?.id ||
      null,

    source_title:
      check?.source_title ||
      null,

    source_url:
      check?.source_url ||
      null,

    wsh_check:
      check?.check_question ||
      null,

    guidance:
      check?.guidance ||
      null,
  };
}


/* =========================================================
   OVERALL RESULT
   ========================================================= */

function calculateOverallResult(
  findings: any[]
): string {

  if (
    findings.some(
      f => f.status === "FAIL"
    )
  ) {
    return "FAIL";
  }

  if (
    findings.some(
      f =>
        f.status ===
        "CHECK_REQUIRED"
    )
  ) {
    return "CHECK_REQUIRED";
  }

  return "PASS";
}


/* =========================================================
   SAVE INSPECTION
   ========================================================= */

async function saveInspection(
  db: D1Database,
  params: {
    inspectionId: string;
    inspectionNo: string;
    location: string;
    inspector: string;
    createdAt: string;
    overallResult: string;
  }
) {

  await db
    .prepare(`
      INSERT INTO inspections
      (
        id,
        inspection_no,
        location,
        inspector,
        created_at,
        overall_result
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(
      params.inspectionId,
      params.inspectionNo,
      params.location,
      params.inspector,
      params.createdAt,
      params.overallResult
    )
    .run();
}


/* =========================================================
   SAVE PHOTO
   ========================================================= */

async function savePhotoRecord(
  db: D1Database,
  params: {
    photoId: string;
    inspectionId: string;
    fileName: string;
    contentType: string;
  }
) {

  /*
   * There is currently no R2 requirement.
   *
   * object_key is populated with the photo ID.
   */

  await db
    .prepare(`
      INSERT INTO inspection_photos
      (
        id,
        inspection_id,
        object_key,
        file_name,
        content_type,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(
      params.photoId,
      params.inspectionId,
      params.photoId,
      params.fileName,
      params.contentType,
      new Date().toISOString()
    )
    .run();
}


/* =========================================================
   SAVE FINDINGS
   ========================================================= */

async function saveFindings(
  db: D1Database,
  inspectionId: string,
  photoId: string,
  findings: any[]
) {

  for (const finding of findings) {

    const findingId =
      generateId();

    await db
      .prepare(`
        INSERT INTO findings
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        findingId,
        inspectionId,
        photoId,
        finding.category,
        finding.title,
        finding.observation,
        finding.status,
        finding.risk_level,
        finding.confidence,
        finding.check_id,
        finding.source_title,
        finding.source_url,
        new Date().toISOString()
      )
      .run();
  }
}


/* =========================================================
   FORMAT RESPONSE FINDING
   ========================================================= */

function publicFinding(
  finding: any
) {

  return {
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

    wsh_check:
      finding.wsh_check,

    guidance:
      finding.guidance,

    source_title:
      finding.source_title,

    source_url:
      finding.source_url,
  };
}


/* =========================================================
   ANALYSE PHOTO
   ========================================================= */

async function analysePhoto(
  request: Request,
  env: Env
): Promise<Response> {

  const form =
    await request.formData();

  const file =
    form.get("photo") ||
    form.get("image") ||
    form.get("file");

  const location =
    text(
      form.get("location")
    );

  const inspector =
    text(
      form.get("inspector")
    );

  if (!(file instanceof File)) {

    return json(
      {
        success: false,
        error:
          "Please upload an image.",
      },
      400
    );
  }

  if (
    !file.type.startsWith(
      "image/"
    )
  ) {

    return json(
      {
        success: false,
        error:
          "Only image files are supported.",
      },
      400
    );
  }

  if (
    file.size >
    MAX_IMAGE_BYTES
  ) {

    return json(
      {
        success: false,
        error:
          "Image is too large. Maximum size is 8 MB.",
      },
      413
    );
  }


  /* -------------------------------------------------------
     Load WSH safety checks
     ------------------------------------------------------- */

  const safetyChecks =
    await getSafetyChecks(
      env.SAFETY_DB
    );

  const guidance =
    buildGuidanceText(
      safetyChecks
    );


  /* -------------------------------------------------------
     Convert image to data URL
     ------------------------------------------------------- */

  const imageBytes =
    await file.arrayBuffer();

  const image =
    dataUrl(
      imageBytes,
      file.type ||
        "image/jpeg"
    );


  /* -------------------------------------------------------
     Build AI prompt
     ------------------------------------------------------- */

  const prompt =
    buildVisionPrompt(
      guidance
    );


  /* -------------------------------------------------------
     Call Workers AI
     ------------------------------------------------------- */

  let aiResponse: any;

  try {

    aiResponse =
      await env.AI.run(
        MODEL,
        {
          prompt,
          image,

          /*
           * Keep generation deterministic.
           */

          temperature: 0.1,

          max_tokens: 1800,

          top_p: 0.9,

          /*
           * Also provide messages.
           * This is supported by the current
           * Workers AI vision examples.
           */

          messages: [
            {
              role: "system",
              content:
                "You are a workplace safety inspection assistant. Return valid JSON only.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
        }
      );

  } catch (error) {

    console.error(
      "Workers AI error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Workers AI analysis failed.",
        detail:
          error instanceof Error
            ? error.message
            : String(error),
      },
      502
    );
  }


  /* -------------------------------------------------------
     Parse AI response
     ------------------------------------------------------- */

  const parsed =
    parseAIResponse(
      aiResponse
    );


  /* -------------------------------------------------------
     Normalise findings
     ------------------------------------------------------- */

  let findings =
    parsed.findings
      .slice(0, 6)
      .map(
        finding =>
          normaliseFinding(
            finding,
            safetyChecks
          )
      );


  /*
   * If AI returns no findings,
   * create a review item rather than
   * creating an empty inspection.
   */

  if (!findings.length) {

    findings = [
      {
        category: "Other",
        title:
          "No clear safety finding returned",
        observation:
          "The photograph was analysed, but no specific safety condition could be reliably classified. Physical verification is required.",
        status:
          "CHECK_REQUIRED",
        risk_level:
          "MEDIUM",
        confidence:
          0.5,
        check_id:
          null,
        source_title:
          null,
        source_url:
          null,
        wsh_check:
          null,
        guidance:
          null,
      },
    ];
  }


  /* -------------------------------------------------------
     Overall result
     ------------------------------------------------------- */

  const overallResult =
    calculateOverallResult(
      findings
    );


  /* -------------------------------------------------------
     Create IDs
     ------------------------------------------------------- */

  const inspectionId =
    generateId();

  const photoId =
    generateId();

  const inspectionNo =
    inspectionNumber();

  const createdAt =
    new Date().toISOString();


  /* -------------------------------------------------------
     Save D1 records
     ------------------------------------------------------- */

  try {

    await saveInspection(
      env.SAFETY_DB,
      {
        inspectionId,
        inspectionNo,
        location:
          location ||
          "Unspecified",
        inspector:
          inspector ||
          "Unspecified",
        createdAt,
        overallResult,
      }
    );


    await savePhotoRecord(
      env.SAFETY_DB,
      {
        photoId,
        inspectionId,
        fileName:
          file.name ||
          "inspection-photo",
        contentType:
          file.type ||
          "image/jpeg",
      }
    );


    await saveFindings(
      env.SAFETY_DB,
      inspectionId,
      photoId,
      findings
    );

  } catch (error) {

    console.error(
      "D1 save error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Inspection analysis completed but could not be saved to the database.",
        detail:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }


  /* -------------------------------------------------------
     Return result
     ------------------------------------------------------- */

  return json(
    {
      success: true,

      inspection: {
        id:
          inspectionId,

        inspection_no:
          inspectionNo,

        location:
          location ||
          "Unspecified",

        inspector:
          inspector ||
          "Unspecified",

        created_at:
          createdAt,

        overall_result:
          overallResult,
      },

      summary:
        parsed.summary,

      structured:
        parsed.structured,

      findings:
        findings.map(
          publicFinding
        ),

      model:
        MODEL,
    }
  );
}


/* =========================================================
   GET RECENT INSPECTIONS
   ========================================================= */

async function getRecentInspections(
  env: Env
): Promise<Response> {

  try {

    const result =
      await env.SAFETY_DB
        .prepare(`
          SELECT
            i.id,
            i.inspection_no,
            i.location,
            i.inspector,
            i.created_at,
            i.overall_result,

            COUNT(f.id) AS finding_count,

            SUM(
              CASE
                WHEN f.status = 'FAIL'
                THEN 1
                ELSE 0
              END
            ) AS fail_count,

            SUM(
              CASE
                WHEN f.status = 'CHECK_REQUIRED'
                THEN 1
                ELSE 0
              END
            ) AS check_count

          FROM inspections i

          LEFT JOIN findings f
            ON f.inspection_id = i.id

          GROUP BY
            i.id,
            i.inspection_no,
            i.location,
            i.inspector,
            i.created_at,
            i.overall_result

          ORDER BY
            i.created_at DESC

          LIMIT 20
        `)
        .all();

    return json(
      {
        success: true,
        inspections:
          result.results || [],
      }
    );

  } catch (error) {

    console.error(
      "Recent inspections error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Unable to load recent inspections.",
        detail:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}


/* =========================================================
   GET INSPECTION DETAIL
   ========================================================= */

async function getInspection(
  env: Env,
  id: string
): Promise<Response> {

  try {

    const inspection =
      await env.SAFETY_DB
        .prepare(`
          SELECT
            id,
            inspection_no,
            location,
            inspector,
            created_at,
            overall_result
          FROM inspections
          WHERE id = ?
          LIMIT 1
        `)
        .bind(id)
        .first();


    if (!inspection) {

      return json(
        {
          success: false,
          error:
            "Inspection not found.",
        },
        404
      );
    }


    const findings =
      await env.SAFETY_DB
        .prepare(`
          SELECT
            f.id,
            f.category,
            f.title,
            f.observation,
            f.status,
            f.risk_level,
            f.confidence,
            f.check_id,
            f.source_title,
            f.source_url,

            s.check_question,
            s.guidance

          FROM findings f

          LEFT JOIN safety_checks s
            ON s.id = f.check_id

          WHERE f.inspection_id = ?

          ORDER BY
            f.created_at ASC
        `)
        .bind(id)
        .all();


    const photos =
      await env.SAFETY_DB
        .prepare(`
          SELECT
            id,
            inspection_id,
            object_key,
            file_name,
            content_type,
            created_at
          FROM inspection_photos
          WHERE inspection_id = ?
          ORDER BY created_at ASC
        `)
        .bind(id)
        .all();


    return json(
      {
        success: true,

        inspection,

        findings:
          findings.results || [],

        photos:
          photos.results || [],
      }
    );

  } catch (error) {

    console.error(
      "Inspection detail error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Unable to load inspection.",
        detail:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}


/* =========================================================
   DASHBOARD SUMMARY
   ========================================================= */

async function getSummary(
  env: Env
): Promise<Response> {

  try {

    const inspections =
      await env.SAFETY_DB
        .prepare(`
          SELECT COUNT(*) AS total
          FROM inspections
        `)
        .first<any>();


    const attention =
      await env.SAFETY_DB
        .prepare(`
          SELECT COUNT(*) AS total
          FROM inspections
          WHERE overall_result = 'FAIL'
        `)
        .first<any>();


    const checkRequired =
      await env.SAFETY_DB
        .prepare(`
          SELECT COUNT(*) AS total
          FROM inspections
          WHERE overall_result = 'CHECK_REQUIRED'
        `)
        .first<any>();


    return json(
      {
        success: true,

        inspections:
          Number(
            inspections?.total || 0
          ),

        attention:
          Number(
            attention?.total || 0
          ),

        check_required:
          Number(
            checkRequired?.total || 0
          ),
      }
    );

  } catch (error) {

    console.error(
      "Summary error:",
      error
    );

    return json(
      {
        success: false,
        error:
          "Unable to load summary.",
      },
      500
    );
  }
}


/* =========================================================
   HEALTH CHECK
   ========================================================= */

async function health(
  env: Env
): Promise<Response> {

  let database =
    false;

  let safetyChecks = 0;

  try {

    await env.SAFETY_DB
      .prepare(
        "SELECT 1 AS ok"
      )
      .first();

    database = true;

    const result =
      await env.SAFETY_DB
        .prepare(`
          SELECT COUNT(*) AS total
          FROM safety_checks
          WHERE active = 1
        `)
        .first<any>();

    safetyChecks =
      Number(
        result?.total || 0
      );

  } catch (error) {

    console.error(
      "Health check DB error:",
      error
    );
  }


  return json(
    {
      ok: true,

      service:
        "Safety Inspection AI",

      model:
        MODEL,

      database,

      active_safety_checks:
        safetyChecks,

      vectorize:
        false,

      timestamp:
        new Date().toISOString(),
    }
  );
}


/* =========================================================
   CORS
   ========================================================= */

function corsHeaders(): HeadersInit {

  return {
    "Access-Control-Allow-Origin":
      "*",

    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type",

    "Access-Control-Max-Age":
      "86400",
  };
}


function withCors(
  response: Response
): Response {

  const headers =
    new Headers(
      response.headers
    );

  const cors =
    corsHeaders();

  for (
    const [key, value]
    of Object.entries(cors)
  ) {
    headers.set(
      key,
      value
    );
  }

  return new Response(
    response.body,
    {
      status:
        response.status,

      statusText:
        response.statusText,

      headers,
    }
  );
}


/* =========================================================
   MAIN ROUTER
   ========================================================= */

export default {

  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {

    try {

      /* -----------------------------------------------
         OPTIONS
         ----------------------------------------------- */

      if (
        request.method ===
        "OPTIONS"
      ) {

        return withCors(
          new Response(
            null,
            {
              status: 204,
            }
          )
        );
      }


      const url =
        new URL(
          request.url
        );

      const pathname =
        url.pathname;


      /* -----------------------------------------------
         HEALTH
         ----------------------------------------------- */

      if (
        pathname ===
        "/api/health"
      ) {

        return withCors(
          await health(env)
        );
      }


      /* -----------------------------------------------
         ANALYSE
         ----------------------------------------------- */

      if (
        pathname ===
        "/api/analyse" &&
        request.method ===
        "POST"
      ) {

        return withCors(
          await analysePhoto(
            request,
            env
          )
        );
      }


      /*
       * Support alternative spelling.
       */

      if (
        pathname ===
        "/api/analyze" &&
        request.method ===
        "POST"
      ) {

        return withCors(
          await analysePhoto(
            request,
            env
          )
        );
      }


      /* -----------------------------------------------
         RECENT INSPECTIONS
         ----------------------------------------------- */

      if (
        pathname ===
        "/api/inspections" &&
        request.method ===
        "GET"
      ) {

        return withCors(
          await getRecentInspections(
            env
          )
        );
      }


      /* -----------------------------------------------
         SUMMARY
         ----------------------------------------------- */

      if (
        pathname ===
        "/api/summary" &&
        request.method ===
        "GET"
      ) {

        return withCors(
          await getSummary(env)
        );
      }


      /* -----------------------------------------------
         INSPECTION DETAIL
         ----------------------------------------------- */

      const inspectionMatch =
        pathname.match(
          /^\/api\/inspection\/([^/]+)$/
        );

      if (
        inspectionMatch &&
        request.method ===
        "GET"
      ) {

        return withCors(
          await getInspection(
            env,
            inspectionMatch[1]
          )
        );
      }


      /* -----------------------------------------------
         ROOT
         ----------------------------------------------- */

      if (
        pathname === "/" ||
        pathname === ""
      ) {

        return withCors(
          json(
            {
              service:
                "Safety Inspection AI",

              status:
                "running",

              endpoints: {
                health:
                  "/api/health",

                analyse:
                  "/api/analyse",

                inspections:
                  "/api/inspections",

                summary:
                  "/api/summary",

                inspection:
                  "/api/inspection/:id",
              },
            }
          )
        );
      }


      /* -----------------------------------------------
         NOT FOUND
         ----------------------------------------------- */

      return withCors(
        json(
          {
            success: false,
            error:
              "Endpoint not found.",
          },
          404
        )
      );

    } catch (error) {

      console.error(
        "Unhandled Worker error:",
        error
      );

      return withCors(
        json(
          {
            success: false,
            error:
              "Internal server error.",
            detail:
              error instanceof Error
                ? error.message
                : String(error),
          },
          500
        )
      );
    }
  },

} satisfies ExportedHandler<Env>;
