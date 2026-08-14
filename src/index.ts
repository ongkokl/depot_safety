export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
}

/*
============================================================
DEPOT SAFETY INSPECTION AI
ACTIVITY / HAZARD DRIVEN VERSION
============================================================

Cloudflare Workers
Cloudflare Workers AI
Cloudflare D1

AI MODEL:
@cf/meta/llama-3.2-11b-vision-instruct

NO VECTORIZE

FLOW:

PHOTO
  ↓
STAGE 1
Identify visible activities / hazards
  ↓
Select relevant WSH categories
  ↓
D1 safety_checks
  ↓
STAGE 2
Evaluate only relevant checks
  ↓
PASS / FAIL / CHECK_REQUIRED
  ↓
inspection_items

============================================================
D1 TABLES USED
============================================================

safety_checks

id
category
check_question
guidance
source_title
source_url
keywords
active

inspection_photos

id
inspection_id
object_key
...

inspection_items

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


interface SceneAnalysis {

  scene_summary: string;

  relevant_categories: string[];

}


/*
============================================================
REQUEST
============================================================
*/

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

    "Access-Control-Allow-Origin":
      "*",

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
    text === "SAFE"
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
  Data URL.
  */

  if (
    value.startsWith(
      "data:image/"
    )
  ) {

    return value;

  }

  /*
  URL.
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
DATABASE COLUMNS
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
LOAD SAFETY CHECKS
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
      "SAFETY CHECK LOAD ERROR:",
      error
    );

    return [];

  }

}


/*
============================================================
CANONICAL WSH CATEGORIES

These are used only for classification.

The actual detailed checks remain in D1.
============================================================
*/

const WSH_CATEGORIES = [

  "PPE",

  "Housekeeping",

  "Vehicular Safety",

  "Work at Height",

  "Lifting",

  "Storage",

  "Electrical Safety",

  "Fire Safety",

  "Manual Handling",

  "Chemical Safety",

];


/*
============================================================
NORMALISE CATEGORY
============================================================
*/

function normaliseCategoryName(
  value: string
): string | null {

  const text =
    value
      .trim()
      .toLowerCase();

  for (
    const category
    of WSH_CATEGORIES
  ) {

    if (
      category.toLowerCase() ===
      text
    ) {

      return category;

    }

  }

  /*
  Common aliases.
  */

  if (
    text === "electrical" ||
    text === "electrical equipment"
  ) {

    return "Electrical Safety";

  }

  if (
    text === "traffic" ||
    text === "vehicle safety"
  ) {

    return "Vehicular Safety";

  }

  if (
    text === "workplace housekeeping"
  ) {

    return "Housekeeping";

  }

  if (
    text === "lifting operations" ||
    text === "lifting operation"
  ) {

    return "Lifting";

  }

  if (
    text === "work at heights" ||
    text === "height"
  ) {

    return "Work at Height";

  }

  return null;

}


/*
============================================================
STAGE 1 PROMPT
============================================================

The first AI call does NOT perform detailed safety
compliance checking.

It only determines what is visibly relevant.

============================================================
*/

function buildScenePrompt(): string {

  return `
You are a workplace safety image classification assistant
for a Singapore container depot.

Look carefully at the uploaded photograph.

Your FIRST task is only to determine which safety areas
are visibly relevant.

Do NOT perform a full safety inspection yet.

Possible categories:

PPE
Housekeeping
Vehicular Safety
Work at Height
Lifting
Storage
Electrical Safety
Fire Safety
Manual Handling
Chemical Safety

IMPORTANT:

Only select a category if there is visible evidence
that the category is relevant to the photograph.

Examples:

A worker wearing a helmet:
PPE is relevant.

A truck or forklift:
Vehicular Safety is relevant.

An open edge, ladder, scaffold or elevated platform:
Work at Height may be relevant.

A crane or suspended load:
Lifting may be relevant.

Visible debris, spill, obstruction or poor storage:
Housekeeping may be relevant.

An electrical panel, cable or electrical work:
Electrical Safety may be relevant.

Fire extinguisher, fire exit or visible fire hazard:
Fire Safety may be relevant.

Chemical container or chemical spill:
Chemical Safety may be relevant.

Do NOT select a category just because it is normally
important at a workplace.

Do NOT assume a hazard exists.

Maximum 5 categories.

Use exactly this format:

Scene: Short description of what is visibly happening.

Relevant Categories:
PPE
Housekeeping

Only list categories that are actually relevant.
`;

}


/*
============================================================
PARSE STAGE 1
============================================================
*/

function parseSceneAnalysis(
  text: string
): SceneAnalysis {

  let summary =
    "Workplace scene analysed.";

  const sceneMatch =
    text.match(
      /Scene\s*:\s*([^\r\n]+)/i
    );

  if (
    sceneMatch
  ) {

    summary =
      sceneMatch[1]
        .trim();

  }

  const categories:
    string[] = [];

  const relevantMatch =
    text.match(
      /Relevant Categories\s*:\s*([\s\S]+)/i
    );

  if (
    relevantMatch
  ) {

    const lines =
      relevantMatch[1]
        .split(/\r?\n/);

    for (
      const line
      of lines
    ) {

      const cleaned =
        line
          .replace(
            /^[\s*•\-]+/,
            ""
          )
          .trim();

      if (
        !cleaned
      ) {

        continue;

      }

      const category =
        normaliseCategoryName(
          cleaned
        );

      if (
        category &&
        !categories.includes(
          category
        )
      ) {

        categories.push(
          category
        );

      }

      if (
        categories.length >= 5
      ) {

        break;

      }

    }

  }

  return {

    scene_summary:
      summary,

    relevant_categories:
      categories,

  };

}


/*
============================================================
STAGE 1 AI
============================================================
*/

async function detectRelevantCategories(
  env: Env,
  image: string
): Promise<SceneAnalysis> {

  const input = {

    messages: [

      {

        role:
          "system",

        content:
          buildScenePrompt(),

      },

      {

        role:
          "user",

        content:
          "Classify the visible safety areas in this photograph.",

      },

    ],

    image,

    temperature:
      0.1,

    max_tokens:
      250,

    top_p:
      0.8,

  };

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
      `Stage 1 Workers AI failed: ${message}`
    );

  }

  const text =
    extractAIText(
      response
    );

  if (
    !text
  ) {

    throw new Error(
      "Stage 1 Workers AI returned no response."
    );

  }

  console.log(
    "STAGE 1:",
    text.substring(
      0,
      1500
    )
  );

  return parseSceneAnalysis(
    text
  );

}


/*
============================================================
BUILD RELEVANT D1 CHECKS

Only send a SMALL subset of D1 checks to the
second AI request.

============================================================
*/

function selectRelevantChecks(
  checks: SafetyCheck[],
  categories: string[]
): SafetyCheck[] {

  if (
    !categories.length
  ) {

    return [];

  }

  const result:
    SafetyCheck[] = [];

  for (
    const category
    of categories
  ) {

    const categoryLower =
      category.toLowerCase();

    const matches =
      checks.filter(
        check =>
          check.category
            .toLowerCase()
            .includes(
              categoryLower
            ) ||
          categoryLower.includes(
            check.category
              .toLowerCase()
          )
      );

    /*
    Limit checks per category.

    This prevents a very large prompt.
    */

    for (
      const check
      of matches.slice(
        0,
        4
      )
    ) {

      if (
        !result.some(
          existing =>
            existing.id ===
            check.id
        )
      ) {

        result.push(
          check
        );

      }

    }

  }

  /*
  Absolute safety limit.

  */

  return result.slice(
    0,
    15
  );

}


/*
============================================================
BUILD STAGE 2 PROMPT
============================================================
*/

function buildEvaluationPrompt(
  checks: SafetyCheck[]
): string {

  const checkText =
    checks
      .map(
        (check, index) => {

          return `
CHECK ${index + 1}

Check ID:
${check.id}

Category:
${check.category}

Question:
${check.check_question}

Guidance:
${check.guidance}

Source:
${check.source_title}

Source URL:
${check.source_url}
`;

        }
      )
      .join("\n");


  return `
You are a Singapore workplace safety inspection assistant.

The photograph has already been classified to contain
relevant safety areas.

Now evaluate ONLY the supplied safety checks.

Do not create unrelated checks.

IMPORTANT VISUAL RULES:

1. Only use evidence visible in the photograph.

2. Do not invent hazards.

3. Do not infer hidden conditions.

4. Do not say PPE is missing simply because all PPE
   cannot be seen.

5. Do not say a work-at-height hazard exists unless
   elevated work, an open edge, ladder, scaffold or
   similar condition is visibly relevant.

6. Do not say housekeeping fails simply because a
   workplace surface is not perfectly clean.

7. Use FAIL only when an unsafe condition is clearly
   visible.

8. Use PASS when there is reasonable visual evidence
   that the specific condition is satisfactory.

9. Use CHECK_REQUIRED when the photograph does not
   provide enough evidence.

10. Do not claim legal compliance.

11. Maximum 5 findings.

12. Keep each observation below 35 words.

13. Confidence must reflect visual certainty.

IMPORTANT:

A category being relevant does NOT mean it must fail.

For example:

Worker clearly wearing hard hat and high visibility vest:
PPE may be PASS.

If only part of the worker is visible:
PPE may be CHECK_REQUIRED.

If an open edge is clearly visible without protection:
Work at Height may be FAIL.

If no elevated work is visible:
Do not create a Work at Height finding.

Use exactly this format:

* PPE

Category: PPE
Title: Appropriate PPE visible
Observation: Worker is visibly wearing a hard hat and high-visibility vest.
Status: PASS
Risk Level: LOW
Confidence: 0.90
Check ID: ppe-001
Source Title: WSH Council
Source URL: https://www.tal.sg/wshc

SAFETY CHECKS:

${checkText}

END SAFETY CHECKS.
`;

}


/*
============================================================
PARSE JSON
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
EXTRACT AI TEXT
============================================================
*/

function extractAIText(
  response: unknown
): string {

  if (
    typeof response ===
    "string"
  ) {

    return response;

  }

  if (
    !response ||
    typeof response !==
      "object"
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
NORMALISE AI RESULT
============================================================
*/

function normalizeAIResult(
  value: unknown
): AIResult {

  let obj:
    any =
    value;

  if (
    typeof obj ===
    "string"
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
        cleanString(
          item.category,
          "Other"
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
NATURAL LANGUAGE EVALUATION PARSER
============================================================
*/

function parseEvaluationText(
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

    "Fire Safety",

    "Manual Handling",

    "Chemical Safety",

  ];


  const escaped =
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
      `(?:^|\\n)\\s*\\*{0,3}\\s*(${escaped})\\s*\\*{0,3}\\s*(?:\\r?\\n|$)`,
      "gim"
    );


  const headings:
    Array<{
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

    const section =
      text.substring(
        current.end,
        end
      );


    const categoryMatch =
      section.match(
        /Category\s*:\s*([^\r\n]+)/i
      );

    const titleMatch =
      section.match(
        /Title\s*:\s*([^\r\n]+)/i
      );

    const observationMatch =
      section.match(
        /Observation\s*:\s*([^\r\n]+)/i
      );

    const statusMatch =
      section.match(
        /Status\s*:\s*(PASS|FAIL|CHECK_REQUIRED)/i
      );

    const riskMatch =
      section.match(
        /Risk\s*Level\s*:\s*(LOW|MEDIUM|HIGH)/i
      );

    const confidenceMatch =
      section.match(
        /Confidence\s*:\s*([0-9.]+)/i
      );

    const checkIdMatch =
      section.match(
        /Check\s*ID\s*:\s*([^\r\n*]+)/i
      );

    const sourceTitleMatch =
      section.match(
        /Source\s*Title\s*:\s*([^\r\n*]+)/i
      );

    const sourceUrlMatch =
      section.match(
        /Source\s*URL\s*:\s*(https?:\/\/[^\s*]+)/i
      );


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
          current.category
        ),

      title:
        cleanString(
          titleMatch?.[1],
          current.category
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
        cleanString(
          checkIdMatch?.[1]
        ),

      source_title:
        cleanString(
          sourceTitleMatch?.[1],
          "WSH Council"
        ),

      source_url:
        cleanString(
          sourceUrlMatch?.[1],
          WSH_URL
        ),

    });

  }


  /*
  Extract overall.
  */

  let summary =
    "Workplace scene analysed.";

  const overall =
    text.match(
      /Overall\s*:\s*([^\r\n]+)/i
    );

  if (
    overall
  ) {

    summary =
      overall[1].trim();

  }


  /*
  Remove duplicate findings.
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
STAGE 2 AI EVALUATION
============================================================
*/

async function evaluateRelevantChecks(
  env: Env,
  image: string,
  checks: SafetyCheck[]
): Promise<AIResult> {

  if (
    !checks.length
  ) {

    return {

      scene_summary:
        "No specific WSH safety check was visually relevant.",

      findings: [],

    };

  }


  const input = {

    messages: [

      {

        role:
          "system",

        content:
          buildEvaluationPrompt(
            checks
          ),

      },

      {

        role:
          "user",

        content:
          "Evaluate only the relevant safety checks against this photograph.",

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
      `Stage 2 Workers AI failed: ${message}`
    );

  }


  const text =
    extractAIText(
      response
    );


  if (
    !text
  ) {

    throw new Error(
      "Stage 2 Workers AI returned no response."
    );

  }


  console.log(
    "STAGE 2:",
    text.substring(
      0,
      3000
    )
  );


  /*
  Try JSON.
  */

  try {

    return normalizeAIResult(
      parseJSON(
        text
      )
    );

  } catch {

    return parseEvaluationText(
      text
    );

  }

}


/*
============================================================
MATCH FINDING TO D1 CHECK
============================================================
*/

function matchSafetyCheck(
  finding: Finding,
  checks: SafetyCheck[]
): SafetyCheck | null {

  /*
  Exact check ID.
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

    if (
      exact
    ) {

      return exact;

    }

  }


  /*
  Exact category.
  */

  const category =
    finding.category
      .trim()
      .toLowerCase();

  const categoryMatch =
    checks.find(
      check =>
        check.category
          .trim()
          .toLowerCase() ===
        category
    );

  if (
    categoryMatch
  ) {

    return categoryMatch;

  }


  /*
  Keyword matching.
  */

  const search =
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

  let bestScore =
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


    let score =
      0;


    for (
      const keyword
      of keywords
    ) {

      const word =
        keyword.trim();

      if (
        word &&
        search.includes(
          word
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
============================================================
SAVE PHOTO

IMPORTANT:

object_key is NOT NULL in your D1 schema.

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


  if (
    !columns.length
  ) {

    throw new Error(
      "inspection_photos table not found."
    );

  }


  const objectKey =
    `inspection/${inspectionId}/${photoId}-${fileName}`;


  const fields:
    Record<
      string,
      unknown
    > = {};


  if (
    columns.includes("id")
  ) {

    fields.id =
      photoId;

  }


  if (
    columns.includes(
      "inspection_id"
    )
  ) {

    fields.inspection_id =
      inspectionId;

  }


  if (
    columns.includes(
      "file_name"
    )
  ) {

    fields.file_name =
      fileName;

  }


  if (
    columns.includes(
      "filename"
    ) &&
    !(
      "file_name" in fields
    )
  ) {

    fields.filename =
      fileName;

  }


  if (
    columns.includes(
      "content_type"
    )
  ) {

    fields.content_type =
      contentType;

  }


  if (
    columns.includes(
      "mime_type"
    ) &&
    !(
      "content_type" in fields
    )
  ) {

    fields.mime_type =
      contentType;

  }


  /*
  REQUIRED.
  */

  if (
    columns.includes(
      "object_key"
    )
  ) {

    fields.object_key =
      objectKey;

  }


  if (
    columns.includes(
      "created_at"
    )
  ) {

    fields.created_at =
      nowISO();

  }


  const names =
    Object.keys(
      fields
    );


  if (
    !names.length
  ) {

    throw new Error(
      "No usable columns found in inspection_photos."
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
          fields[name]
      )
    )
    .run();


  return photoId;

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
            finding.check_id ||
            null,

          matched?.source_title ||
            finding.source_title ||
            "WSH Council",

          matched?.source_url ||
            finding.source_url ||
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
ANALYSE REQUEST
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
          "Invalid JSON request body.",

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
          "Image is required.",

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
  Normalize image.
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
            : String(error),

      },
      400
    );

  }


  /*
  Free-plan image limit.

  Browser should compress the image before uploading.
  */

  if (
    image.length >
    7_000_000
  ) {

    return jsonResponse(
      {

        success: false,

        error:
          "Image is too large. Please use a smaller or compressed photo.",

      },
      413
    );

  }


  /*
  ==========================================================
  CREATE INSPECTION
  ==========================================================
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
  ==========================================================
  SAVE PHOTO
  ==========================================================
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
  ==========================================================
  STAGE 1
  IDENTIFY RELEVANT SAFETY CATEGORIES
  ==========================================================
  */

  let scene:
    SceneAnalysis;


  try {

    scene =
      await detectRelevantCategories(
        env,
        image
      );

  } catch (error) {

    const detail =
      error instanceof Error
        ? error.message
        : String(error);


    try {

      await updateInspection(
        env.SAFETY_DB,
        inspection.id,
        "CHECK_REQUIRED"
      );

    } catch {
      // Ignore.
    }


    return jsonResponse(
      {

        success: false,

        error:
          "AI scene analysis failed.",

        detail,

        inspection_id:
          inspection.id,

      },
      500
    );

  }


  /*
  ==========================================================
  LOAD D1 SAFETY CHECKS
  ==========================================================
  */

  const allChecks =
    await loadSafetyChecks(
      env.SAFETY_DB
    );


  /*
  ==========================================================
  SELECT ONLY RELEVANT CHECKS
  ==========================================================
  */

  const relevantChecks =
    selectRelevantChecks(
      allChecks,
      scene.relevant_categories
    );


  console.log(
    "Relevant categories:",
    scene.relevant_categories
  );


  console.log(
    "Relevant D1 checks:",
    relevantChecks.map(
      check => check.id
    )
  );


  /*
  ==========================================================
  STAGE 2
  EVALUATE RELEVANT CHECKS
  ==========================================================
  */

  let aiResult:
    AIResult;


  try {

    aiResult =
      await evaluateRelevantChecks(
        env,
        image,
        relevantChecks
      );

  } catch (error) {

    const detail =
      error instanceof Error
        ? error.message
        : String(error);


    try {

      await updateInspection(
        env.SAFETY_DB,
        inspection.id,
        "CHECK_REQUIRED"
      );

    } catch {
      // Ignore.
    }


    return jsonResponse(
      {

        success: false,

        error:
          "AI safety evaluation failed.",

        detail,

        inspection_id:
          inspection.id,

        scene: {

          summary:
            scene.scene_summary,

          relevant_categories:
            scene.relevant_categories,

        },

      },
      500
    );

  }


  /*
  ==========================================================
  MATCH RESULTS TO D1
  ==========================================================
  */

  const findings =
    aiResult.findings
      .map(
        finding => {

          const matched =
            matchSafetyCheck(
              finding,
              relevantChecks
            );


          return {

            ...finding,

            category:
              matched?.category ||
              finding.category,

            check_id:
              matched?.id ||
              finding.check_id ||
              "",

            source_title:
              matched?.source_title ||
              finding.source_title ||
              "WSH Council",

            source_url:
              matched?.source_url ||
              finding.source_url ||
              WSH_URL,

          };

        }
      )
      .filter(
        finding =>
          scene.relevant_categories
            .some(
              category =>
                category
                  .toLowerCase() ===
                finding.category
                  .toLowerCase()
            ) ||
          relevantChecks.some(
            check =>
              check.id ===
              finding.check_id
          )
      )
      .slice(
        0,
        5
      );


  /*
  ==========================================================
  OVERALL RESULT
  ==========================================================
  */

  const overall =
    calculateOverall(
      findings
    );


  /*
  ==========================================================
  SAVE ITEMS
  ==========================================================
  */

  try {

    await saveInspectionItems(
      env.SAFETY_DB,
      inspection.id,
      photoId,
      findings,
      allChecks
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
  ==========================================================
  UPDATE INSPECTION
  ==========================================================
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
  ==========================================================
  RETURN
  ==========================================================
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

      scene: {

        summary:
          scene.scene_summary,

        relevant_categories:
          scene.relevant_categories,

      },

      summary:
        aiResult.scene_summary ||
        scene.scene_summary,

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

      architecture:
        "Activity-driven WSH checks",

      plan:
        "Cloudflare Workers Free optimized",

      timestamp:
        nowISO(),

    }
  );

}


/*
============================================================
SAFETY CHECKS API
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


    if (
      !inspection
    ) {

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
  INSPECTIONS
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

        architecture:
          "Activity-driven WSH inspection",

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
    CORS.
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
