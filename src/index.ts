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
        "Cache-Control":
          "no-store",
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

function textResponse(
  value: string,
  status = 200
): Response {
  return new Response(
    value,
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

function nowISO(): string {
  return new Date().toISOString();
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

  if (
    type === "image/png"
  ) {
    return "image/png";
  }

  if (
    type === "image/webp"
  ) {
    return "image/webp";
  }

  if (
    type === "image/gif"
  ) {
    return "image/gif";
  }

  if (
    type === "image/heic"
  ) {
    return "image/heic";
  }

  if (
    type === "image/heif"
  ) {
    return "image/heif";
  }

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
  const name =
    value
      .replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      )
      .substring(0, 150);

  return (
    name ||
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
   REQUEST PARSING
   ========================================================= */

async function parseRequest(
  request: Request
): Promise<ParsedRequest> {
  const contentType =
    request.headers.get(
      "content-type"
    ) || "";

  /* -------------------------------------------------------
     MULTIPART
     ------------------------------------------------------- */

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

    const names = [
      "image",
      "photo",
      "file",
      "photoFile",
    ];

    for (
      const name of names
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
        const [
          ,
          value,
        ] of form.entries()
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
        "The image is larger than 12 MB."
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
        ),

      inspector:
        clean(
          form.get(
            "inspector"
          ),
          200
        ),
    };
  }

  /* -------------------------------------------------------
     JSON
     ------------------------------------------------------- */

  let body: any;

  try {
    body =
      await request.json();
  } catch {
    throw new Error(
      "Request body is not valid JSON."
    );
  }

  const image =
    body?.image ||
    body?.imageBase64 ||
    body?.photo;

  if (
    typeof image !==
      "string" ||
    !image.trim()
  ) {
    throw new Error(
      "No image was supplied."
    );
  }

  let base64 =
    image.trim();

  let imageType =
    normalizeContentType(
      body?.mimeType ||
        body?.contentType ||
        "image/jpeg"
    );

  const dataUrlMatch =
    base64.match(
      /^data:(image\/[^;]+);base64,(.+)$/s
    );

  if (
    dataUrlMatch
  ) {
    imageType =
      normalizeContentType(
        dataUrlMatch[1]
      );

    base64 =
      dataUrlMatch[2];
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
      ),

    inspector:
      clean(
        body?.inspector,
        200
      ),
  };
}

/* =========================================================
   D1 TABLE / COLUMN HELPERS

   This version checks the actual database schema instead of
   assuming every column exists.

   This is important because your database has changed during
   development.
   ========================================================= */

async function getTableColumns(
  db: D1Database,
  table: string
): Promise<Set<string>> {
  const allowedTables = [
    "inspections",
    "inspection_photos",
    "findings",
    "safety_checks",
    "corrective_actions",
  ];

  if (
    !allowedTables.includes(
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
  const allowedTables = [
    "inspections",
    "inspection_photos",
    "findings",
    "safety_checks",
    "corrective_actions",
  ];

  if (
    !allowedTables.includes(
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
          columns.has(column)
      );

  if (!selected.length) {
    throw new Error(
      `No matching columns found for table ${table}.`
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
      (x) =>
        !columns.has(x)
    );

  if (missing.length) {
    throw new Error(
      `safety_checks is missing columns: ${missing.join(", ")}`
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
        LIMIT 30
        `
      )
      .all<SafetyCheck>();

  return (
    result.results || []
  );
}

/* =========================================================
   AI PROMPT
   ========================================================= */

function safetyCheckText(
  checks: SafetyCheck[]
): string {
  if (!checks.length) {
    return `
No safety checks are currently available.

Do not invent WSH source information.
`;
  }

  return checks
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
          200
        )}
`
    )
    .join("\n");
}

function buildPrompt(
  checks: SafetyCheck[]
): string {
  return `
You are a workplace safety inspection assistant for a Singapore shipping/container depot.

Analyse the attached photograph.

Your task is to identify ONLY safety conditions that can reasonably be determined from visible evidence.

IMPORTANT:

- Do not invent hazards.
- Do not invent activities.
- Do not assume every category applies.
- Do not automatically create PPE, housekeeping, work-at-height, lifting or vehicle findings.
- Only assess a category when there is visible evidence relevant to it.
- A crane in the background does not prove lifting is taking place.
- Containers in the background do not automatically indicate a storage hazard.
- If PPE is clearly visible, PPE can be assessed.
- If the work area/floor is visible, housekeeping can be assessed.
- If an elevated work area, ladder, scaffold, open edge or guardrail is visible, work-at-height may be assessed.
- If a suspended load, lifting operation, rigging or crane activity is clearly visible, lifting may be assessed.
- If vehicles and pedestrian routes are clearly visible, vehicular safety may be assessed.
- If electrical equipment or exposed wiring is visible, electrical safety may be assessed.
- If fire equipment or fire hazards are visible, fire safety may be assessed.
- If materials are visibly stored/stacked, storage may be assessed.

STATUS:

PASS:
The visible evidence supports that the condition appears satisfactory.

FAIL:
There is clear visible evidence of an unsafe condition.

CHECK_REQUIRED:
The condition is relevant but cannot be confidently determined from the photograph.

Do NOT create CHECK_REQUIRED findings for categories that simply cannot be seen.

RISK:

LOW:
Satisfactory condition or minor issue.

MEDIUM:
Potential safety concern requiring verification or correction.

HIGH:
Clearly visible potentially serious safety hazard.

CONFIDENCE:

Return confidence from 0 to 1.

Do not use 1.0 unless the visual evidence is exceptionally clear.

Return a concise inspection report.

For each finding use this format:

CATEGORY:
TITLE:
OBSERVATION:
STATUS:
RISK:
CONFIDENCE:
CHECK_ID:

Example:

CATEGORY: PPE
TITLE: Visible PPE appears appropriate
OBSERVATION: The worker is visibly wearing a hard hat and high-visibility vest.
STATUS: PASS
RISK: LOW
CONFIDENCE: 0.88
CHECK_ID: ppe-001

Another example:

CATEGORY: Housekeeping
TITLE: Work area appears clean
OBSERVATION: The visible floor area is generally clear of significant debris or spills.
STATUS: PASS
RISK: LOW
CONFIDENCE: 0.82
CHECK_ID: housekeeping-001

Do not include findings for categories that are not relevant.

Maximum 8 findings.

AVAILABLE WSH CHECKS:

${safetyCheckText(
  checks
)}
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
    buildPrompt(
      checks
    );

  const image =
    imageDataUrl(
      image,
      contentType
    );

  let response: any;

  try {
    /*
     * IMPORTANT:
     *
     * No response_format.
     * No JSON schema.
     *
     * This avoids the "JSON Mode couldn't be met"
     * problem and lets us parse the model response ourselves.
     *
     * Cloudflare documents the Vision model with messages
     * plus a separate image field.
     */

    response =
      await env.AI.run(
        MODEL,
        {
          messages: [
            {
              role: "system",
              content:
                "You are a careful workplace safety visual inspection assistant.",
            },
            {
              role: "user",
              content:
                prompt,
            },
          ],

          image,

          max_tokens: 900,

          temperature: 0.1,

          top_p: 0.8,
        } as any
      );
  } catch (error) {
    throw new Error(
      `Workers AI request error: ${
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

  if (!raw) {
    throw new Error(
      `Workers AI returned no text response. Raw response: ${JSON.stringify(
        response
      ).substring(0, 3000)}`
    );
  }

  return {
    raw,
    result: response,
  };
}

/* =========================================================
   TEXT PARSER
   ========================================================= */

function splitFindingBlocks(
  raw: string
): string[] {
  const text =
    raw
      .replace(
        /\r/g,
        ""
      )
      .trim();

  if (!text) {
    return [];
  }

  /*
   * Preferred format:
   *
   * CATEGORY:
   * TITLE:
   * OBSERVATION:
   * STATUS:
   *
   * Split whenever another CATEGORY begins.
   */

  const blocks =
    text.split(
      /(?=^\s*(?:\*\*)?\s*CATEGORY\s*[:\-])/gim
    );

  return blocks
    .map(
      (block) =>
        block.trim()
    )
    .filter(
      (block) =>
        block.length > 20
    );
}

function field(
  block: string,
  names: string[]
): string {
  for (
    const name of names
  ) {
    const regex =
      new RegExp(
        `(?:^|\\n)\\s*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*[:\\-]\\s*(.*)`,
        "im"
      );

    const match =
      block.match(regex);

    if (match) {
      return clean(
        match[1],
        1200
      );
    }
  }

  return "";
}

function inferStatus(
  observation: string,
  explicit: string
): Status {
  if (explicit) {
    const s =
      explicit.toUpperCase();

    if (
      s.includes("FAIL") ||
      s.includes("UNSAFE") ||
      s.includes(
        "NON_COMPLIANT"
      )
    ) {
      return "FAIL";
    }

    if (
      s.includes("PASS") ||
      s.includes("SAFE") ||
      s.includes(
        "COMPLIANT"
      )
    ) {
      return "PASS";
    }

    if (
      s.includes(
        "CHECK"
      )
    ) {
      return "CHECK_REQUIRED";
    }
  }

  const text =
    observation.toLowerCase();

  const failIndicators = [
    "no hard hat",
    "without hard hat",
    "missing ppe",
    "no safety vest",
    "not wearing",
    "unsafe",
    "spill",
    "oil spill",
    "blocked",
    "obstructed",
    "unguarded",
    "missing guardrail",
    "open edge",
    "exposed wire",
    "damaged cable",
    "suspended load above",
  ];

  for (
    const word of failIndicators
  ) {
    if (
      text.includes(word)
    ) {
      return "FAIL";
    }
  }

  const passIndicators = [
    "appears clean",
    "clean and free",
    "free of clutter",
    "no visible spill",
    "wearing a hard hat",
    "wearing hard hat",
    "wearing a safety vest",
    "wearing high visibility",
    "appropriate ppe",
    "clearly segregated",
    "properly stored",
    "appears safe",
    "appears satisfactory",
  ];

  for (
    const word of passIndicators
  ) {
    if (
      text.includes(word)
    ) {
      return "PASS";
    }
  }

  return "CHECK_REQUIRED";
}

function inferRisk(
  status: Status,
  explicit: string
): Risk {
  const value =
    explicit.toUpperCase();

  if (
    value.includes("HIGH")
  ) {
    return "HIGH";
  }

  if (
    value.includes("LOW")
  ) {
    return "LOW";
  }

  if (
    value.includes("MEDIUM")
  ) {
    return "MEDIUM";
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

function parseTextFindings(
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
  const blocks =
    splitFindingBlocks(
      raw
    );

  const findings: Array<{
    category: string;
    title: string;
    observation: string;
    status: Status;
    risk: Risk;
    confidence: number;
    checkId: string;
  }> = [];

  for (
    const block of blocks
  ) {
    const category =
      clean(
        field(
          block,
          [
            "CATEGORY",
          ]
        ),
        100
      );

    const title =
      clean(
        field(
          block,
          [
            "TITLE",
          ]
        ),
        250
      );

    const observation =
      clean(
        field(
          block,
          [
            "OBSERVATION",
            "DESCRIPTION",
          ]
        ),
        1200
      );

    const statusText =
      field(
        block,
        [
          "STATUS",
          "RESULT",
        ]
      );

    const riskText =
      field(
        block,
        [
          "RISK",
          "RISK_LEVEL",
          "RISK LEVEL",
        ]
      );

    const confidenceText =
      field(
        block,
        [
          "CONFIDENCE",
        ]
      );

    const checkId =
      field(
        block,
        [
          "CHECK_ID",
          "CHECK ID",
        ]
      );

    if (
      !category &&
      !observation
    ) {
      continue;
    }

    const finalObservation =
      observation ||
      title;

    let confidence =
      Number(
        confidenceText
          .replace(
            "%",
            ""
          )
      );

    if (
      !Number.isFinite(
        confidence
      )
    ) {
      confidence =
        0.6;
    }

    if (
      confidence > 1
    ) {
      confidence /=
        100;
    }

    confidence =
      Math.max(
        0,
        Math.min(
          1,
          confidence
        )
      );

    const status =
      inferStatus(
        finalObservation,
        statusText
      );

    const risk =
      inferRisk(
        status,
        riskText
      );

    findings.push({
      category:
        category ||
        "Other",

      title:
        title ||
        "Safety observation",

      observation:
        finalObservation,

      status,

      risk,

      confidence,

      checkId,
    });

    if (
      findings.length >=
      MAX_FINDINGS
    ) {
      break;
    }
  }

  /*
   * If the model did not use the requested field format,
   * try a second lightweight parser.
   */

  if (
    findings.length === 0
  ) {
    const lines =
      raw
        .split(/\n/)
        .map(
          (line) =>
            line
              .replace(
                /^\s*[-*•]\s*/,
                ""
              )
              .trim()
        )
        .filter(
          (line) =>
            line.length > 30
        );

    for (
      const line of lines
    ) {
      const lower =
        line.toLowerCase();

      if (
        lower.startsWith(
          "the image"
        ) ||
        lower.startsWith(
          "overall"
        )
      ) {
        continue;
      }

      let category =
        "Other";

      if (
        lower.includes("ppe") ||
        lower.includes(
          "hard hat"
        ) ||
        lower.includes(
          "safety vest"
        )
      ) {
        category =
          "PPE";
      } else if (
        lower.includes(
          "housekeeping"
        ) ||
        lower.includes(
          "clean"
        ) ||
        lower.includes(
          "spill"
        ) ||
        lower.includes(
          "clutter"
        )
      ) {
        category =
          "Housekeeping";
      } else if (
        lower.includes(
          "work at height"
        ) ||
        lower.includes(
          "guardrail"
        ) ||
        lower.includes(
          "ladder"
        ) ||
        lower.includes(
          "fall hazard"
        )
      ) {
        category =
          "Work at Height";
      } else if (
        lower.includes(
          "lifting"
        ) ||
        lower.includes(
          "suspended load"
        ) ||
        lower.includes(
          "crane"
        )
      ) {
        category =
          "Lifting";
      } else if (
        lower.includes(
          "vehicle"
        ) ||
        lower.includes(
          "pedestrian"
        ) ||
        lower.includes(
          "traffic"
        )
      ) {
        category =
          "Vehicular Safety";
      }

      const status =
        inferStatus(
          line,
          ""
        );

      findings.push({
        category,

        title:
          `${category} observation`,

        observation:
          line.substring(
            0,
            1200
          ),

        status,

        risk:
          inferRisk(
            status,
            ""
          ),

        confidence:
          0.6,

        checkId:
          "",
      });

      if (
        findings.length >=
        MAX_FINDINGS
      ) {
        break;
      }
    }
  }

  return findings;
}

/* =========================================================
   MATCH WSH CHECK
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
        (check) =>
          check.id ===
          finding.checkId
      );

    if (exact) {
      return exact;
    }
  }

  const category =
    finding.category
      .toLowerCase();

  const categoryChecks =
    checks.filter(
      (check) =>
        check.category
          .toLowerCase()
          === category
    );

  if (
    categoryChecks.length ===
    1
  ) {
    return categoryChecks[0];
  }

  const combined =
    `${finding.category} ${finding.title} ${finding.observation}`
      .toLowerCase();

  let best:
    SafetyCheck | null =
    null;

  let bestScore = 0;

  for (
    const check of
      categoryChecks
        .length
        ? categoryChecks
        : checks
  ) {
    const keywords =
      clean(
        check.keywords,
        500
      )
        .toLowerCase()
        .split(
          /[,;\s|]+/
        )
        .filter(
          (x) =>
            x.length >=
            3
        );

    let score = 0;

    for (
      const keyword of
        keywords
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

  return (
    best ||
    categoryChecks[0] ||
    null
  );
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
    const item of
      parsed
  ) {
    const key =
      `${item.category}|${item.title}|${item.observation}`
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
        item,
        checks
      );

    output.push({
      category:
        item.category,

      title:
        item.title,

      observation:
        item.observation,

      status:
        item.status,

      risk_level:
        item.risk,

      confidence:
        Math.round(
          item.confidence *
            100
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

/* =========================================================
   D1: INSERT INSPECTION
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
   D1: INSERT PHOTO
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

  /*
   * object_key is mandatory in your current schema.
   */

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
    .bind(
      ...insert.params
    )
    .run();
}

/* =========================================================
   D1: INSERT FINDING
   ========================================================= */

async function insertFindings(
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
      "findings"
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
            "findings",
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
   D1: UPDATE INSPECTION
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
    throw new Error(
      "inspections.overall_result column does not exist."
    );
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
   ANALYSE
   ========================================================= */

async function analyze(
  request: Request,
  env: Env
): Promise<Response> {
  let stage =
    "request";

  let inspectionId =
    "";

  let photoId =
    "";

  let objectKey =
    "";

  let r2Uploaded =
    false;

  try {
    /* -----------------------------------------------------
       1. Parse image
       ----------------------------------------------------- */

    stage =
      "parse image";

    const input =
      await parseRequest(
        request
      );

    const photo =
      input.photo;

    /* -----------------------------------------------------
       2. Generate IDs
       ----------------------------------------------------- */

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

    /* -----------------------------------------------------
       3. Generate R2 object key
       ----------------------------------------------------- */

    stage =
      "generate R2 object key";

    objectKey =
      `inspections/${inspectionId}/${photoId}.${extension(
        photo.contentType
      )}`;

    /* -----------------------------------------------------
       4. Create inspection
       ----------------------------------------------------- */

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

    /* -----------------------------------------------------
       5. Upload R2
       ----------------------------------------------------- */

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

    /* -----------------------------------------------------
       6. Save photo metadata
       ----------------------------------------------------- */

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

    /* -----------------------------------------------------
       7. Load safety checks
       ----------------------------------------------------- */

    stage =
      "D1 load safety checks";

    const checks =
      await loadSafetyChecks(
        env
      );

    /* -----------------------------------------------------
       8. Workers AI
       ----------------------------------------------------- */

    stage =
      "Workers AI";

    const ai =
      await runAI(
        env,
        photo.bytes,
        photo.contentType,
        checks
      );

    /* -----------------------------------------------------
       9. Parse AI text
       ----------------------------------------------------- */

    stage =
      "parse AI response";

    const parsed =
      parseTextFindings(
        ai.raw
      );

    /*
     * No findings is NOT PASS.
     */

    const findings =
      normalizeFindings(
        parsed,
        checks
      );

    /* -----------------------------------------------------
       10. Save findings
       ----------------------------------------------------- */

    stage =
      "D1 save findings";

    await insertFindings(
      env,
      inspectionId,
      photoId,
      findings
    );

    /* -----------------------------------------------------
       11. Overall result
       ----------------------------------------------------- */

    stage =
      "D1 update inspection";

    const result =
      overall(
        findings
      );

    await updateInspection(
      env,
      inspectionId,
      result
    );

    /* -----------------------------------------------------
       12. Response
       ----------------------------------------------------- */

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
            2000
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
    /*
     * IMPORTANT:
     *
     * Return the actual stage.
     * Do not hide the problem behind
     * "AI analysis failed".
     */

    const detail =
      error instanceof Error
        ? error.message
        : String(error);

    /*
     * Best-effort R2 cleanup.
     *
     * Only delete if this request uploaded the object.
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
     * If an inspection exists, try to mark it
     * CHECK_REQUIRED rather than leaving it looking
     * like a successful inspection.
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
        // Ignore secondary DB failure.
      }
    }

    return jsonResponse(
      {
        ok: false,

        error:
          "AI analysis failed.",

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

    const findings =
      await env.SAFETY_DB
        .prepare(
          `
          SELECT
            f.*,
            sc.check_question,
            sc.guidance
          FROM findings f
          LEFT JOIN safety_checks sc
            ON sc.id = f.check_id
          WHERE f.inspection_id = ?
          ORDER BY f.created_at
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
        findings.results ||
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
    await getSafetyChecks(
      env
    );

    safetyChecks =
      true;
  } catch {
    safetyChecks =
      false;
  }

  /*
   * We don't perform a write to R2 just to test it.
   * The binding's existence is enough for this health response.
   */

  r2 =
    !!env.PHOTOS;

  return jsonResponse({
    ok:
      database &&
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
      await getSafetyChecks(
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
   R2 PHOTO
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

  /* -------------------------------------------------------
     Health
     ------------------------------------------------------- */

  if (
    request.method === "GET" &&
    path === "/api/health"
  ) {
    return health(
      env
    );
  }

  /* -------------------------------------------------------
     Analyse
     ------------------------------------------------------- */

  if (
    request.method === "POST" &&
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

  /* -------------------------------------------------------
     Recent inspections
     ------------------------------------------------------- */

  if (
    request.method === "GET" &&
    path ===
      "/api/inspections"
  ) {
    return recentInspections(
      env
    );
  }

  /* -------------------------------------------------------
     Inspection detail
     ------------------------------------------------------- */

  if (
    request.method === "GET" &&
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

    return getInspection(
      env,
      id
    );
  }

  /* -------------------------------------------------------
     Safety checks
     ------------------------------------------------------- */

  if (
    request.method === "GET" &&
    path ===
      "/api/safety-checks"
  ) {
    return safetyChecks(
      env
    );
  }

  /* -------------------------------------------------------
     R2 photo
     ------------------------------------------------------- */

  if (
    request.method === "GET" &&
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
   WORKER
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

      /* -----------------------------------------------------
         API
         ----------------------------------------------------- */

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

      /* -----------------------------------------------------
         Static website
         ----------------------------------------------------- */

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
        // Continue to fallback.
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
