export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
}

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const DEFAULT_SOURCE =
  "https://www.tal.sg/wshc";

type FindingStatus = "PASS" | "CHECK_REQUIRED" | "FAIL";
type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

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
  status: FindingStatus;
  risk_level: RiskLevel;
  confidence: number;
  check_id?: string;
}

interface AIResult {
  summary: string;
  findings: AIFinding[];
}

interface RequestBody {
  image?: string;
  location?: string;
  inspector?: string;
  fileName?: string;
  contentType?: string;
}

/* =========================================================
   CORS
   ========================================================= */

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function jsonResponse(
  data: unknown,
  status = 200
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

/* =========================================================
   BASIC HELPERS
   ========================================================= */

function cleanText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim();
}

function clampConfidence(value: unknown): number {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 0.5;
  }

  if (n < 0) {
    return 0;
  }

  if (n > 1) {
    return 1;
  }

  return n;
}

function normalizeStatus(value: unknown): FindingStatus {
  const text = String(value ?? "")
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

function normalizeRisk(value: unknown): RiskLevel {
  const text = String(value ?? "")
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

function makeId(prefix = ""): string {
  const uuid =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`;

  return prefix ? `${prefix}-${uuid}` : uuid;
}

function makeInspectionNo(): string {
  const now = new Date();

  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");

  const shortId = crypto
    .randomUUID()
    .replace(/-/g, "")
    .substring(0, 6)
    .toUpperCase();

  return `SI-${year}${month}${day}-${shortId}`;
}

/* =========================================================
   IMAGE NORMALISATION
   ========================================================= */

/**
 * Cloudflare's Llama Vision model accepts the image as a
 * base64/data URL string.
 *
 * We deliberately do NOT send:
 *
 * image: [ ... ]
 *
 * because that causes:
 *
 * 5006: oneOf at '/' not met
 * Type mismatch of /image, array not in string
 */
function normalizeImage(
  image: string,
  contentType = "image/jpeg"
): string {
  if (!image) {
    throw new Error("No image was supplied.");
  }

  const trimmed = image.trim();

  /*
   * Already a data URL.
   */
  if (trimmed.startsWith("data:image/")) {
    return trimmed;
  }

  /*
   * Already a normal URL.
   */
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://")
  ) {
    return trimmed;
  }

  /*
   * Remove a possible data URL prefix if the browser
   * supplied an unusual format.
   */
  const base64 = trimmed.replace(
    /^data:[^;]+;base64,/i,
    ""
  );

  const safeContentType =
    contentType.startsWith("image/")
      ? contentType
      : "image/jpeg";

  return `data:${safeContentType};base64,${base64}`;
}

/* =========================================================
   SAFETY CHECKS
   ========================================================= */

async function getSafetyChecks(
  db: D1Database
): Promise<SafetyCheck[]> {
  const result = await db
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

  return result.results ?? [];
}

/*
 * These are fallback checks only.
 *
 * Your D1 safety_checks table should eventually contain
 * your complete WSH inspection library.
 */
function fallbackSafetyChecks(): SafetyCheck[] {
  return [
    {
      id: "fallback-ppe",
      category: "PPE",
      check_question:
        "Are workers apparently wearing the PPE required for the visible activity?",
      guidance:
        "Check visible PPE such as safety helmets, high-visibility clothing, safety footwear and other PPE relevant to the visible task. Actual PPE requirements must be verified against the site's risk assessment and rules.",
      source_title: "WSH Council resources",
      source_url: DEFAULT_SOURCE,
      keywords:
        "helmet, hard hat, safety vest, hi vis, PPE, safety shoes",
      active: 1,
    },

    {
      id: "fallback-height",
      category: "Work at Height",
      check_question:
        "Is there a visible fall hazard requiring fall prevention or protection?",
      guidance:
        "If work at height or an open edge is visible, verify that suitable guardrails, edge protection, safe access and fall prevention/protection measures are provided.",
      source_title: "Preventing Falls from Height",
      source_url:
        "https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights",
      keywords:
        "height, edge, guardrail, railing, opening, fall, platform",
      active: 1,
    },

    {
      id: "fallback-lifting",
      category: "Lifting",
      check_question:
        "Is a person apparently exposed to a suspended or lifting load?",
      guidance:
        "If lifting operations are visible, verify exclusion zones, lifting controls and that persons are not exposed to suspended loads.",
      source_title: "WSH Council resources",
      source_url: DEFAULT_SOURCE,
      keywords:
        "crane, lifting, suspended load, hoist, container, sling",
      active: 1,
    },

    {
      id: "fallback-traffic",
      category: "Vehicular Safety",
      check_question:
        "Are pedestrian walkways and vehicle routes clearly segregated and free from obstruction?",
      guidance:
        "Check that pedestrian walkways and vehicle routes are clearly demarcated, visible and kept free of obstructions.",
      source_title:
        "Workplace Traffic Safety Management",
      source_url:
        "https://www.tal.sg/wshc/topics/vehicular-safety/workplace-traffic-safety-management",
      keywords:
        "vehicle, truck, pedestrian, walkway, traffic, road, driveway",
      active: 1,
    },

    {
      id: "fallback-housekeeping",
      category: "Housekeeping",
      check_question:
        "Are there visible spills, oily, wet or dirty surfaces that could create a slip hazard?",
      guidance:
        "Check for spilled substances and oily, wet or dirty surfaces and ensure hazards are controlled promptly.",
      source_title:
        "Workplace Housekeeping",
      source_url:
        "https://www.tal.sg/wshc/topics/housekeeping/workplace-housekeeping",
      keywords:
        "spill, oil, water, wet, dirty, debris, rubbish, obstruction",
      active: 1,
    },

    {
      id: "fallback-machinery",
      category: "Machinery Safety",
      check_question:
        "Are visible machines or moving equipment adequately guarded?",
      guidance:
        "If machinery is visible, check whether guards appear to be provided around dangerous moving parts and whether workers appear exposed to moving machinery.",
      source_title: "WSH Council resources",
      source_url: DEFAULT_SOURCE,
      keywords:
        "machine, machinery, guard, moving part, equipment",
      active: 1,
    },
  ];
}

/* =========================================================
   BUILD WSH PROMPT
   ========================================================= */

function buildSafetyChecksText(
  checks: SafetyCheck[]
): string {
  if (!checks.length) {
    return fallbackSafetyChecks()
      .map(
        (c) =>
          `CHECK_ID: ${c.id}
CATEGORY: ${c.category}
QUESTION: ${c.check_question}
GUIDANCE: ${c.guidance}
SOURCE: ${c.source_title}
URL: ${c.source_url}
KEYWORDS: ${c.keywords}`
      )
      .join("\n\n");
  }

  return checks
    .map(
      (c) =>
        `CHECK_ID: ${c.id}
CATEGORY: ${c.category}
QUESTION: ${c.check_question}
GUIDANCE: ${c.guidance}
SOURCE: ${c.source_title}
URL: ${c.source_url}
KEYWORDS: ${c.keywords}`
    )
    .join("\n\n");
}

function buildVisionPrompt(
  checks: SafetyCheck[]
): string {
  const checksText = buildSafetyChecksText(checks);

  return `
You are a workplace safety inspection assistant for a Singapore
workplace inspection application.

You must analyse the supplied workplace photograph.

Use the supplied WSH Council safety checks as the reference
framework.

IMPORTANT SAFETY RULES:

1. Only report hazards or conditions that are visibly supported
   by the photograph.

2. Do not invent objects, people, vehicles, hazards or activities.

3. If something cannot be confirmed from the photograph,
   use CHECK_REQUIRED instead of FAIL.

4. A PASS means the relevant safety condition is visibly present
   or there is no visible indication of the hazard.

5. A FAIL should only be used where a significant unsafe
   condition is clearly visible.

6. CHECK_REQUIRED means physical/site verification is needed.

7. Do not assume that PPE is required merely because a worker
   is present. Consider the visible activity and context.

8. Do not assume a worker is working at height simply because
   a railing or platform is visible.

9. Do not assume lifting exposure merely because a crane is
   visible in the background.

10. For work at height, look for actual visible fall exposure,
    open edges, openings, platforms, ladders, scaffolds or
    other height-related hazards.

11. For lifting, look for visible lifting activity, suspended
    loads or people apparently within a lifting/exclusion zone.

12. For vehicular safety, only apply the check when vehicles,
    traffic routes, pedestrian routes or related conditions
    are visible.

13. For housekeeping, look for visible spills, debris,
    obstructions, poor storage or unsafe access.

14. For PPE, describe only PPE that is actually visible.

15. Do not make legal/compliance determinations from a photograph.
    The result is an inspection aid requiring human verification.

16. Return ONLY the JSON structure requested by the schema.

17. Generate no Markdown.

18. Do not put explanatory text before or after the JSON.

SELECTING WSH CHECKS:

Use the supplied checks below.

Only create a finding when:
- the photograph contains something relevant to the check, OR
- the photograph provides useful evidence for that check.

Do not generate a finding for every check.

Aim for 1 to 6 useful findings.

For each finding:
- select the most relevant CHECK_ID;
- use the category from that check;
- describe what is actually visible;
- explain what should be verified;
- assign PASS, CHECK_REQUIRED or FAIL;
- assign LOW, MEDIUM or HIGH risk;
- give confidence from 0.0 to 1.0.

If there is no relevant WSH issue, return a small number of
PASS findings for clearly visible positive conditions.

WSH CHECK LIBRARY:

${checksText}

Return this structure:

{
  "summary": "Short description of the workplace scene.",
  "findings": [
    {
      "category": "PPE",
      "title": "Short finding title",
      "observation": "What is visibly observed and what should be checked.",
      "status": "PASS",
      "risk_level": "LOW",
      "confidence": 0.95,
      "check_id": "CHECK_ID_FROM_LIBRARY"
    }
  ]
}
`;
}

/* =========================================================
   JSON EXTRACTION
   ========================================================= */

function stripCodeFence(text: string): string {
  let value = text.trim();

  value = value.replace(/^```json\s*/i, "");
  value = value.replace(/^```\s*/i, "");
  value = value.replace(/\s*```$/i, "");

  return value.trim();
}

function extractJsonObject(text: string): string | null {
  const cleaned = stripCodeFence(text);

  if (
    cleaned.startsWith("{") &&
    cleaned.endsWith("}")
  ) {
    return cleaned;
  }

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first >= 0 && last > first) {
    return cleaned.substring(first, last + 1);
  }

  return null;
}

/* =========================================================
   NORMALISE AI RESULT
   ========================================================= */

function normaliseAIResult(
  raw: unknown
): AIResult {
  let parsed: any = raw;

  /*
   * Workers AI normally returns something like:
   *
   * {
   *   response: "..."
   * }
   */

  if (
    parsed &&
    typeof parsed === "object" &&
    "response" in parsed
  ) {
    parsed = (parsed as any).response;
  }

  if (typeof parsed === "string") {
    const jsonText = extractJsonObject(parsed);

    if (!jsonText) {
      throw new Error(
        "Workers AI returned an invalid structured response."
      );
    }

    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error(
        "Workers AI returned invalid JSON."
      );
    }
  }

  /*
   * Some responses can wrap the result.
   */
  if (
    parsed &&
    typeof parsed === "object" &&
    parsed.result &&
    typeof parsed.result === "object"
  ) {
    parsed = parsed.result;
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      "Workers AI returned an invalid structured response."
    );
  }

  const summary =
    typeof parsed.summary === "string"
      ? parsed.summary.trim()
      : "Workplace scene analysed.";

  const rawFindings = Array.isArray(parsed.findings)
    ? parsed.findings
    : [];

  const findings: AIFinding[] = [];

  for (const item of rawFindings.slice(0, 6)) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const category =
      cleanText(item.category, "Other");

    const title =
      cleanText(item.title, "AI safety observation");

    const observation =
      cleanText(
        item.observation,
        "Physical/site verification is required."
      );

    if (!title || !observation) {
      continue;
    }

    findings.push({
      category,
      title,
      observation,
      status: normalizeStatus(item.status),
      risk_level: normalizeRisk(item.risk_level),
      confidence: clampConfidence(item.confidence),
      check_id:
        typeof item.check_id === "string"
          ? item.check_id
          : undefined,
    });
  }

  /*
   * Do not allow an empty result to break the whole inspection.
   */
  if (!findings.length) {
    findings.push({
      category: "Other",
      title: "AI analysis requires review",
      observation:
        "The image was analysed, but no structured safety findings could be confirmed. Physical/site verification is required.",
      status: "CHECK_REQUIRED",
      risk_level: "MEDIUM",
      confidence: 0.5,
    });
  }

  return {
    summary,
    findings,
  };
}

/* =========================================================
   JSON SCHEMA
   ========================================================= */

const AI_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    type: "object",
    properties: {
      summary: {
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
          },

          required: [
            "category",
            "title",
            "observation",
            "status",
            "risk_level",
            "confidence",
            "check_id",
          ],
        },
      },
    },

    required: [
      "summary",
      "findings",
    ],
  },
};

/* =========================================================
   WORKERS AI
   ========================================================= */

async function runVisionAI(
  env: Env,
  image: string,
  prompt: string
): Promise<AIResult> {
  /*
   * IMPORTANT:
   *
   * Cloudflare's Llama Vision API expects:
   *
   * messages: [
   *   {
   *     role: "user",
   *     content: "string"
   *   }
   * ]
   *
   * image: "base64/data URL string"
   *
   * Do NOT put an array into message.content.
   * Do NOT put an array into image.
   */

  try {
    const response = await env.AI.run(
      MODEL,
      {
        messages: [
          {
            role: "system",
            content:
              "You are a Singapore workplace safety inspection assistant. Follow the supplied WSH inspection rules exactly. Return only the requested JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],

        image,

        response_format:
          AI_RESPONSE_FORMAT,

        temperature: 0.1,
        max_tokens: 1800,
        top_p: 0.9,
      } as any
    );

    return normaliseAIResult(response);
  } catch (firstError) {
    /*
     * Fallback:
     *
     * If JSON Mode cannot be satisfied by the model,
     * run the same vision request without response_format
     * and recover JSON from the generated response.
     */
    try {
      const fallbackResponse =
        await env.AI.run(
          MODEL,
          {
            messages: [
              {
                role: "system",
                content:
                  "You are a workplace safety inspection assistant. Return ONLY valid JSON. Do not use Markdown.",
              },
              {
                role: "user",
                content: `${prompt}

IMPORTANT:
Return ONLY valid JSON.
Do not use markdown fences.
Do not add explanatory text.`,
              },
            ],

            image,

            temperature: 0.1,
            max_tokens: 1800,
            top_p: 0.9,
          } as any
        );

      return normaliseAIResult(
        fallbackResponse
      );
    } catch (secondError) {
      const firstMessage =
        firstError instanceof Error
          ? firstError.message
          : String(firstError);

      const secondMessage =
        secondError instanceof Error
          ? secondError.message
          : String(secondError);

      throw new Error(
        `Workers AI analysis failed. First attempt: ${firstMessage}. Fallback: ${secondMessage}`
      );
    }
  }
}

/* =========================================================
   MATCH FINDINGS TO WSH CHECKS
   ========================================================= */

function findBestCheck(
  finding: AIFinding,
  checks: SafetyCheck[]
): SafetyCheck | null {
  /*
   * First try exact check_id.
   */
  if (finding.check_id) {
    const exact = checks.find(
      (c) => c.id === finding.check_id
    );

    if (exact) {
      return exact;
    }
  }

  /*
   * Then category match.
   */
  const category = finding.category
    .toLowerCase()
    .trim();

  const categoryMatch = checks.find(
    (c) =>
      c.category.toLowerCase().trim() === category
  );

  if (categoryMatch) {
    return categoryMatch;
  }

  /*
   * Then keyword matching.
   */
  const haystack =
    `${finding.title} ${finding.observation}`.toLowerCase();

  let best: SafetyCheck | null = null;
  let bestScore = 0;

  for (const check of checks) {
    const keywords = cleanText(
      check.keywords
    )
      .toLowerCase()
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    let score = 0;

    for (const keyword of keywords) {
      if (haystack.includes(keyword)) {
        score++;
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
   OVERALL RESULT
   ========================================================= */

function calculateOverallResult(
  findings: AIFinding[]
): FindingStatus {
  if (
    findings.some(
      (f) => f.status === "FAIL"
    )
  ) {
    return "FAIL";
  }

  if (
    findings.some(
      (f) =>
        f.status === "CHECK_REQUIRED"
    )
  ) {
    return "CHECK_REQUIRED";
  }

  return "PASS";
}

/* =========================================================
   DATABASE SAVE
   ========================================================= */

async function saveInspection(
  db: D1Database,
  params: {
    inspectionId: string;
    inspectionNo: string;
    location: string;
    inspector: string;
    overallResult: FindingStatus;
    photoId: string;
    fileName: string;
    contentType: string;
    findings: AIFinding[];
    checks: SafetyCheck[];
  }
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .prepare(
      `
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
      `
    )
    .bind(
      params.inspectionId,
      params.inspectionNo,
      params.location,
      params.inspector,
      now,
      params.overallResult
    )
    .run();

  /*
   * inspection_photos table exists in your database.
   *
   * We record the image reference even though the current
   * version does not require an R2 binding.
   */
  await db
    .prepare(
      `
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
      `
    )
    .bind(
      params.photoId,
      params.inspectionId,
      `inspection/${params.inspectionId}/${params.photoId}`,
      params.fileName,
      params.contentType,
      now
    )
    .run();

  for (const finding of params.findings) {
    const findingId = makeId("finding");

    const check =
      findBestCheck(
        finding,
        params.checks
      );

    const category =
      check?.category ||
      finding.category ||
      "Other";

    const checkId =
      check?.id ||
      finding.check_id ||
      null;

    const sourceTitle =
      check?.source_title ||
      "WSH Council resources";

    const sourceUrl =
      check?.source_url ||
      DEFAULT_SOURCE;

    await db
      .prepare(
        `
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
        `
      )
      .bind(
        findingId,
        params.inspectionId,
        params.photoId,
        category,
        finding.title,
        finding.observation,
        finding.status,
        finding.risk_level,
        finding.confidence,
        checkId,
        sourceTitle,
        sourceUrl,
        now
      )
      .run();
  }
}

/* =========================================================
   GET RECENT INSPECTIONS
   ========================================================= */

async function getRecentInspections(
  db: D1Database
): Promise<Response> {
  const result = await db
    .prepare(
      `
      SELECT
        id,
        inspection_no,
        location,
        inspector,
        created_at,
        overall_result
      FROM inspections
      ORDER BY created_at DESC
      LIMIT 20
      `
    )
    .all();

  const rows = result.results ?? [];

  return jsonResponse({
    success: true,
    inspections: rows,
  });
}

/* =========================================================
   GET SINGLE INSPECTION
   ========================================================= */

async function getInspection(
  db: D1Database,
  inspectionId: string
): Promise<Response> {
  const inspection =
    await db
      .prepare(
        `
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
        `
      )
      .bind(inspectionId)
      .first();

  if (!inspection) {
    return jsonResponse(
      {
        success: false,
        error: "Inspection not found.",
      },
      404
    );
  }

  const findings =
    await db
      .prepare(
        `
        SELECT
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
        FROM findings
        WHERE inspection_id = ?
        ORDER BY created_at ASC
        `
      )
      .bind(inspectionId)
      .all();

  const photos =
    await db
      .prepare(
        `
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
        `
      )
      .bind(inspectionId)
      .all();

  return jsonResponse({
    success: true,
    inspection,
    findings: findings.results ?? [],
    photos: photos.results ?? [],
  });
}

/* =========================================================
   DASHBOARD SUMMARY
   ========================================================= */

async function getSummary(
  db: D1Database
): Promise<Response> {
  const total =
    await db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM inspections
        `
      )
      .first<{ count: number }>();

  const attention =
    await db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM inspections
        WHERE overall_result = 'ATTENTION'
        `
      )
      .first<{ count: number }>();

  const checkRequired =
    await db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM inspections
        WHERE overall_result = 'CHECK_REQUIRED'
        `
      )
      .first<{ count: number }>();

  const fail =
    await db
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM inspections
        WHERE overall_result = 'FAIL'
        `
      )
      .first<{ count: number }>();

  return jsonResponse({
    success: true,
    summary: {
      inspections:
        Number(total?.count ?? 0),

      attention:
        Number(attention?.count ?? 0),

      check_required:
        Number(checkRequired?.count ?? 0),

      fail:
        Number(fail?.count ?? 0),
    },
  });
}

/* =========================================================
   ANALYSE PHOTO
   ========================================================= */

async function analysePhoto(
  request: Request,
  env: Env
): Promise<Response> {
  let body: RequestBody;

  try {
    body =
      (await request.json()) as RequestBody;
  } catch {
    return jsonResponse(
      {
        success: false,
        error:
          "Invalid JSON request body.",
      },
      400
    );
  }

  if (!body.image) {
    return jsonResponse(
      {
        success: false,
        error: "Please upload an image.",
      },
      400
    );
  }

  const location =
    cleanText(
      body.location,
      "Unspecified"
    );

  const inspector =
    cleanText(
      body.inspector,
      "Unspecified"
    );

  const fileName =
    cleanText(
      body.fileName,
      "inspection-photo.jpg"
    );

  const contentType =
    cleanText(
      body.contentType,
      "image/jpeg"
    );

  try {
    /*
     * Get WSH checks from D1.
     */
    let checks =
      await getSafetyChecks(
        env.SAFETY_DB
      );

    /*
     * If no safety checks have been loaded yet,
     * use a small built-in WSH set.
     */
    if (!checks.length) {
      checks =
        fallbackSafetyChecks();
    }

    /*
     * Convert uploaded image to the format expected by
     * Llama Vision.
     */
    const image =
      normalizeImage(
        body.image,
        contentType
      );

    /*
     * Build WSH-specific prompt.
     */
    const prompt =
      buildVisionPrompt(checks);

    /*
     * Run Workers AI.
     */
    const aiResult =
      await runVisionAI(
        env,
        image,
        prompt
      );

    /*
     * Match the model's findings to the D1 WSH checks.
     */
    const normalisedFindings =
      aiResult.findings.map(
        (finding) => {
          const check =
            findBestCheck(
              finding,
              checks
            );

          return {
            ...finding,

            category:
              check?.category ||
              finding.category ||
              "Other",

            check_id:
              check?.id ||
              finding.check_id,
          };
        }
      );

    /*
     * Determine overall inspection status.
     */
    const overallResult =
      calculateOverallResult(
        normalisedFindings
      );

    /*
     * Create IDs.
     */
    const inspectionId =
      makeId("inspection");

    const photoId =
      makeId("photo");

    const inspectionNo =
      makeInspectionNo();

    /*
     * Save everything to D1.
     */
    await saveInspection(
      env.SAFETY_DB,
      {
        inspectionId,
        inspectionNo,
        location,
        inspector,
        overallResult,
        photoId,
        fileName,
        contentType,
        findings:
          normalisedFindings,
        checks,
      }
    );

    /*
     * Return data to index.html.
     */
    return jsonResponse({
      success: true,

      inspection: {
        id: inspectionId,
        inspection_no:
          inspectionNo,
        location,
        inspector,
        created_at:
          new Date().toISOString(),
        overall_result:
          overallResult,
      },

      summary:
        aiResult.summary,

      findings:
        normalisedFindings.map(
          (finding) => {
            const check =
              findBestCheck(
                finding,
                checks
              );

            return {
              category:
                check?.category ||
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
                check?.id ||
                finding.check_id ||
                null,

              wsh_check:
                check?.check_question ||
                null,

              guidance:
                check?.guidance ||
                null,

              source_title:
                check?.source_title ||
                "WSH Council resources",

              source_url:
                check?.source_url ||
                DEFAULT_SOURCE,
            };
          }
        ),
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      "SAFETY ANALYSIS ERROR:",
      message
    );

    return jsonResponse(
      {
        success: false,
        error:
          "AI analysis failed.",
        detail: message,
      },
      500
    );
  }
}

/* =========================================================
   API ROUTER
   ========================================================= */

async function handleApi(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  /*
   * Health
   */
  if (
    pathname === "/api/health" &&
    request.method === "GET"
  ) {
    return jsonResponse({
      success: true,
      service:
        "Safety Inspection AI",
      ai_model: MODEL,
      database: "D1",
      time:
        new Date().toISOString(),
    });
  }

  /*
   * Recent inspections
   */
  if (
    pathname === "/api/inspections" &&
    request.method === "GET"
  ) {
    return getRecentInspections(
      env.SAFETY_DB
    );
  }

  /*
   * Dashboard summary
   */
  if (
    pathname === "/api/summary" &&
    request.method === "GET"
  ) {
    return getSummary(
      env.SAFETY_DB
    );
  }

  /*
   * Single inspection
   *
   * /api/inspections/<id>
   */
  if (
    pathname.startsWith(
      "/api/inspections/"
    ) &&
    request.method === "GET"
  ) {
    const id =
      pathname.substring(
        "/api/inspections/".length
      );

    if (!id) {
      return jsonResponse(
        {
          success: false,
          error:
            "Inspection ID is required.",
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
   * Analyse uploaded image
   */
  if (
    pathname === "/api/analyze" &&
    request.method === "POST"
  ) {
    return analysePhoto(
      request,
      env
    );
  }

  /*
   * Alternative spelling
   */
  if (
    pathname === "/api/analyse" &&
    request.method === "POST"
  ) {
    return analysePhoto(
      request,
      env
    );
  }

  /*
   * Safety checks
   */
  if (
    pathname === "/api/safety-checks" &&
    request.method === "GET"
  ) {
    const checks =
      await getSafetyChecks(
        env.SAFETY_DB
      );

    return jsonResponse({
      success: true,
      checks,
    });
  }

  return jsonResponse(
    {
      success: false,
      error: "API endpoint not found.",
    },
    404
  );
}

/* =========================================================
   WORKER
   ========================================================= */

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    /*
     * CORS pre-flight.
     */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    const url =
      new URL(request.url);

    /*
     * API requests.
     */
    if (
      url.pathname.startsWith(
        "/api/"
      )
    ) {
      try {
        return await handleApi(
          request,
          env,
          url.pathname
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        console.error(
          "API ERROR:",
          message
        );

        return jsonResponse(
          {
            success: false,
            error:
              "Server error.",
            detail: message,
          },
          500
        );
      }
    }

    /*
     * Let Cloudflare Assets / existing frontend
     * handle non-API requests.
     *
     * This Worker does not require Vectorize.
     */
    try {
      const assetBinding =
        (env as any).ASSETS;

      if (assetBinding) {
        return assetBinding.fetch(
          request
        );
      }
    } catch (error) {
      console.error(
        "ASSET ERROR:",
        error
      );
    }

    /*
     * Simple fallback if the Worker is not configured
     * with an ASSETS binding.
     */
    return new Response(
      "Safety Inspection AI Worker is running. Please configure your frontend/static assets.",
      {
        status: 200,
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8",
        },
      }
    );
  },
} satisfies ExportedHandler<Env>;
