/* ============================================================
   Safety Inspection AI
   Cloudflare Worker + Workers AI + D1

   Model:
   @cf/meta/llama-3.2-11b-vision-instruct

   D1 tables used:
   - inspections
   - inspection_photos
   - inspection_items
   - safety_checks

   No Vectorize required.
   No R2 required.

   IMPORTANT:
   inspection_photos.object_key is NOT NULL, therefore this
   Worker always supplies an object_key even when the image
   itself is not stored in R2.
   ============================================================ */

export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;

  // Optional R2 binding.
  // The Worker does not require it.
  SAFETY_BUCKET?: R2Bucket;
}

const MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_FINDINGS = 8;

/* ============================================================
   Types
   ============================================================ */

type OverallResult =
  | "PASS"
  | "ATTENTION"
  | "CHECK_REQUIRED";

type FindingStatus =
  | "PASS"
  | "FAIL"
  | "CHECK_REQUIRED";

type RiskLevel =
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
  keywords?: string;
  active?: number;
}

interface Finding {
  category: string;
  title: string;
  observation: string;
  status: FindingStatus;
  risk_level: RiskLevel;
  confidence: number;

  check_id?: string;
  source_title?: string;
  source_url?: string;
}

interface AIResult {
  summary?: string;
  scene_summary?: string;
  relevant_categories?: string[];
  findings?: Finding[];
}

interface InspectionRecord {
  id: string;
  inspection_no: string;
  location: string;
  inspector: string;
  created_at: string;
  overall_result: OverallResult;
}

interface AnalyzeRequest {
  image?: string;
  image_base64?: string;
  mime_type?: string;
  location?: string;
  inspector?: string;
  file_name?: string;
}

/* ============================================================
   CORS / JSON helpers
   ============================================================ */

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
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
          "application/json; charset=utf-8",
        ...corsHeaders(),
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
      "Content-Type": "text/plain; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

/* ============================================================
   General helpers
   ============================================================ */

function nowISO(): string {
  return new Date().toISOString();
}

function randomHex(length = 6): string {
  const chars =
    "0123456789ABCDEF";

  let result = "";

  for (let i = 0; i < length; i++) {
    result +=
      chars[
        Math.floor(
          Math.random() * chars.length
        )
      ];
  }

  return result;
}

function makeId(): string {
  return crypto.randomUUID();
}

function makeInspectionNo(
  date = new Date()
): string {
  const year =
    date.getUTCFullYear();

  const month =
    String(
      date.getUTCMonth() + 1
    ).padStart(2, "0");

  const day =
    String(
      date.getUTCDate()
    ).padStart(2, "0");

  return `SI-${year}${month}${day}-${randomHex(
    6
  )}`;
}

function safeString(
  value: unknown,
  fallback = ""
): string {
  if (
    typeof value === "string" &&
    value.trim()
  ) {
    return value.trim();
  }

  return fallback;
}

function clamp(
  value: number,
  min: number,
  max: number
): number {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

function normaliseStatus(
  value: unknown
): FindingStatus {
  const v =
    String(value ?? "")
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");

  if (v === "FAIL") {
    return "FAIL";
  }

  if (
    v === "CHECK_REQUIRED" ||
    v === "CHECK" ||
    v === "REVIEW" ||
    v === "ATTENTION"
  ) {
    return "CHECK_REQUIRED";
  }

  if (
    v === "PASS" ||
    v === "SAFE" ||
    v === "OK"
  ) {
    return "PASS";
  }

  return "CHECK_REQUIRED";
}

function normaliseRisk(
  value: unknown
): RiskLevel {
  const v =
    String(value ?? "")
      .trim()
      .toUpperCase();

  if (v === "HIGH") {
    return "HIGH";
  }

  if (v === "LOW") {
    return "LOW";
  }

  return "MEDIUM";
}

/* ============================================================
   Overall result

   IMPORTANT:
   Empty findings MUST NOT become PASS.
   ============================================================ */

function calculateOverall(
  findings: Finding[]
): OverallResult {

  if (
    !findings ||
    findings.length === 0
  ) {
    return "CHECK_REQUIRED";
  }

  if (
    findings.some(
      (f) => f.status === "FAIL"
    )
  ) {
    return "ATTENTION";
  }

  if (
    findings.some(
      (f) =>
        f.status ===
        "CHECK_REQUIRED"
    )
  ) {
    return "CHECK_REQUIRED";
  }

  return "PASS";
}

/* ============================================================
   Base64 helpers
   ============================================================ */

function arrayBufferToBase64(
  buffer: ArrayBuffer
): string {
  const bytes =
    new Uint8Array(buffer);

  const chunkSize = 0x8000;

  let binary = "";

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

/* ============================================================
   Image normalisation

   Cloudflare's Llama Vision model expects:
       image: string

   We therefore send a data URL such as:
       data:image/jpeg;base64,...
   ============================================================ */

function normaliseImageDataUrl(
  image: string,
  mimeType = "image/jpeg"
): string {

  const value =
    image.trim();

  if (
    value.startsWith(
      "data:image/"
    )
  ) {
    return value;
  }

  return `data:${mimeType};base64,${value}`;
}

/* ============================================================
   Request parser

   Supports:

   1. application/json

   {
     "image": "...",
     "location": "Depot P10",
     "inspector": "John"
   }

   2. multipart/form-data

   image=<file>
   location=...
   inspector=...
   ============================================================ */

async function parseAnalyzeRequest(
  request: Request
): Promise<AnalyzeRequest> {

  const contentType =
    request.headers.get(
      "content-type"
    ) || "";

  if (
    contentType.includes(
      "multipart/form-data"
    )
  ) {
    const form =
      await request.formData();

    const imageField =
      form.get("image") ||
      form.get("photo") ||
      form.get("file");

    let image = "";
    let mimeType =
      "image/jpeg";
    let fileName =
      "inspection.jpg";

    if (
      imageField instanceof File
    ) {
      if (
        imageField.size >
        MAX_IMAGE_BYTES
      ) {
        throw new Error(
          `Image is too large. Maximum allowed size is ${Math.round(
            MAX_IMAGE_BYTES /
              1024 /
              1024
          )} MB.`
        );
      }

      mimeType =
        imageField.type ||
        "image/jpeg";

      fileName =
        imageField.name ||
        "inspection.jpg";

      const buffer =
        await imageField.arrayBuffer();

      image =
        arrayBufferToBase64(
          buffer
        );
    } else if (
      typeof imageField ===
      "string"
    ) {
      image = imageField;
    }

    return {
      image,
      mime_type: mimeType,
      file_name: fileName,

      location:
        safeString(
          form.get("location")
        ),

      inspector:
        safeString(
          form.get("inspector")
        ),
    };
  }

  const body =
    await request.json();

  return {
    image:
      safeString(
        body?.image ||
          body?.image_base64
      ),

    image_base64:
      safeString(
        body?.image_base64
      ),

    mime_type:
      safeString(
        body?.mime_type,
        "image/jpeg"
      ),

    file_name:
      safeString(
        body?.file_name,
        "inspection.jpg"
      ),

    location:
      safeString(
        body?.location
      ),

    inspector:
      safeString(
        body?.inspector
      ),
  };
}

/* ============================================================
   D1 helpers
   ============================================================ */

async function tableExists(
  db: D1Database,
  tableName: string
): Promise<boolean> {

  const row =
    await db
      .prepare(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = ?
        LIMIT 1
        `
      )
      .bind(tableName)
      .first();

  return !!row;
}

/* ============================================================
   Load active WSH checks

   The AI does NOT invent WSH source URLs.
   The model selects check_id.
   The Worker gets the official check/source
   from D1.
   ============================================================ */

async function loadSafetyChecks(
  db: D1Database
): Promise<SafetyCheck[]> {

  const exists =
    await tableExists(
      db,
      "safety_checks"
    );

  if (!exists) {
    return [];
  }

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

  return result.results || [];
}

/* ============================================================
   Create inspection
   ============================================================ */

async function createInspection(
  db: D1Database,
  location: string,
  inspector: string
): Promise<InspectionRecord> {

  const id =
    makeId();

  const inspectionNo =
    makeInspectionNo();

  const createdAt =
    nowISO();

  const result =
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
        id,
        inspectionNo,
        location,
        inspector,
        createdAt,
        "CHECK_REQUIRED"
      )
      .run();

  if (!result.success) {
    throw new Error(
      "Unable to create inspection."
    );
  }

  return {
    id,
    inspection_no:
      inspectionNo,
    location,
    inspector,
    created_at:
      createdAt,
    overall_result:
      "CHECK_REQUIRED",
  };
}

/* ============================================================
   Save photo metadata

   object_key is required by your existing schema.

   We don't need R2 for the AI workflow.
   ============================================================ */

async function savePhoto(
  db: D1Database,
  inspectionId: string,
  fileName: string,
  contentType: string
): Promise<string> {

  const photoId =
    makeId();

  const objectKey =
    `inspections/${inspectionId}/${photoId}-${fileName}`;

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

/* ============================================================
   Save finding

   Matches the user's actual inspection_items schema:

   id
   inspection_id
   photo_id
   category
   title
   observation
   status
   risk_level
   confidence
   check_id
   source_title
   source_url
   created_at
   ============================================================ */

async function saveFinding(
  db: D1Database,
  inspectionId: string,
  photoId: string,
  finding: Finding
): Promise<void> {

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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .bind(
      makeId(),
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

/* ============================================================
   Update overall result
   ============================================================ */

async function updateInspectionResult(
  db: D1Database,
  inspectionId: string,
  overall: OverallResult
): Promise<void> {

  await db
    .prepare(
      `
      UPDATE inspections
      SET overall_result = ?
      WHERE id = ?
      `
    )
    .bind(
      overall,
      inspectionId
    )
    .run();
}

/* ============================================================
   Build WSH reference text
   ============================================================ */

function buildCheckReference(
  checks: SafetyCheck[]
): string {

  if (!checks.length) {
    return `
No WSH checks were available from the database.

Do not invent source URLs.
Only report clearly visible safety observations.
`;
  }

  return checks
    .slice(0, 30)
    .map(
      (check) =>
        `
CHECK ID: ${check.id}
CATEGORY: ${check.category}
QUESTION: ${check.check_question}
GUIDANCE: ${check.guidance}
SOURCE TITLE: ${check.source_title}
SOURCE URL: ${check.source_url}
KEYWORDS: ${check.keywords || ""}
`
    )
    .join("\n");
}

/* ============================================================
   AI JSON schema

   Keep schema relatively simple to reduce model errors
   and Workers AI resource usage.
   ============================================================ */

const AI_SCHEMA = {
  type: "object",

  properties: {
    summary: {
      type: "string",
    },

    relevant_categories: {
      type: "array",
      items: {
        type: "string",
      },
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
              "FAIL",
              "CHECK_REQUIRED",
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
    "relevant_categories",
    "findings",
  ],
};

/* ============================================================
   AI prompt
   ============================================================ */

function buildSystemPrompt(
  checkReference: string
): string {

  return `
You are a workplace safety inspection assistant.

You analyse ONE workplace photograph.

This is NOT a general image captioning task.

Your job is to identify only safety conditions that can reasonably
be assessed from visible evidence in the photograph.

IMPORTANT RULES:

1. Do NOT assume every safety category applies.
2. Do NOT automatically check PPE, housekeeping, work at height,
   lifting, vehicular safety, electrical safety or fire safety.
3. First determine what activity and hazards are actually visible.
4. Only create findings for relevant visible conditions.
5. If something cannot be determined from the photograph,
   use CHECK_REQUIRED rather than FAIL.
6. Do not invent hazards.
7. Do not invent PPE requirements.
8. Do not claim that a person is exposed to a hazard unless
   there is visible evidence.
9. Do not infer a hidden vehicle, electrical hazard, fire hazard,
   lifting load or work-at-height activity.
10. A crane or container visible in the background does NOT by itself
    mean the worker is performing lifting work.
11. A guardrail visible in the image does NOT automatically mean
    that work at height is occurring.
12. Only use a WSH check from the supplied check list.
13. Use its exact check_id.
14. Never invent source_title or source_url.
15. The server will attach the official source information.
16. Maximum 8 findings.
17. Prefer fewer accurate findings over many speculative findings.

STATUS:

PASS:
The visible evidence supports that the condition appears satisfactory.

FAIL:
There is clear visible evidence of a safety deficiency.

CHECK_REQUIRED:
The condition is relevant but cannot be confidently determined
from the photograph.

RISK:

LOW:
Minor or low-consequence visible issue.

MEDIUM:
Potential meaningful safety risk requiring verification or correction.

HIGH:
Clear potentially serious safety hazard.

CONFIDENCE:
Use a number between 0 and 1.
Do not automatically use 0.95 or 0.90.
Confidence must reflect the visible evidence.

FINDING TITLE:
Use a short practical title such as:
"Worker wearing required visible PPE"
"Guardrail appears incomplete"
"Poor housekeeping"
"No clear pedestrian segregation"

OBSERVATION:
Describe only what is visible.
Do not describe hidden conditions.

${checkReference}
`;
}

/* ============================================================
   Call Workers AI
   ============================================================ */

async function runVisionAI(
  env: Env,
  imageDataUrl: string,
  checks: SafetyCheck[]
): Promise<{
  raw: string;
  parsed: AIResult | null;
}> {

  const systemPrompt =
    buildSystemPrompt(
      buildCheckReference(
        checks
      )
    );

  const userPrompt = `
Analyse the attached workplace photograph.

Return ONLY JSON matching the requested schema.

Determine:
- what workplace activity is visible
- which WSH categories are actually relevant
- visible safety findings only
- the appropriate WSH check_id for each finding

Do not create findings for categories that are not relevant.

If there is insufficient visual evidence for a relevant check,
use CHECK_REQUIRED.

If the photograph contains no identifiable safety finding,
return an empty findings array.
`;

  const response =
    await env.AI.run(
      MODEL,
      {
        messages: [
          {
            role: "system",
            content:
              systemPrompt,
          },
          {
            role: "user",
            content:
              userPrompt,
          },
        ],

        image:
          imageDataUrl,

        response_format: {
          type: "json_schema",
          json_schema:
            AI_SCHEMA,
        },

        max_tokens: 1200,

        temperature: 0.1,

        top_p: 0.9,
      } as any
    );

  const raw =
    extractAIText(
      response
    );

  const parsed =
    parseAIResult(
      raw
    );

  return {
    raw,
    parsed,
  };
}

/* ============================================================
   Extract AI response text

   Workers AI normally returns:
       { response: "..." }

   But we support several shapes to avoid breaking when
   the response wrapper changes.
   ============================================================ */

function extractAIText(
  value: unknown
): string {

  if (
    typeof value === "string"
  ) {
    return value;
  }

  if (!value) {
    return "";
  }

  const obj =
    value as Record<
      string,
      unknown
    >;

  if (
    typeof obj.response ===
    "string"
  ) {
    return obj.response;
  }

  if (
    typeof obj.result ===
    "string"
  ) {
    return obj.result;
  }

  if (
    typeof obj.text ===
    "string"
  ) {
    return obj.text;
  }

  if (
    obj.response &&
    typeof obj.response ===
      "object"
  ) {
    return extractAIText(
      obj.response
    );
  }

  return JSON.stringify(
    value
  );
}

/* ============================================================
   Robust JSON extraction

   Supports:

   1. Pure JSON
   2. ```json ... ```
   3. Text before JSON
   4. Text after JSON
   ============================================================ */

function extractJSONObject(
  text: string
): unknown | null {

  const cleaned =
    text
      .trim()
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
      cleaned
    );
  } catch {
    // Continue.
  }

  const firstObject =
    cleaned.indexOf("{");

  const lastObject =
    cleaned.lastIndexOf("}");

  if (
    firstObject >= 0 &&
    lastObject > firstObject
  ) {
    const candidate =
      cleaned.slice(
        firstObject,
        lastObject + 1
      );

    try {
      return JSON.parse(
        candidate
      );
    } catch {
      // Continue.
    }
  }

  return null;
}

/* ============================================================
   Natural-language fallback parser

   This is deliberately conservative.

   It tries to extract findings from older model responses
   such as:

   **PPE**
   Category: PPE
   Title: Worker's PPE
   Observation: ...
   Status: PASS
   Risk Level: LOW
   Confidence: 0.90
   Check ID: ppe-001
   ============================================================ */

function parseNaturalLanguageFindings(
  text: string
): Finding[] {

  const findings: Finding[] = [];

  if (!text.trim()) {
    return findings;
  }

  const categoryMatches =
    [
      "PPE",
      "Housekeeping",
      "Vehicular Safety",
      "Work at Height",
      "Lifting",
      "Electrical Safety",
      "Fire Safety",
      "Storage",
      "Other",
    ];

  const lines =
    text
      .split(/\r?\n/)
      .map(
        (line) =>
          line
            .replace(
              /^\s*[*#-]+\s*/,
              ""
            )
            .trim()
      )
      .filter(Boolean);

  let current:
    Partial<Finding> | null =
    null;

  function finish() {

    if (
      current &&
      current.category &&
      current.title &&
      current.observation
    ) {
      findings.push({
        category:
          current.category,

        title:
          current.title,

        observation:
          current.observation,

        status:
          normaliseStatus(
            current.status
          ),

        risk_level:
          normaliseRisk(
            current.risk_level
          ),

        confidence:
          clamp(
            Number(
              current.confidence ??
                0.5
            ),
            0,
            1
          ),

        check_id:
          current.check_id,
      });
    }

    current = null;
  }

  for (
    const line of lines
  ) {

    const category =
      categoryMatches.find(
        (item) =>
          line
            .toLowerCase()
            .startsWith(
              item.toLowerCase()
            )
      );

    if (
      category &&
      (
        line.includes(":") ||
        line.startsWith(
          category
        )
      )
    ) {

      if (current) {
        finish();
      }

      current = {
        category,
        title:
          line
            .split(":")
            .slice(1)
            .join(":")
            .trim() ||
          category,
        observation: "",
      };

      continue;
    }

    if (!current) {
      continue;
    }

    const match =
      line.match(
        /^([^:]+):\s*(.*)$/
      );

    if (!match) {
      if (
        current.observation
      ) {
        current.observation +=
          " " + line;
      } else {
        current.observation =
          line;
      }

      continue;
    }

    const key =
      match[1]
        .trim()
        .toLowerCase();

    const value =
      match[2].trim();

    if (
      key === "category"
    ) {
      current.category =
        value;
    } else if (
      key === "title"
    ) {
      current.title =
        value;
    } else if (
      key === "observation"
    ) {
      current.observation =
        value;
    } else if (
      key === "status"
    ) {
      current.status =
        normaliseStatus(
          value
        );
    } else if (
      key === "risk" ||
      key === "risk level"
    ) {
      current.risk_level =
        normaliseRisk(
          value
        );
    } else if (
      key === "confidence"
    ) {
      let confidence =
        Number(
          value
            .replace(
              "%",
              ""
            )
            .trim()
        );

      if (
        value.includes("%")
      ) {
        confidence /=
          100;
      }

      current.confidence =
        confidence;
    } else if (
      key === "check id" ||
      key === "check_id"
    ) {
      current.check_id =
        value;
    } else if (
      key ===
      "source title"
    ) {
      current.source_title =
        value;
    } else if (
      key === "source url"
    ) {
      current.source_url =
        value;
    }
  }

  if (current) {
    finish();
  }

  return findings.slice(
    0,
    MAX_FINDINGS
  );
}

/* ============================================================
   Parse AI result
   ============================================================ */

function parseAIResult(
  raw: string
): AIResult | null {

  if (!raw.trim()) {
    return null;
  }

  const json =
    extractJSONObject(
      raw
    );

  if (json) {

    const obj =
      json as Record<
        string,
        unknown
      >;

    let findingsRaw =
      obj.findings;

    if (
      !Array.isArray(
        findingsRaw
      ) &&
      obj.response &&
      typeof obj.response ===
        "object"
    ) {
      const responseObj =
        obj.response as Record<
          string,
          unknown
        >;

      findingsRaw =
        responseObj.findings;
    }

    if (
      !Array.isArray(
        findingsRaw
      )
    ) {
      findingsRaw = [];
    }

    return {
      summary:
        safeString(
          obj.summary ||
            obj.scene_summary
        ),

      scene_summary:
        safeString(
          obj.scene_summary ||
            obj.summary
        ),

      relevant_categories:
        Array.isArray(
          obj.relevant_categories
        )
          ? obj.relevant_categories
              .map(
                (x) =>
                  String(x)
              )
          : [],

      findings:
        findingsRaw
          .map(
            normaliseFinding
          )
          .filter(
            (
              x
            ): x is Finding =>
              x !== null
          )
          .slice(
            0,
            MAX_FINDINGS
          ),
    };
  }

  const textFindings =
    parseNaturalLanguageFindings(
      raw
    );

  if (
    textFindings.length
  ) {
    return {
      summary:
        "Workplace scene analysed.",
      scene_summary:
        "Workplace scene analysed.",
      relevant_categories:
        textFindings.map(
          (f) =>
            f.category
        ),
      findings:
        textFindings,
    };
  }

  return null;
}

/* ============================================================
   Normalise individual AI finding
   ============================================================ */

function normaliseFinding(
  value: unknown
): Finding | null {

  if (
    !value ||
    typeof value !==
      "object"
  ) {
    return null;
  }

  const item =
    value as Record<
      string,
      unknown
    >;

  const category =
    safeString(
      item.category,
      "Other"
    );

  const title =
    safeString(
      item.title,
      "Safety observation"
    );

  const observation =
    safeString(
      item.observation
    );

  if (
    !observation
  ) {
    return null;
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
    confidence = 0.5;
  }

  if (
    confidence > 1 &&
    confidence <= 100
  ) {
    confidence /=
      100;
  }

  confidence =
    clamp(
      confidence,
      0,
      1
    );

  return {
    category,
    title,
    observation,

    status:
      normaliseStatus(
        item.status
      ),

    risk_level:
      normaliseRisk(
        item.risk_level
      ),

    confidence,

    check_id:
      safeString(
        item.check_id
      ) || undefined,
  };
}

/* ============================================================
   Match AI finding to official D1 safety check

   The AI can select a check_id.

   If the model gives an invalid ID, we attempt a safe
   category match. If there is still no match, the finding
   remains without a source instead of inventing one.
   ============================================================ */

function attachOfficialCheck(
  finding: Finding,
  checks: SafetyCheck[]
): Finding {

  if (!checks.length) {
    return finding;
  }

  let check:
    SafetyCheck | undefined;

  if (
    finding.check_id
  ) {
    check =
      checks.find(
        (c) =>
          c.id ===
          finding.check_id
      );
  }

  if (!check) {
    const category =
      finding.category
        .toLowerCase();

    check =
      checks.find(
        (c) =>
          c.category
            .toLowerCase() ===
          category
      );
  }

  if (!check) {
    return {
      ...finding,
      check_id:
        undefined,
      source_title:
        undefined,
      source_url:
        undefined,
    };
  }

  return {
    ...finding,

    check_id:
      check.id,

    source_title:
      check.source_title,

    source_url:
      check.source_url,
  };
}

/* ============================================================
   API: Health
   ============================================================ */

async function handleHealth(
  env: Env
): Promise<Response> {

  let db = false;
  let checks = false;

  try {
    db =
      await tableExists(
        env.SAFETY_DB,
        "inspections"
      );

    checks =
      await tableExists(
        env.SAFETY_DB,
        "safety_checks"
      );
  } catch {
    // leave false
  }

  return jsonResponse({
    ok: true,
    service:
      "Safety Inspection AI",
    model: MODEL,
    database:
      db,
    safety_checks:
      checks,
    vectorize:
      false,
    timestamp:
      nowISO(),
  });
}

/* ============================================================
   API: Safety checks
   ============================================================ */

async function handleSafetyChecks(
  env: Env
): Promise<Response> {

  const checks =
    await loadSafetyChecks(
      env.SAFETY_DB
    );

  return jsonResponse({
    success: true,
    count:
      checks.length,
    checks,
  });
}

/* ============================================================
   API: Recent inspections
   ============================================================ */

async function handleInspections(
  env: Env,
  request: Request
): Promise<Response> {

  const url =
    new URL(
      request.url
    );

  const limitRaw =
    Number(
      url.searchParams.get(
        "limit"
      ) || "20"
    );

  const limit =
    clamp(
      Number.isFinite(
        limitRaw
      )
        ? limitRaw
        : 20,
      1,
      50
    );

  const result =
    await env.SAFETY_DB
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
        LIMIT ?
        `
      )
      .bind(limit)
      .all<InspectionRecord>();

  return jsonResponse({
    success: true,
    inspections:
      result.results || [],
  });
}

/* ============================================================
   API: Inspection detail
   ============================================================ */

async function handleInspectionDetail(
  env: Env,
  id: string
): Promise<Response> {

  const inspection =
    await env.SAFETY_DB
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
      .bind(id)
      .first<InspectionRecord>();

  if (!inspection) {
    return jsonResponse(
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
        FROM inspection_items
        WHERE inspection_id = ?
        ORDER BY created_at ASC
        `
      )
      .bind(id)
      .all();

  return jsonResponse({
    success: true,
    inspection,
    findings:
      findings.results || [],
  });
}

/* ============================================================
   API: Analyse photo
   ============================================================ */

async function handleAnalyze(
  env: Env,
  request: Request
): Promise<Response> {

  let inspection:
    InspectionRecord | null =
    null;

  try {

    const input =
      await parseAnalyzeRequest(
        request
      );

    let image =
      safeString(
        input.image ||
          input.image_base64
      );

    if (!image) {
      return jsonResponse(
        {
          success: false,
          error:
            "No image was supplied.",
        },
        400
      );
    }

    /*
     * If a full data URL is supplied, estimate its size
     * from the base64 component.
     */
    if (
      image.startsWith(
        "data:image/"
      )
    ) {
      const comma =
        image.indexOf(",");

      if (comma >= 0) {
        const base64 =
          image.slice(
            comma + 1
          );

        const estimatedBytes =
          Math.floor(
            base64.length *
              0.75
          );

        if (
          estimatedBytes >
          MAX_IMAGE_BYTES
        ) {
          return jsonResponse(
            {
              success: false,
              error:
                "Image is too large. Please use an image smaller than 6 MB.",
            },
            413
          );
        }
      }
    }

    const mimeType =
      safeString(
        input.mime_type,
        "image/jpeg"
      );

    const fileName =
      safeString(
        input.file_name,
        "inspection.jpg"
      );

    const location =
      safeString(
        input.location,
        "Unspecified"
      );

    const inspector =
      safeString(
        input.inspector,
        "Unspecified"
      );

    const imageDataUrl =
      normaliseImageDataUrl(
        image,
        mimeType
      );

    /*
     * Check required tables before doing the AI call.
     * This avoids wasting Workers AI usage if the database
     * schema is incomplete.
     */
    const inspectionsExists =
      await tableExists(
        env.SAFETY_DB,
        "inspections"
      );

    const photosExists =
      await tableExists(
        env.SAFETY_DB,
        "inspection_photos"
      );

    const itemsExists =
      await tableExists(
        env.SAFETY_DB,
        "inspection_items"
      );

    if (
      !inspectionsExists ||
      !photosExists ||
      !itemsExists
    ) {
      return jsonResponse(
        {
          success: false,
          error:
            "Required D1 tables are missing.",
          required_tables: {
            inspections:
              inspectionsExists,
            inspection_photos:
              photosExists,
            inspection_items:
              itemsExists,
          },
        },
        500
      );
    }

    /*
     * Create inspection BEFORE AI.
     *
     * This means even if Workers AI fails, the inspection
     * exists and can be marked CHECK_REQUIRED.
     */
    inspection =
      await createInspection(
        env.SAFETY_DB,
        location,
        inspector
      );

    /*
     * Save photo metadata.
     *
     * object_key is mandatory in the existing schema.
     */
    const photoId =
      await savePhoto(
        env.SAFETY_DB,
        inspection.id,
        fileName,
        mimeType
      );

    /*
     * Load WSH checks.
     */
    const checks =
      await loadSafetyChecks(
        env.SAFETY_DB
      );

    let aiRaw = "";
    let aiResult:
      AIResult | null =
      null;

    try {

      const ai =
        await runVisionAI(
          env,
          imageDataUrl,
          checks
        );

      aiRaw =
        ai.raw;

      aiResult =
        ai.parsed;

    } catch (
      aiError
    ) {

      /*
       * AI failed.
       *
       * Keep inspection in CHECK_REQUIRED.
       */
      await updateInspectionResult(
        env.SAFETY_DB,
        inspection.id,
        "CHECK_REQUIRED"
      );

      return jsonResponse(
        {
          success: false,

          error:
            "Workers AI analysis failed.",

          detail:
            aiError instanceof Error
              ? aiError.message
              : String(
                  aiError
                ),

          inspection_id:
            inspection.id,

          inspection_no:
            inspection.inspection_no,

          overall_result:
            "CHECK_REQUIRED",
        },
        500
      );
    }

    /*
     * AI returned something but it wasn't usable JSON
     * and our natural-language parser couldn't extract
     * structured findings.
     */
    if (!aiResult) {

      await updateInspectionResult(
        env.SAFETY_DB,
        inspection.id,
        "CHECK_REQUIRED"
      );

      return jsonResponse(
        {
          success: false,

          error:
            "Workers AI did not return usable structured findings.",

          inspection_id:
            inspection.id,

          inspection_no:
            inspection.inspection_no,

          overall_result:
            "CHECK_REQUIRED",

          model_response:
            aiRaw.slice(
              0,
              4000
            ),
        },
        422
      );
    }

    /*
     * Normalise and attach official WSH sources.
     */
    const findings =
      (aiResult.findings || [])
        .map(
          (finding) =>
            attachOfficialCheck(
              finding,
              checks
            )
        )
        .slice(
          0,
          MAX_FINDINGS
        );

    /*
     * CRITICAL:
     *
     * No findings is NOT PASS.
     */
    if (
      findings.length === 0
    ) {

      await updateInspectionResult(
        env.SAFETY_DB,
        inspection.id,
        "CHECK_REQUIRED"
      );

      return jsonResponse(
        {
          success: true,

          analysis_completed:
            true,

          inspection_id:
            inspection.id,

          inspection_no:
            inspection.inspection_no,

          overall_result:
            "CHECK_REQUIRED",

          summary:
            aiResult.summary ||
            "The AI completed the image analysis but did not return any structured safety findings.",

          relevant_categories:
            aiResult.relevant_categories ||
            [],

          findings: [],

          warning:
            "No structured findings were returned. Physical/site verification is required.",
        }
      );
    }

    /*
     * Save findings.
     */
    for (
      const finding of findings
    ) {
      await saveFinding(
        env.SAFETY_DB,
        inspection.id,
        photoId,
        finding
      );
    }

    /*
     * Calculate overall result.
     */
    const overall =
      calculateOverall(
        findings
      );

    await updateInspectionResult(
      env.SAFETY_DB,
      inspection.id,
      overall
    );

    /*
     * Return the complete result.
     */
    return jsonResponse({
      success: true,

      analysis_completed:
        true,

      inspection: {
        ...inspection,
        overall_result:
          overall,
      },

      inspection_id:
        inspection.id,

      inspection_no:
        inspection.inspection_no,

      summary:
        aiResult.summary ||
        "Workplace scene analysed.",

      scene_summary:
        aiResult.scene_summary ||
        aiResult.summary ||
        "Workplace scene analysed.",

      relevant_categories:
        aiResult.relevant_categories ||
        [],

      overall_result:
        overall,

      findings,

      physical_verification_required:
        true,

      disclaimer:
        "AI findings are assistance for inspection. Physical/site verification is required before recording a compliance decision.",
    });

  } catch (error) {

    /*
     * If an inspection was already created but something later
     * failed, make sure it cannot remain falsely marked PASS.
     */
    if (inspection) {
      try {
        await updateInspectionResult(
          env.SAFETY_DB,
          inspection.id,
          "CHECK_REQUIRED"
        );
      } catch {
        // Ignore secondary DB error.
      }
    }

    return jsonResponse(
      {
        success: false,

        error:
          "AI analysis failed.",

        detail:
          error instanceof Error
            ? error.message
            : String(error),

        inspection_id:
          inspection?.id,

        inspection_no:
          inspection?.inspection_no,

        overall_result:
          "CHECK_REQUIRED",
      },
      500
    );
  }
}

/* ============================================================
   Root endpoint
   ============================================================ */

function handleRoot(): Response {
  return jsonResponse({
    service:
      "Safety Inspection AI",
    status:
      "running",
    model: MODEL,

    endpoints: {
      health:
        "/api/health",

      safety_checks:
        "/api/safety-checks",

      inspections:
        "/api/inspections",

      analyze:
        "POST /api/analyze",

      inspection:
        "GET /api/inspections/:id",
    },

    version:
      "2026-08-14-activity-driven",
  });
}

/* ============================================================
   Main Worker
   ============================================================ */

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {

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

    const url =
      new URL(
        request.url
      );

    const path =
      url.pathname;

    try {

      /* ------------------------------------------------------
         Root
         ------------------------------------------------------ */

      if (
        request.method ===
          "GET" &&
        (
          path === "/" ||
          path === ""
        )
      ) {
        return handleRoot();
      }

      /* ------------------------------------------------------
         Health
         ------------------------------------------------------ */

      if (
        request.method ===
          "GET" &&
        path ===
          "/api/health"
      ) {
        return handleHealth(
          env
        );
      }

      /* ------------------------------------------------------
         Safety checks
         ------------------------------------------------------ */

      if (
        request.method ===
          "GET" &&
        path ===
          "/api/safety-checks"
      ) {
        return handleSafetyChecks(
          env
        );
      }

      /* ------------------------------------------------------
         Recent inspections
         ------------------------------------------------------ */

      if (
        request.method ===
          "GET" &&
        path ===
          "/api/inspections"
      ) {
        return handleInspections(
          env,
          request
        );
      }

      /* ------------------------------------------------------
         Inspection detail
         ------------------------------------------------------ */

      const inspectionMatch =
        path.match(
          /^\/api\/inspections\/([^/]+)$/
        );

      if (
        request.method ===
          "GET" &&
        inspectionMatch
      ) {
        return handleInspectionDetail(
          env,
          inspectionMatch[1]
        );
      }

      /* ------------------------------------------------------
         Analyse
         ------------------------------------------------------ */

      if (
        request.method ===
          "POST" &&
        path ===
          "/api/analyze"
      ) {
        return handleAnalyze(
          env,
          request
        );
      }

      return jsonResponse(
        {
          success: false,
          error:
            "API endpoint not found.",
          path,
        },
        404
      );

    } catch (error) {

      return jsonResponse(
        {
          success: false,
          error:
            "Worker error.",
          detail:
            error instanceof Error
              ? error.message
              : String(error),
        },
        500
      );
    }
  },
} satisfies ExportedHandler<Env>;
