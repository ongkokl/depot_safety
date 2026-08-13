export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
}

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

type SafetyCheck = {
  id: string;
  category: string;
  check_question: string;
  guidance: string;
  source_title: string;
  source_url: string;
  keywords?: string;
};

type Finding = {
  category: string;
  title: string;
  observation: string;
  status: "PASS" | "FAIL" | "CHECK_REQUIRED";
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  confidence: number;
  check_id?: string;
  source_title?: string;
  source_url?: string;
};

type AIResult = {
  scene_summary: string;
  findings: Finding[];
};

const AI_SCHEMA = {
  type: "object",
  properties: {
    scene_summary: {
      type: "string"
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: [
              "PPE",
              "Work at Height",
              "Lifting",
              "Vehicular Safety",
              "Housekeeping",
              "Equipment",
              "Fire Safety",
              "Electrical Safety",
              "Other"
            ]
          },
          title: {
            type: "string"
          },
          observation: {
            type: "string"
          },
          status: {
            type: "string",
            enum: [
              "PASS",
              "FAIL",
              "CHECK_REQUIRED"
            ]
          },
          risk_level: {
            type: "string",
            enum: [
              "LOW",
              "MEDIUM",
              "HIGH"
            ]
          },
          confidence: {
            type: "number"
          },
          check_id: {
            type: "string"
          },
          source_title: {
            type: "string"
          },
          source_url: {
            type: "string"
          }
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
          "source_url"
        ]
      }
    }
  },
  required: [
    "scene_summary",
    "findings"
  ]
};

function jsonResponse(
  data: unknown,
  status = 200
): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "cache-control": "no-store"
      }
    }
  );
}

function makeId(prefix: string): string {
  return (
    prefix +
    "-" +
    crypto.randomUUID().replaceAll("-", "").substring(0, 8).toUpperCase()
  );
}

function nowISO(): string {
  return new Date().toISOString();
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

function normaliseStatus(value: unknown): Finding["status"] {
  const v = String(value || "")
    .trim()
    .toUpperCase();

  if (v === "PASS") {
    return "PASS";
  }

  if (v === "FAIL") {
    return "FAIL";
  }

  return "CHECK_REQUIRED";
}

function normaliseRisk(value: unknown): Finding["risk_level"] {
  const v = String(value || "")
    .trim()
    .toUpperCase();

  if (v === "LOW") {
    return "LOW";
  }

  if (v === "HIGH") {
    return "HIGH";
  }

  return "MEDIUM";
}

function normaliseCategory(value: unknown): string {
  const v = String(value || "").trim();

  const allowed = [
    "PPE",
    "Work at Height",
    "Lifting",
    "Vehicular Safety",
    "Housekeeping",
    "Equipment",
    "Fire Safety",
    "Electrical Safety",
    "Other"
  ];

  if (allowed.includes(v)) {
    return v;
  }

  return "Other";
}

function stripCodeFence(text: string): string {
  let result = text.trim();

  if (result.startsWith("```")) {
    result = result.replace(/^```(?:json)?/i, "");
    result = result.replace(/```$/i, "");
  }

  return result.trim();
}

function extractJson(text: string): unknown {
  const cleaned = stripCodeFence(text);

  try {
    return JSON.parse(cleaned);
  } catch {
    // Continue below.
  }

  const firstObject = cleaned.indexOf("{");
  const lastObject = cleaned.lastIndexOf("}");

  if (
    firstObject >= 0 &&
    lastObject > firstObject
  ) {
    const candidate = cleaned.substring(
      firstObject,
      lastObject + 1
    );

    try {
      return JSON.parse(candidate);
    } catch {
      // Continue below.
    }
  }

  throw new Error(
    "Workers AI returned an invalid structured response."
  );
}

function extractAIText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (!result || typeof result !== "object") {
    return "";
  }

  const r = result as Record<string, unknown>;

  if (typeof r.response === "string") {
    return r.response;
  }

  if (typeof r.text === "string") {
    return r.text;
  }

  if (typeof r.output === "string") {
    return r.output;
  }

  if (
    r.response &&
    typeof r.response === "object"
  ) {
    const rr = r.response as Record<string, unknown>;

    if (typeof rr.text === "string") {
      return rr.text;
    }
  }

  return "";
}

function normaliseAIResult(
  value: unknown
): AIResult {
  if (!value || typeof value !== "object") {
    throw new Error(
      "Workers AI returned an invalid structured response."
    );
  }

  const obj = value as Record<string, unknown>;

  let rawFindings = obj.findings;

  /*
   * Some model responses may wrap the JSON object
   * inside a "response" property.
   */
  if (
    !rawFindings &&
    obj.response &&
    typeof obj.response === "object"
  ) {
    const nested =
      obj.response as Record<string, unknown>;

    rawFindings = nested.findings;

    if (
      typeof obj.scene_summary !== "string" &&
      typeof nested.scene_summary === "string"
    ) {
      obj.scene_summary = nested.scene_summary;
    }
  }

  const findingsArray = Array.isArray(rawFindings)
    ? rawFindings
    : [];

  const findings: Finding[] = [];

  for (const item of findingsArray) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const f = item as Record<string, unknown>;

    const title =
      String(f.title || "").trim();

    const observation =
      String(f.observation || "").trim();

    if (!title && !observation) {
      continue;
    }

    findings.push({
      category: normaliseCategory(f.category),

      title:
        title ||
        "Safety observation",

      observation:
        observation ||
        "Visible condition requires verification.",

      status:
        normaliseStatus(f.status),

      risk_level:
        normaliseRisk(f.risk_level),

      confidence:
        clampConfidence(f.confidence),

      check_id:
        f.check_id
          ? String(f.check_id)
          : undefined,

      source_title:
        f.source_title
          ? String(f.source_title)
          : undefined,

      source_url:
        f.source_url
          ? String(f.source_url)
          : undefined
    });
  }

  return {
    scene_summary:
      String(
        obj.scene_summary ||
        "Workplace scene analysed."
      ),

    findings
  };
}

function buildChecksText(
  checks: SafetyCheck[]
): string {
  if (!checks.length) {
    return `
No database safety checks were available.

Use general workplace safety principles only.
Do not invent specific WSH legal requirements.
`;
  }

  return checks
    .map((c, index) => {
      return `
CHECK ${index + 1}
ID: ${c.id}
CATEGORY: ${c.category}
QUESTION: ${c.check_question}
GUIDANCE: ${c.guidance}
SOURCE: ${c.source_title}
SOURCE URL: ${c.source_url}
KEYWORDS: ${c.keywords || ""}
`;
    })
    .join("\n");
}

async function loadSafetyChecks(
  env: Env
): Promise<SafetyCheck[]> {
  try {
    const result = await env.SAFETY_DB
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
  } catch {
    return [];
  }
}

function createPrompt(
  checks: SafetyCheck[]
): string {
  return `
You are an AI assistant supporting workplace safety inspections
in Singapore.

Analyse the uploaded workplace photograph.

The purpose is NOT to make a legal compliance decision.

Your task is to identify ONLY safety conditions that can reasonably
be observed or assessed from the photograph.

IMPORTANT:

1. Do not invent hazards that cannot be seen.
2. Do not claim that something is compliant merely because it is
   not visible.
3. If something cannot be confirmed from the photograph, use
   CHECK_REQUIRED.
4. Use the supplied WSH safety checks as the primary reference.
5. Match visible conditions to the most relevant safety check.
6. If no relevant check exists, use category "Other".
7. A visible safety control may be PASS only when the photograph
   provides reasonable visual evidence.
8. Use FAIL when a clearly visible unsafe condition exists.
9. Use CHECK_REQUIRED when verification is needed.
10. Confidence must be between 0 and 1.
11. Keep each observation short and factual.
12. Do not output Markdown.
13. Do not output explanations outside the JSON structure.
14. Do not create duplicate findings.
15. Maximum 8 findings.

VERY IMPORTANT:

For example, if a worker is wearing a helmet and high visibility
clothing, you may report visible PPE as PASS.

However, do NOT conclude that all required PPE is compliant because
the photograph cannot establish the complete PPE requirements.

If a guardrail is visible, assess whether it appears complete and
secure. If this cannot be established, use CHECK_REQUIRED.

If lifting equipment is visible, do not automatically say that a
worker is exposed to a suspended load. Only report such exposure
if it is visibly supported by the photograph.

WSH SAFETY CHECKS:

${buildChecksText(checks)}

Return JSON matching the required schema exactly.
`;
}

async function runAI(
  env: Env,
  imageData: string,
  checks: SafetyCheck[]
): Promise<AIResult> {
  const prompt = createPrompt(checks);

  /*
   * IMPORTANT:
   *
   * Cloudflare's Llama 3.2 Vision API expects:
   *
   *   messages[].content = STRING
   *   image = STRING
   *
   * Do NOT put an array inside messages[].content.
   */

  const requestBody = {
    messages: [
      {
        role: "system",
        content:
          "You are a careful Singapore workplace safety inspection assistant."
      },
      {
        role: "user",
        content: prompt
      }
    ],

    image: imageData,

    max_tokens: 1800,

    temperature: 0.1,

    response_format: {
      type: "json_schema",

      json_schema: AI_SCHEMA
    }
  };

  const result =
    await env.AI.run(
      MODEL,
      requestBody
    );

  /*
   * Depending on the Workers AI runtime/version,
   * the binding can return either:
   *
   * { response: "..." }
   *
   * or an already parsed JSON object.
   */

  if (
    result &&
    typeof result === "object"
  ) {
    const r =
      result as Record<string, unknown>;

    if (
      r.findings ||
      r.scene_summary
    ) {
      return normaliseAIResult(result);
    }
  }

  const text =
    extractAIText(result);

  if (!text) {
    throw new Error(
      "Workers AI returned an empty response."
    );
  }

  const parsed =
    extractJson(text);

  return normaliseAIResult(parsed);
}

async function createInspection(
  env: Env,
  location: string,
  inspector: string
): Promise<string> {
  const id = crypto.randomUUID();

  const inspectionNo =
    `SI-${new Date()
      .toISOString()
      .replace(/[-:TZ.]/g, "")
      .substring(0, 8)}-${crypto
      .randomUUID()
      .replaceAll("-", "")
      .substring(0, 6)
      .toUpperCase()}`;

  await env.SAFETY_DB
    .prepare(`
      INSERT INTO inspections (
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
      id,
      inspectionNo,
      location || "Unspecified",
      inspector || "Unspecified",
      nowISO(),
      "CHECK_REQUIRED"
    )
    .run();

  return id;
}

async function savePhoto(
  env: Env,
  inspectionId: string,
  fileName: string,
  contentType: string
): Promise<string> {
  const photoId =
    crypto.randomUUID();

  /*
   * The current database has:
   *
   * inspection_photos
   * id
   * inspection_id
   * object_key
   * file_name
   * content_type
   * created_at
   *
   * We therefore do not use a non-existing
   * confirmation_no or other columns.
   */

  const objectKey =
    `inspections/${inspectionId}/${photoId}-${fileName}`;

  await env.SAFETY_DB
    .prepare(`
      INSERT INTO inspection_photos (
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
      photoId,
      inspectionId,
      objectKey,
      fileName,
      contentType,
      nowISO()
    )
    .run();

  return photoId;
}

async function saveFindings(
  env: Env,
  inspectionId: string,
  photoId: string,
  findings: Finding[]
): Promise<void> {
  for (const finding of findings) {
    const findingId =
      crypto.randomUUID();

    await env.SAFETY_DB
      .prepare(`
        INSERT INTO findings (
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
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
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
        finding.check_id || null,
        finding.source_title || null,
        finding.source_url || null,
        nowISO()
      )
      .run();
  }
}

function calculateOverall(
  findings: Finding[]
): "PASS" | "ATTENTION" | "CHECK_REQUIRED" {
  if (!findings.length) {
    return "CHECK_REQUIRED";
  }

  if (
    findings.some(
      f =>
        f.status === "FAIL" &&
        f.risk_level === "HIGH"
    )
  ) {
    return "ATTENTION";
  }

  if (
    findings.some(
      f => f.status === "FAIL"
    )
  ) {
    return "ATTENTION";
  }

  if (
    findings.some(
      f =>
        f.status === "CHECK_REQUIRED"
    )
  ) {
    return "CHECK_REQUIRED";
  }

  return "PASS";
}

async function updateInspectionResult(
  env: Env,
  inspectionId: string,
  result:
    "PASS" |
    "ATTENTION" |
    "CHECK_REQUIRED"
): Promise<void> {
  await env.SAFETY_DB
    .prepare(`
      UPDATE inspections
      SET overall_result = ?
      WHERE id = ?
    `)
    .bind(
      result,
      inspectionId
    )
    .run();
}

async function handleAnalyse(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body =
      await request.json() as {
        image?: string;
        fileName?: string;
        contentType?: string;
        location?: string;
        inspector?: string;
      };

    if (
      !body.image ||
      typeof body.image !== "string"
    ) {
      return jsonResponse(
        {
          success: false,
          error: "Image is required."
        },
        400
      );
    }

    let imageData =
      body.image.trim();

    /*
     * Frontend normally sends:
     *
     * data:image/jpeg;base64,....
     *
     * Cloudflare's Vision model accepts the image
     * as a base64/data URI string.
     */

    if (
      !imageData.startsWith("data:image/")
    ) {
      /*
       * If only raw base64 was supplied,
       * assume JPEG.
       */
      imageData =
        `data:${body.contentType || "image/jpeg"};base64,${imageData}`;
    }

    /*
     * Prevent accidentally sending a gigantic image.
     *
     * The browser should resize/compress the image
     * before sending it.
     */
    if (imageData.length > 15_000_000) {
      return jsonResponse(
        {
          success: false,
          error:
            "Image is too large. Please use a smaller photo."
        },
        413
      );
    }

    const checks =
      await loadSafetyChecks(env);

    const inspectionId =
      await createInspection(
        env,
        body.location || "",
        body.inspector || ""
      );

    const photoId =
      await savePhoto(
        env,
        inspectionId,
        body.fileName ||
          "inspection.jpg",
        body.contentType ||
          "image/jpeg"
      );

    let aiResult: AIResult;

    try {
      aiResult =
        await runAI(
          env,
          imageData,
          checks
        );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      /*
       * Keep the inspection record for audit/history,
       * but tell the frontend that AI analysis failed.
       */

      await updateInspectionResult(
        env,
        inspectionId,
        "CHECK_REQUIRED"
      );

      return jsonResponse(
        {
          success: false,
          error:
            `Workers AI analysis failed. ${message}`,
          inspection_id:
            inspectionId
        },
        500
      );
    }

    const findings =
      aiResult.findings || [];

    /*
     * Save findings.
     */
    if (findings.length) {
      await saveFindings(
        env,
        inspectionId,
        photoId,
        findings
      );
    }

    const overall =
      calculateOverall(findings);

    await updateInspectionResult(
      env,
      inspectionId,
      overall
    );

    /*
     * Return the exact structure expected by
     * the frontend.
     */
    return jsonResponse({
      success: true,

      inspection: {
        id: inspectionId,
        overall_result: overall,
        scene_summary:
          aiResult.scene_summary
      },

      findings
    });

  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return jsonResponse(
      {
        success: false,
        error: message
      },
      500
    );
  }
}

async function handleRecent(
  env: Env
): Promise<Response> {
  try {
    const result =
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
          ORDER BY created_at DESC
          LIMIT 20
        `)
        .all();

    const rows =
      result.results || [];

    const inspections =
      rows.map(
        (row: any) => ({
          id: row.id,
          inspection_no:
            row.inspection_no,
          location:
            row.location ||
            "Unspecified",
          inspector:
            row.inspector ||
            "Unspecified",
          created_at:
            row.created_at,
          overall_result:
            row.overall_result ||
            "CHECK_REQUIRED"
        })
      );

    const inspectionsCount =
      inspections.length;

    const attention =
      inspections.filter(
        (x: any) =>
          x.overall_result ===
          "ATTENTION"
      ).length;

    const checkRequired =
      inspections.filter(
        (x: any) =>
          x.overall_result ===
          "CHECK_REQUIRED"
      ).length;

    return jsonResponse({
      success: true,

      summary: {
        inspections:
          inspectionsCount,

        attention,

        check_required:
          checkRequired
      },

      inspections
    });

  } catch (error) {
    return jsonResponse(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      },
      500
    );
  }
}

async function handleInspection(
  env: Env,
  inspectionId: string
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
        `)
        .bind(inspectionId)
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

    const findings =
      await env.SAFETY_DB
        .prepare(`
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
        `)
        .bind(inspectionId)
        .all();

    return jsonResponse({
      success: true,
      inspection,
      findings:
        findings.results || []
    });

  } catch (error) {
    return jsonResponse(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : String(error)
      },
      500
    );
  }
}

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods":
      "GET, POST, OPTIONS",
    "access-control-allow-headers":
      "Content-Type"
  };
}

function addCors(
  response: Response
): Response {
  const headers =
    new Headers(response.headers);

  const cors =
    corsHeaders();

  for (
    const [key, value]
    of Object.entries(cors)
  ) {
    headers.set(key, value);
  }

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers
    }
  );
}

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {

    if (
      request.method === "OPTIONS"
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

    const url =
      new URL(request.url);

    try {

      /*
       * Health check
       */
      if (
        url.pathname ===
        "/api/health"
      ) {
        return addCors(
          jsonResponse({
            success: true,
            service:
              "Safety Inspection AI",
            model: MODEL
          })
        );
      }

      /*
       * Analyse uploaded photo
       */
      if (
        url.pathname ===
          "/api/analyse" &&
        request.method === "POST"
      ) {
        return addCors(
          await handleAnalyse(
            request,
            env
          )
        );
      }

      /*
       * Recent inspections
       */
      if (
        url.pathname ===
          "/api/inspections" &&
        request.method === "GET"
      ) {
        return addCors(
          await handleRecent(env)
        );
      }

      /*
       * Single inspection
       */
      if (
        url.pathname.startsWith(
          "/api/inspections/"
        ) &&
        request.method === "GET"
      ) {
        const id =
          decodeURIComponent(
            url.pathname.substring(
              "/api/inspections/"
                .length
            )
          );

        return addCors(
          await handleInspection(
            env,
            id
          )
        );
      }

      /*
       * Simple root endpoint.
       */
      if (
        url.pathname === "/" &&
        request.method === "GET"
      ) {
        return jsonResponse({
          service:
            "Safety Inspection AI",
          status: "running",
          model: MODEL,
          endpoints: [
            "POST /api/analyse",
            "GET /api/inspections",
            "GET /api/health"
          ]
        });
      }

      return addCors(
        jsonResponse(
          {
            success: false,
            error: "Not found"
          },
          404
        )
      );

    } catch (error) {

      return addCors(
        jsonResponse(
          {
            success: false,
            error:
              error instanceof Error
                ? error.message
                : String(error)
          },
          500
        )
      );
    }
  }
} satisfies ExportedHandler<Env>;
