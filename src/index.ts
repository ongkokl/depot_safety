export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
}

/*
============================================================
DEPOT SAFETY INSPECTION AI - FREE PLAN VERSION
============================================================

Cloudflare Workers
Cloudflare Workers AI
Cloudflare D1

AI:
@cf/meta/llama-3.2-11b-vision-instruct

NO VECTORIZE REQUIRED

============================================================
API
============================================================

GET  /api/health
GET  /api/safety-checks
GET  /api/inspections
GET  /api/inspections/:id

POST /api/analyze
POST /api/analyse

============================================================
FREE PLAN OPTIMISATION
============================================================

1. Small AI prompt
2. No entire safety-check library sent to AI
3. Maximum 5 findings
4. Short AI output
5. No JSON-mode dependency
6. Natural-language parser
7. D1 matching after AI analysis
8. No Vectorize
9. No large database processing
10. Designed to work with browser-compressed images

============================================================
*/


const MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const WSH_URL =
  "https://www.tal.sg/wshc";


/*
============================================================
TYPES
============================================================
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
============================================================
CORS
============================================================
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
============================================================
JSON RESPONSE
============================================================
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
============================================================
BASIC HELPERS
============================================================
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


  const text =
    value.trim();


  return text || fallback;

}


function clamp(
  value: number,
  min: number,
  max: number
): number {

  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );

}


function confidenceValue(
  value: unknown
): number {

  const n =
    Number(value);


  if (
    !Number.isFinite(n)
  ) {

    return 0.5;

  }


  return clamp(
    n,
    0,
    1
  );

}


/*
============================================================
STATUS
============================================================
*/

function normalizeStatus(
  value: unknown
): Finding["status"] {

  const text =
    String(value || "")
      .trim()
      .toUpperCase();


  if (
    text.includes("FAIL") ||
    text.includes("UNSAFE")
  ) {

    return "FAIL";

  }


  if (
    text.includes("PASS") ||
    text.includes("SAFE")
  ) {

    return "PASS";

  }


  return "CHECK_REQUIRED";

}


/*
============================================================
RISK
============================================================
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
============================================================
CATEGORY
============================================================
*/

function normalizeCategory(
  value: unknown
): string {

  const text =
    String(value || "")
      .trim();


  return text || "Other";

}


/*
============================================================
IMAGE NORMALISATION
============================================================
*/

function normalizeImage(
  image: string,
  contentType = "image/jpeg"
): string {

  const value =
    image.trim();


  if (!value) {

    throw new Error(
      "No image supplied."
    );

  }


  /*
  Already data URL.
  */

  if (
    value.startsWith(
      "data:image/"
    )
  ) {

    return value;

  }


  /*
  Remote image URL.
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
  Raw Base64.
  */

  const mime =
    contentType.startsWith(
      "image/"
    )
      ? contentType
      : "image/jpeg";


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
============================================================
DATABASE TABLE COLUMNS
============================================================
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
      row => row.name
    );

  } catch {

    return [];

  }

}


/*
============================================================
SAFETY CHECKS

IMPORTANT:

We load the checks AFTER AI analysis.

This keeps the AI request small.
============================================================
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
      "D1 safety_checks error:",
      error
    );


    return [];

  }

}


/*
============================================================
SHORT AI PROMPT

Do NOT put the entire WSH library here.
============================================================
*/

function buildVisionPrompt(): string {

  return `
You are a workplace safety inspection assistant
for a Singapore container depot.

Analyse ONLY what is visible in the photograph.

Look for these areas:

PPE
Housekeeping
Vehicular Safety
Work at Height
Lifting
Storage
Electrical Safety
Fire Safety

IMPORTANT:

Only report visible conditions.

Do not invent hazards.

Do not assume something is unsafe because it cannot
be seen.

Do not claim legal compliance.

Use PASS when there is reasonable visible evidence
that the condition is satisfactory.

Use FAIL only for a clearly visible unsafe condition.

Use CHECK_REQUIRED when the photograph is insufficient
to determine the condition.

Maximum 5 findings.

Keep each observation below 30 words.

Use this format:

* PPE
Category: PPE
Title: Short title
Observation: Short factual observation
Status: PASS
Risk Level: LOW
Confidence: 0.90

* Housekeeping
Category: Housekeeping
Title: Short title
Observation: Short factual observation
Status: CHECK_REQUIRED
Risk Level: MEDIUM
Confidence: 0.70

Do not provide long explanations.
Do not provide Markdown tables.
Do not provide legal advice.

After the findings write:

Overall: Short overall visual assessment.
`;

}


/*
============================================================
EXTRACT AI TEXT
============================================================
*/

function extractAIText(
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


  const obj =
    response as any;


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


  return "";

}


/*
============================================================
JSON PARSER

Used only if AI happens to return JSON.
============================================================
*/

function parseJSON(
  text: string
): unknown {

  let value =
    text.trim();


  value =
    value.replace(
      /^```json\s*/i,
      ""
    );


  value =
    value.replace(
      /^```\s*/i,
      ""
    );


  value =
    value.replace(
      /\s*```$/i,
      ""
    );


  try {

    return JSON.parse(
      value
    );

  } catch {

    // Continue.

  }


  const start =
    value.indexOf("{");


  const end =
    value.lastIndexOf("}");


  if (
    start >= 0 &&
    end > start
  ) {

    try {

      return JSON.parse(
        value.substring(
          start,
          end + 1
        )
      );

    } catch {

      // Continue.

    }

  }


  throw new Error(
    "Invalid JSON."
  );

}


/*
============================================================
NORMALISE JSON RESULT
============================================================
*/

function normalizeAIResult(
  value: unknown
): AIResult {

  let obj: any =
    value;


  if (
    typeof obj === "string"
  ) {

    obj =
      parseJSON(
        obj
      );

  }


  if (
    obj &&
    obj.response &&
    typeof obj.response ===
      "object"
  ) {

    obj =
      obj.response;

  }


  const raw =
    Array.isArray(
      obj?.findings
    )
      ? obj.findings
      : [];


  const findings:
    Finding[] = [];


  for (
    const item
    of raw.slice(
      0,
      5
    )
  ) {

    if (
      !item ||
      typeof item !==
        "object"
    ) {

      continue;

    }


    findings.push({

      category:
        normalizeCategory(
          item.category
        ),

      title:
        cleanString(
          item.title,
          "Safety observation"
        ),

      observation:
        cleanString(
          item.observation,
          "Physical verification required."
        ),

      status:
        normalizeStatus(
          item.status
        ),

      risk_level:
        normalizeRisk(
          item.risk_level
        ),

      confidence:
        confidenceValue(
          item.confidence
        ),

      check_id:
        cleanString(
          item.check_id
        ),

      source_title:
        cleanString(
          item.source_title,
          "WSH Council"
        ),

      source_url:
        cleanString(
          item.source_url,
          WSH_URL
        ),

    });

  }


  return {

    scene_summary:
      cleanString(
        obj?.scene_summary,
        "Workplace scene analysed."
      ),

    findings,

  };

}


/*
============================================================
NATURAL LANGUAGE PARSER

This handles the actual output currently returned by
Llama 3.2 Vision.
============================================================
*/

function parseNaturalLanguage(
  text: string
): AIResult {

  const findings:
    Finding[] = [];


  const categories = [

    "PPE",

    "Housekeeping",

    "Vehicular Safety",

    "Work at Height",

    "Lifting",

    "Storage",

    "Electrical Safety",

    "Electrical Equipment",

    "Fire Safety",

    "Traffic Safety",

    "Manual Handling",

    "People",

    "Process",

    "Equipment",

  ];


  /*
  Find category headings.
  */

  const categoryPattern =
    categories
      .map(
        value =>
          value.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )
      )
      .join("|");


  const headingRegex =
    new RegExp(
      `(?:^|\\n)\\s*\\*{0,3}\\s*(${categoryPattern})\\s*\\*{0,3}\\s*(?:\\r?\\n|$)`,
      "gim"
    );


  const sections: Array<{
    category: string;
    text: string;
  }> = [];


  const headings: Array<{
    category: string;
    start: number;
    end: number;
  }> = [];


  let match:
    RegExpExecArray | null;


  while (
    (
      match =
        headingRegex.exec(text)
    ) !== null
  ) {

    headings.push({

      category:
        match[1].trim(),

      start:
        match.index,

      end:
        match.index +
        match[0].length,

    });

  }


  for (
    let i = 0;
    i < headings.length;
    i++
  ) {

    const current =
      headings[i];


    const next =
      headings[i + 1];


    const end =
      next
        ? next.start
        : text.length;


    sections.push({

      category:
        current.category,

      text:
        text.substring(
          current.end,
          end
        ),

    });

  }


  /*
  Parse each section.
  */

  for (
    const section
    of sections
  ) {

    const sectionText =
      section.text;


    const categoryMatch =
      sectionText.match(
        /Category\s*:\s*([^\r\n]+)/i
      );


    const titleMatch =
      sectionText.match(
        /Title\s*:\s*([^\r\n]+)/i
      );


    const observationMatch =
      sectionText.match(
        /Observation\s*:\s*([^\r\n]+)/i
      );


    const statusMatch =
      sectionText.match(
        /Status\s*:\s*(PASS|FAIL|CHECK_REQUIRED)/i
      );


    const riskMatch =
      sectionText.match(
        /Risk\s*Level\s*:\s*(LOW|MEDIUM|HIGH)/i
      );


    const confidenceMatch =
      sectionText.match(
        /Confidence\s*:\s*([0-9.]+)/i
      );


    /*
    We need at least a title or observation.
    */

    if (
      !titleMatch &&
      !observationMatch
    ) {

      continue;

    }


    findings.push({

      category:
        cleanString(
          categoryMatch?.[1],
          section.category
        ),

      title:
        cleanString(
          titleMatch?.[1],
          section.category
        ),

      observation:
        cleanString(
          observationMatch?.[1],
          "Physical verification required."
        ),

      status:
        normalizeStatus(
          statusMatch?.[1]
        ),

      risk_level:
        normalizeRisk(
          riskMatch?.[1]
        ),

      confidence:
        confidenceValue(
          confidenceMatch?.[1]
        ),

      check_id:
        "",

      source_title:
        "WSH Council",

      source_url:
        WSH_URL,

    });

  }


  /*
  Remove duplicate categories/titles.
  */

  const unique =
    findings.filter(
      (item, index, array) => {

        return (
          index ===
          array.findIndex(
            other =>
              other.category
                .toLowerCase() ===
                item.category
                  .toLowerCase() &&

              other.title
                .toLowerCase() ===
                item.title
                  .toLowerCase()
          )
        );

      }
    );


  /*
  Overall summary.
  */

  let summary =
    "Workplace scene analysed.";


  const overallMatch =
    text.match(
      /Overall\s*:\s*([^\r\n]+)/i
    );


  if (
    overallMatch
  ) {

    summary =
      overallMatch[1].trim();

  }


  /*
  If parser failed, retain the AI text as a
  CHECK_REQUIRED observation.
  */

  if (
    unique.length === 0
  ) {

    return {

      scene_summary:
        text
          .trim()
          .substring(
            0,
            1000
          ),

      findings: [

        {

          category:
            "General Safety",

          title:
            "AI visual review",

          observation:
            text
              .trim()
              .substring(
                0,
                1200
              ),

          status:
            "CHECK_REQUIRED",

          risk_level:
            "MEDIUM",

          confidence:
            0.5,

          check_id:
            "",

          source_title:
            "WSH Council",

          source_url:
            WSH_URL,

        },

      ],

    };

  }


  return {

    scene_summary:
      summary,

    findings:
      unique.slice(
        0,
        5
      ),

  };

}


/*
============================================================
RUN VISION AI
============================================================

LIGHTWEIGHT VERSION

============================================================
*/

async function runVisionAI(
  env: Env,
  image: string
): Promise<AIResult> {

  const prompt =
    buildVisionPrompt();


  const input = {

    messages: [

      {

        role:
          "system",

        content:
          prompt,

      },

      {

        role:
          "user",

        content:
          "Analyse the uploaded safety inspection photograph.",

      },

    ],

    image,

    temperature:
      0.1,

    max_tokens:
      600,

    top_p:
      0.8,

  };


  console.log(
    "Calling Workers AI:",
    MODEL
  );


  let response:
    unknown;


  try {

    response =
      await env.AI.run(
        MODEL,
        input as any
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


  /*
  Direct structured result.
  */

  if (
    response &&
    typeof response ===
      "object"
  ) {

    const obj =
      response as any;


    if (
      Array.isArray(
        obj.findings
      )
    ) {

      return normalizeAIResult(
        obj
      );

    }


    if (
      obj.response &&
      typeof obj.response ===
        "object" &&
      Array.isArray(
        obj.response.findings
      )
    ) {

      return normalizeAIResult(
        obj.response
      );

    }

  }


  /*
  Extract text.
  */

  const text =
    extractAIText(
      response
    );


  if (!text) {

    throw new Error(
      "Workers AI returned no response."
    );

  }


  console.log(
    "AI response received:",
    text.substring(
      0,
      2500
    )
  );


  /*
  Try JSON first.
  */

  try {

    return normalizeAIResult(
      parseJSON(
        text
      )
    );

  } catch {

    /*
    Expected path for the current model.
    */

    return parseNaturalLanguage(
      text
    );

  }

}


/*
============================================================
MATCH FINDING TO D1 SAFETY CHECK
============================================================
*/

function matchSafetyCheck(
  finding: Finding,
  checks: SafetyCheck[]
): SafetyCheck | null {

  /*
  Exact category first.
  */

  const category =
    finding.category
      .trim()
      .toLowerCase();


  const exactCategory =
    checks.find(
      check =>
        check.category
          .trim()
          .toLowerCase() ===
        category
    );


  if (
    exactCategory
  ) {

    return exactCategory;

  }


  /*
  Keyword matching.
  */

  const text =
    (
      finding.category +
      " " +
      finding.title +
      " " +
      finding.observation
    )
      .toLowerCase();


  let best:
    SafetyCheck | null =
    null;


  let score =
    0;


  for (
    const check
    of checks
  ) {

    const keywords =
      String(
        check.keywords || ""
      )
        .toLowerCase()
        .split(",");


    let current =
      0;


    for (
      const keyword
      of keywords
    ) {

      const word =
        keyword.trim();


      if (
        word &&
        text.includes(
          word
        )
      ) {

        current++;

      }

    }


    if (
      current >
      score
    ) {

      score =
        current;

      best =
        check;

    }

  }


  return best;

}


/*
============================================================
CREATE INSPECTION
============================================================
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


  if (
    !columns.length
  ) {

    throw new Error(
      "inspections table not found."
    );

  }


  const fields:
    Record<
      string,
      unknown
    > = {};


  if (
    columns.includes("id")
  ) {

    fields.id =
      id;

  }


  if (
    columns.includes(
      "inspection_no"
    )
  ) {

    fields.inspection_no =
      inspectionNo;

  }


  if (
    columns.includes(
      "location"
    )
  ) {

    fields.location =
      location;

  }


  if (
    columns.includes(
      "inspector"
    )
  ) {

    fields.inspector =
      inspector;

  }


  if (
    columns.includes(
      "created_at"
    )
  ) {

    fields.created_at =
      nowISO();

  }


  if (
    columns.includes(
      "overall_result"
    )
  ) {

    fields.overall_result =
      "CHECK_REQUIRED";

  }


  if (
    columns.includes(
      "status"
    ) &&
    !(
      "overall_result"
      in fields
    )
  ) {

    fields.status =
      "CHECK_REQUIRED";

  }


  const names =
    Object.keys(
      fields
    );


  const placeholders =
    names
      .map(
        () => "?"
      )
      .join(", ");


  await db
    .prepare(
      `
      INSERT INTO inspections
      (${names.join(", ")})
      VALUES
      (${placeholders})
      `
    )
    .bind(
      ...names.map(
        name =>
          fields[name]
      )
    )
    .run();


  return {

    id,

    inspectionNo,

  };

}


/*
============================================================
UPDATE INSPECTION
============================================================
*/

async function updateInspection(
  db: D1Database,
  id: string,
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
        id
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
        id
      )
      .run();

  }

}


/*
============================================================
SAVE PHOTO
============================================================
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
      "inspection_photos table not found."
    );
  }

  /*
  IMPORTANT:
  object_key is NOT NULL in the current
  inspection_photos table.

  We therefore always generate one.
  */

  const objectKey =
    `inspection/${inspectionId}/${photoId}-${fileName}`;

  const fields:
    Record<string, unknown> = {};

  if (columns.includes("id")) {
    fields.id =
      photoId;
  }

  if (columns.includes("inspection_id")) {
    fields.inspection_id =
      inspectionId;
  }

  if (columns.includes("file_name")) {
    fields.file_name =
      fileName;
  }

  if (
    columns.includes("filename") &&
    !("file_name" in fields)
  ) {
    fields.filename =
      fileName;
  }

  if (columns.includes("content_type")) {
    fields.content_type =
      contentType;
  }

  if (
    columns.includes("mime_type") &&
    !("content_type" in fields)
  ) {
    fields.mime_type =
      contentType;
  }

  /*
  REQUIRED BY YOUR D1 SCHEMA
  */

  if (columns.includes("object_key")) {
    fields.object_key =
      objectKey;
  }

  if (columns.includes("created_at")) {
    fields.created_at =
      nowISO();
  }

  const names =
    Object.keys(fields);

  if (!names.length) {
    throw new Error(
      "No usable columns were found in inspection_photos."
    );
  }

  const placeholders =
    names
      .map(() => "?")
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
        name => fields[name]
      )
    )
    .run();

  return photoId;
}


/*
============================================================
SAVE INSPECTION ITEMS
============================================================
*/

async function saveInspectionItems(
  db: D1Database,
  inspectionId: string,
  photoId: string,
  findings: Finding[],
  checks: SafetyCheck[]
): Promise<void> {

  /*
  Use one D1 batch rather than separate requests.

  This is lighter and faster.
  */

  const statements:
    D1PreparedStatement[] = [];


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


    statements.push(

      db
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
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .bind(

          id,

          inspectionId,

          photoId,

          matched?.category ||
            finding.category,

          finding.title,

          finding.observation,

          finding.status,

          finding.risk_level,

          finding.confidence,

          matched?.id ||
            null,

          matched?.source_title ||
            "WSH Council",

          matched?.source_url ||
            WSH_URL,

          nowISO()

        )

    );

  }


  if (
    statements.length
  ) {

    await db.batch(
      statements
    );

  }

}


/*
============================================================
OVERALL RESULT
============================================================
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
============================================================
ANALYSE PHOTO
============================================================
*/

async function handleAnalyse(
  request: Request,
  env: Env
): Promise<Response> {

  let body:
    AnalyseRequest;


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
  Normalise image.
  */

  let image:
    string;


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
  FREE PLAN SAFETY LIMIT.

  Browser should normally send a compressed image.

  Reject extremely large Base64 payloads.
  */

  if (
    image.length >
    7_000_000
  ) {

    return jsonResponse(
      {

        success: false,

        error:
          "Image is too large. Please upload a smaller/compressed photo.",

        maximum:
          "Approximately 5 MB",

      },
      413
    );

  }


  /*
  ----------------------------------------------------------
  CREATE INSPECTION
  ----------------------------------------------------------
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
            : String(error),

      },
      500
    );

  }


  /*
  ----------------------------------------------------------
  SAVE PHOTO
  ----------------------------------------------------------
  */

  let photoId:
    string;


  try {

    photoId =
      await savePhoto(
        env.SAFETY_DB,
        inspection.id,
        fileName,
        contentType
      );

  } catch (error) {

    return jsonResponse(
      {

        success: false,

        error:
          "Unable to save photo record.",

        detail:
          error instanceof Error
            ? error.message
            : String(error),

        inspection_id:
          inspection.id,

      },
      500
    );

  }


  /*
  ----------------------------------------------------------
  RUN AI
  ----------------------------------------------------------
  */

  let aiResult:
    AIResult;


  try {

    aiResult =
      await runVisionAI(
        env,
        image
      );

  } catch (error) {

    const detail =
      error instanceof Error
        ? error.message
        : String(error);


    console.error(
      "AI ERROR:",
      detail
    );


    try {

      await updateInspection(
        env.SAFETY_DB,
        inspection.id,
        "CHECK_REQUIRED"
      );

    } catch {
      // Ignore secondary error.
    }


    return jsonResponse(
      {

        success: false,

        error:
          "AI analysis failed.",

        detail,

        inspection_id:
          inspection.id,

      },
      500
    );

  }


  /*
  ----------------------------------------------------------
  LOAD D1 SAFETY CHECKS AFTER AI
  ----------------------------------------------------------
  */

  const checks =
    await loadSafetyChecks(
      env.SAFETY_DB
    );


  /*
  ----------------------------------------------------------
  MATCH FINDINGS
  ----------------------------------------------------------
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
            null,

          source_title:
            matched?.source_title ||
            "WSH Council",

          source_url:
            matched?.source_url ||
            WSH_URL,

        };

      }
    );


  /*
  ----------------------------------------------------------
  OVERALL RESULT
  ----------------------------------------------------------
  */

  const overall =
    calculateOverall(
      findings
    );


  /*
  ----------------------------------------------------------
  SAVE FINDINGS
  ----------------------------------------------------------
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

    return jsonResponse(
      {

        success: false,

        error:
          "AI analysis completed but findings could not be saved.",

        detail:
          error instanceof Error
            ? error.message
            : String(error),

        inspection_id:
          inspection.id,

        findings,

      },
      500
    );

  }


  /*
  ----------------------------------------------------------
  UPDATE INSPECTION
  ----------------------------------------------------------
  */

  try {

    await updateInspection(
      env.SAFETY_DB,
      inspection.id,
      overall
    );

  } catch (error) {

    console.error(
      "Inspection update failed:",
      error
    );

  }


  /*
  ----------------------------------------------------------
  SUCCESS
  ----------------------------------------------------------
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

        overall_result:
          overall,

      },

      summary:
        aiResult.scene_summary,

      findings,

    }
  );

}


/*
============================================================
HEALTH
============================================================
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

      plan_optimized_for:
        "Cloudflare Workers Free",

      timestamp:
        nowISO(),

    }
  );

}


/*
============================================================
SAFETY CHECKS
============================================================
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
============================================================
RECENT INSPECTIONS
============================================================
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
          "Unable to load inspections.",

        detail:
          error instanceof Error
            ? error.message
            : String(error),

      },
      500
    );

  }

}


/*
============================================================
SINGLE INSPECTION
============================================================
*/

async function handleSingleInspection(
  db: D1Database,
  id: string
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
          id
        )
        .first();


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
          id
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
          id
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
            : String(error),

      },
      500
    );

  }

}


/*
============================================================
ROUTER
============================================================
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
  HEALTH
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
  SAFETY CHECKS
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
  RECENT INSPECTIONS
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
  SINGLE INSPECTION
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


    return handleSingleInspection(
      env.SAFETY_DB,
      id
    );

  }


  /*
  ANALYSE
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

    return handleAnalyse(
      request,
      env
    );

  }


  /*
  ROOT
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

        vectorize:
          false,

        endpoints: [

          "GET /api/health",

          "GET /api/safety-checks",

          "GET /api/inspections",

          "GET /api/inspections/:id",

          "POST /api/analyze",

          "POST /api/analyse",

        ],

      }
    );

  }


  /*
  NOT FOUND
  */

  return jsonResponse(
    {

      success: false,

      error:
        "Not found",

      path,

      method:
        request.method,

    },
    404
  );

}


/*
============================================================
WORKER ENTRY POINT
============================================================
*/

export default {

  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {

    /*
    CORS preflight.
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
