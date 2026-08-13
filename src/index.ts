export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
}

/*
============================================================
DEPOT SAFETY INSPECTION AI
============================================================

Cloudflare Worker

AI MODEL:
@cf/meta/llama-3.2-11b-vision-instruct

DATABASE:
Cloudflare D1

ENDPOINTS:

GET  /api/health
GET  /api/safety-checks
GET  /api/inspections
GET  /api/inspections/:id

POST /api/analyze
POST /api/analyse
POST /api/analyze-photo
POST /api/analyse-photo

Vectorize is NOT required for this version.

============================================================
*/


const MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const WSH_DEFAULT_URL =
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
GENERAL HELPERS
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


  const result =
    value.trim();


  return result || fallback;

}


function clampConfidence(
  value: unknown
): number {

  const n =
    Number(value);


  if (
    !Number.isFinite(n)
  ) {

    return 0.5;

  }


  return Math.max(
    0,
    Math.min(
      1,
      n
    )
  );

}


/*
============================================================
NORMALISE STATUS
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
    text === "FAIL" ||
    text === "FAILED" ||
    text === "UNSAFE" ||
    text === "NOT SAFE"
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
============================================================
NORMALISE RISK
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
NORMALISE CATEGORY
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
      "No image was supplied."
    );

  }


  /*
  Already a data URL.
  */

  if (
    value.startsWith(
      "data:image/"
    )
  ) {

    return value;

  }


  /*
  Image URL.
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
============================================================
LOAD WSH SAFETY CHECKS
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
      "SAFETY CHECKS ERROR:",
      error
    );


    return [];

  }

}


/*
============================================================
BUILD SAFETY CHECK TEXT
============================================================
*/

function buildSafetyCheckText(
  checks: SafetyCheck[]
): string {

  if (
    !checks.length
  ) {

    return `
No active safety checks were found in D1.

Use general visible workplace safety principles only.

Do not invent specific WSH requirements.
`;

  }


  return checks
    .map(
      (check, index) => {

        return `
==================================================
SAFETY CHECK ${index + 1}
==================================================

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
============================================================
AI PROMPT
============================================================
*/

function buildAIPrompt(
  checks: SafetyCheck[]
): string {

  return `
You are an AI workplace safety inspection assistant
for a Singapore container depot / port environment.

Analyse the uploaded workplace photograph.

Your task is to identify safety conditions that can
actually be observed from the photograph.

Then match those conditions against the supplied
WSH safety check library.

IMPORTANT SAFETY RULES:

1. Only report things visible in the photograph.

2. Do not invent hazards.

3. Do not assume something is unsafe simply because
   it cannot be seen.

4. If a condition cannot be confirmed from the photo,
   use CHECK_REQUIRED.

5. Use FAIL only when a clearly unsafe condition is
   visibly present.

6. Use PASS only when there is reasonable visual
   evidence that the condition is satisfactory.

7. Do not claim complete legal compliance from one photo.

8. Do not invent Singapore WSH requirements.

9. Prefer the supplied safety checks.

10. Maximum 8 findings.

11. Avoid duplicate findings.

12. Keep observations factual.

13. Confidence must be between 0 and 1.

14. Do not assess equipment or areas that are not
    sufficiently visible.

15. Do not assume a vehicle, pedestrian route, crane,
    scaffold, electrical system, fire equipment or
    lifting operation is safe simply because it exists
    in the background.

16. If there is insufficient visual evidence,
    use CHECK_REQUIRED.

USE THIS FORMAT FOR EVERY FINDING:

* CATEGORY

Category: CATEGORY
Title: TITLE
Observation: OBSERVATION
Status: PASS
Risk Level: LOW
Confidence: 0.90
Check ID: CHECK-ID
Source Title: SOURCE
Source URL: URL

USE THESE CATEGORIES WHEN APPROPRIATE:

PPE
Housekeeping
Vehicular Safety
Work at Height
Lifting
Electrical Equipment
Fire Safety
Storage
People
Process
Equipment

IMPORTANT:

Only report observations supported by the photograph.

Do not write a long narrative.

Maximum 8 findings.

After the findings, provide a short overall observation.

WSH SAFETY CHECK LIBRARY:

${buildSafetyCheckText(checks)}

END OF SAFETY CHECK LIBRARY.
`;

}


/*
============================================================
EXTRACT AI RESPONSE TEXT
============================================================
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


  const obj =
    result as Record<
      string,
      unknown
    >;


  if (
    typeof obj.response === "string"
  ) {

    return obj.response;

  }


  if (
    typeof obj.result === "string"
  ) {

    return obj.result;

  }


  if (
    typeof obj.text === "string"
  ) {

    return obj.text;

  }


  return "";

}


/*
============================================================
PARSE JSON
============================================================
*/

function parseAIJSON(
  text: string
): unknown {

  let cleaned =
    text.trim();


  cleaned =
    cleaned.replace(
      /^```json\s*/i,
      ""
    );


  cleaned =
    cleaned.replace(
      /^```\s*/i,
      ""
    );


  cleaned =
    cleaned.replace(
      /\s*```$/i,
      ""
    );


  /*
  Try direct JSON.
  */

  try {

    return JSON.parse(
      cleaned
    );

  } catch {
    // Continue.
  }


  /*
  Find JSON object inside text.
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
============================================================
NORMALISE AI RESULT
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
      parseAIJSON(
        obj
      );

  }


  /*
  Handle:
  {
    response: {...}
  }
  */

  if (
    obj &&
    typeof obj === "object" &&
    obj.response &&
    typeof obj.response === "object"
  ) {

    obj =
      obj.response;

  }


  if (
    !obj ||
    typeof obj !== "object"
  ) {

    throw new Error(
      "Invalid AI result."
    );

  }


  const rawFindings =
    Array.isArray(
      obj.findings
    )
      ? obj.findings
      : [];


  const findings:
    Finding[] = [];


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


    const item =
      raw as Record<
        string,
        unknown
      >;


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
          "Physical/site verification required."
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
        clampConfidence(
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
          WSH_DEFAULT_URL
        ),

    });

  }


  return {

    scene_summary:
      cleanString(
        obj.scene_summary,
        "Workplace scene analysed."
      ),

    findings,

  };

}


/*
============================================================
NATURAL LANGUAGE AI PARSER
============================================================

The current Cloudflare Llama Vision model is returning
structured natural language rather than JSON.

Example:

* PPE
Category: PPE
Title: Worker's PPE
Observation: ...
Status: PASS
Risk Level: LOW
Confidence: 0.90
Check ID: ppe-001
Source Title: WSH Council resources
Source URL: https://www.tal.sg/wshc

This parser converts that into Finding objects.

============================================================
*/

function parseNaturalLanguageAIResponse(
  text: string
): AIResult {

  const findings:
    Finding[] = [];


  /*
  Supported categories.

  We use a broad category list so the parser is not
  dependent on one particular safety-check library.
  */

  const categories = [
    "PPE",
    "Housekeeping",
    "Vehicular Safety",
    "Work at Height",
    "Lifting",
    "Electrical Equipment",
    "Fire Safety",
    "Storage",
    "People",
    "Process",
    "Equipment",
    "Traffic Safety",
    "Chemical Safety",
    "Manual Handling",
    "Emergency Preparedness",
    "Other",
  ];


  /*
  Escape category names for regex.
  */

  const escapedCategories =
    categories
      .map(
        category =>
          category.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          )
      )
      .join("|");


  /*
  Match category headings.

  Examples:

  * PPE
  ** PPE
  PPE
  * **PPE**
  */

  const sectionRegex =
    new RegExp(
      `(?:^|\\n)\\s*(?:\\*{1,3}\\s*)?(${escapedCategories})(?:\\s*\\*{1,3})?\\s*(?:\\r?\\n|$)`,
      "gim"
    );


  const sections: Array<{
    category: string;
    text: string;
  }> = [];


  let matches:
    RegExpExecArray | null;


  while (
    (
      matches =
        sectionRegex.exec(text)
    ) !== null
  ) {

    const category =
      matches[1].trim();


    const start =
      matches.index +
      matches[0].length;


    const next =
      sectionRegex.exec(text);


    let end =
      text.length;


    if (next) {

      end =
        next.index;

      /*
      Reset lastIndex so the outer loop can
      continue correctly.

      We already consumed the next match.
      */

      sectionRegex.lastIndex =
        next.index;

    }


    sections.push({

      category,

      text:
        text
          .substring(
            start,
            end
          )
          .trim(),

    });

  }


  /*
  If regex didn't find sections, use a more
  forgiving parser based on "* CATEGORY".
  */

  if (
    sections.length === 0
  ) {

    const simpleRegex =
      /(?:^|\n)\s*\*{1,3}\s*([A-Za-z][A-Za-z ]{2,40})\s*(?:\r?\n|$)/g;


    let simpleMatch:
      RegExpExecArray | null;


    while (
      (
        simpleMatch =
          simpleRegex.exec(text)
      ) !== null
    ) {

      const category =
        simpleMatch[1]
          .trim();


      if (
        !categories.some(
          item =>
            item.toLowerCase() ===
            category.toLowerCase()
        )
      ) {

        continue;

      }


      const start =
        simpleMatch.index +
        simpleMatch[0].length;


      const next =
        text.indexOf(
          "\n* ",
          start
        );


      const end =
        next >= 0
          ? next
          : text.length;


      sections.push({

        category,

        text:
          text
            .substring(
              start,
              end
            )
            .trim(),

      });

    }

  }


  /*
  Parse each category section.
  */

  for (
    const section
    of sections
  ) {

    const sectionText =
      section.text;


    /*
    Category.
    */

    const categoryMatch =
      sectionText.match(
        /(?:^|\r?\n)\s*(?:\*{1,2}\s*)?Category\s*:\s*(.+?)(?:\r?\n|$)/i
      );


    /*
    Title.
    */

    const titleMatch =
      sectionText.match(
        /(?:^|\r?\n)\s*(?:\*{1,2}\s*)?Title\s*:\s*(.+?)(?:\r?\n|$)/i
      );


    /*
    Observation.
    */

    const observationMatch =
      sectionText.match(
        /(?:^|\r?\n)\s*(?:\*{1,2}\s*)?Observation\s*:\s*(.+?)(?:\r?\n|$)/i
      );


    /*
    Status.
    */

    const statusMatch =
      sectionText.match(
        /(?:^|\r?\n)\s*(?:\*{1,2}\s*)?Status\s*:\s*(PASS|FAIL|CHECK_REQUIRED)/i
      );


    /*
    Risk.
    */

    const riskMatch =
      sectionText.match(
        /(?:^|\r?\n)\s*(?:\*{1,2}\s*)?Risk\s*Level\s*:\s*(LOW|MEDIUM|HIGH)/i
      );


    /*
    Confidence.
    */

    const confidenceMatch =
      sectionText.match(
        /(?:^|\r?\n)\s*(?:\*{1,2}\s*)?Confidence\s*:\s*([0-9.]+)/i
      );


    /*
    Check ID.
    */

    const checkIdMatch =
      sectionText.match(
        /(?:^|\r?\n)\s*(?:\*{1,2}\s*)?Check\s*ID\s*:\s*([^\r\n*]+)/i
      );


    /*
    Source title.
    */

    const sourceTitleMatch =
      sectionText.match(
        /(?:^|\r?\n)\s*(?:\*{1,2}\s*)?Source\s*Title\s*:\s*([^\r\n*]+)/i
      );


    /*
    Source URL.
    */

    const sourceUrlMatch =
      sectionText.match(
        /(?:^|\r?\n)\s*(?:\*{1,2}\s*)?Source\s*URL\s*:\s*(https?:\/\/[^\s*]+)/i
      );


    /*
    Need at least title or observation.
    */

    if (
      !titleMatch &&
      !observationMatch
    ) {

      continue;

    }


    const category =
      cleanString(
        categoryMatch?.[1],
        section.category
      );


    const title =
      cleanString(
        titleMatch?.[1],
        category
      );


    const observation =
      cleanString(
        observationMatch?.[1],
        "Physical/site verification required."
      );


    const status =
      normalizeStatus(
        statusMatch?.[1]
      );


    const risk =
      normalizeRisk(
        riskMatch?.[1]
      );


    const confidence =
      clampConfidence(
        confidenceMatch?.[1]
      );


    const checkId =
      cleanString(
        checkIdMatch?.[1]
      )
      .replace(
        /\s+$/,
        ""
      );


    const sourceTitle =
      cleanString(
        sourceTitleMatch?.[1],
        "WSH Council"
      );


    const sourceUrl =
      cleanString(
        sourceUrlMatch?.[1],
        WSH_DEFAULT_URL
      );


    findings.push({

      category,

      title,

      observation,

      status,

      risk_level:
        risk,

      confidence,

      check_id:
        checkId,

      source_title:
        sourceTitle,

      source_url:
        sourceUrl,

    });

  }


  /*
  Remove duplicates.
  */

  const unique =
    findings.filter(
      (finding, index, array) => {

        return (
          index ===
          array.findIndex(
            item =>
              item.category
                .toLowerCase() ===
                finding.category
                  .toLowerCase() &&

              item.title
                .toLowerCase() ===
                finding.title
                  .toLowerCase()
          )
        );

      }
    );


  /*
  Build scene summary.

  The AI sometimes puts an overall summary after
  the findings. We capture that if available.
  */

  let sceneSummary =
    "Workplace scene analysed.";


  const overallMatch =
    text.match(
      /(?:^|\n)\s*(?:Overall|Overall Observation|Summary)\s*:?\s*([\s\S]+)$/i
    );


  if (
    overallMatch &&
    overallMatch[1]
  ) {

    sceneSummary =
      overallMatch[1]
        .replace(
          /\*/g,
          ""
        )
        .trim()
        .substring(
          0,
          1000
        );

  }


  /*
  If the parser did not find any structured findings,
  do NOT lose the AI analysis.

  Save it as CHECK_REQUIRED.
  */

  if (
    unique.length === 0
  ) {

    return {

      scene_summary:
        text
          .replace(
            /\*/g,
            ""
          )
          .trim()
          .substring(
            0,
            1500
          ),

      findings: [

        {

          category:
            "General Safety",

          title:
            "AI safety review",

          observation:
            text
              .replace(
                /\*/g,
                ""
              )
              .trim()
              .substring(
                0,
                2000
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
            WSH_DEFAULT_URL,

        },

      ],

    };

  }


  return {

    scene_summary:
      sceneSummary,

    findings:
      unique.slice(
        0,
        8
      ),

  };

}


/*
============================================================
RUN VISION AI
============================================================

IMPORTANT:

We intentionally DO NOT use response_format here.

Your current Cloudflare model is returning structured
natural-language output rather than JSON.

The parser above handles that output.

If the model returns JSON in the future, the JSON parser
will handle it automatically.

============================================================
*/

async function runVisionAI(
  env: Env,
  image: string,
  prompt: string
): Promise<AIResult> {

  const aiInput = {

    messages: [

      {

        role: "system",

        content:
          `
You are a Singapore workplace safety inspection assistant.

Analyse workplace photographs carefully.

Return concise structured safety findings.

For every finding use exactly this format:

* CATEGORY

Category: CATEGORY
Title: TITLE
Observation: OBSERVATION
Status: PASS
Risk Level: LOW
Confidence: 0.90
Check ID: CHECK-ID
Source Title: SOURCE
Source URL: URL

Only report visible or reasonably supported conditions.

Do not invent hazards.

Do not assume that something is safe simply because
it cannot be seen.

Use CHECK_REQUIRED where visual verification is needed.

Use FAIL only for clearly visible unsafe conditions.

Use PASS only where there is reasonable visual evidence.

Maximum 8 findings.
`,

      },

      {

        role: "user",

        content:
          prompt,

      },

    ],

    image,

    temperature:
      0.1,

    max_tokens:
      1800,

    top_p:
      0.9,

  };


  console.log(
    "Calling Workers AI Vision:",
    MODEL
  );


  let response:
    unknown;


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
  Extract text.
  */

  const text =
    extractAIResponseText(
      response
    );


  /*
  If Cloudflare returns a structured object
  directly, use it.
  */

  if (
    response &&
    typeof response ===
      "object"
  ) {

    const object =
      response as any;


    if (
      object.findings
    ) {

      return normalizeAIResult(
        object
      );

    }


    if (
      object.response &&
      typeof object.response ===
        "object"
    ) {

      return normalizeAIResult(
        object.response
      );

    }

  }


  if (!text) {

    throw new Error(
      "Workers AI returned no response."
    );

  }


  console.log(
    "Workers AI text length:",
    text.length
  );


  console.log(
    "Workers AI text:",
    text.substring(
      0,
      4000
    )
  );


  /*
  First try JSON.

  This allows the application to continue working
  if the model later returns JSON.
  */

  try {

    const parsed =
      parseAIJSON(
        text
      );


    return normalizeAIResult(
      parsed
    );

  } catch {

    /*
    Current model behaviour:

    It returns structured natural language.

    Parse that instead.
    */

    console.log(
      "AI response is not JSON. Using natural-language parser."
    );


    return parseNaturalLanguageAIResponse(
      text
    );

  }

}


/*
============================================================
MATCH FINDING TO SAFETY CHECK
============================================================
*/

function matchSafetyCheck(
  finding: Finding,
  checks: SafetyCheck[]
): SafetyCheck | null {

  /*
  1. Exact check ID.
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
  2. Category.
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
  3. Keyword matching.
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
        check.keywords || ""
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
        keyword &&
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
============================================================
CALCULATE OVERALL RESULT
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


  if (
    !names.length
  ) {

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
============================================================
UPDATE INSPECTION
============================================================
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


  if (
    !columns.length
  ) {

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


  if (
    !names.length
  ) {

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
============================================================
SAVE INSPECTION ITEMS

CONFIRMED TABLE:

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


    const itemId =
      crypto.randomUUID();


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
          WSH_DEFAULT_URL,

        nowISO()

      )
      .run();

  }

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


  /*
  Read request JSON.
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
  Validate image.
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
  Normalise image.
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
  Avoid excessively large requests.
  */

  if (
    image.length >
    15_000_000
  ) {

    return jsonResponse(
      {
        success: false,

        error:
          "Image is too large. Please use a smaller photo."
      },
      413
    );

  }


  /*
  Load safety checks.
  */

  const checks =
    await loadSafetyChecks(
      env.SAFETY_DB
    );


  /*
  Create inspection.
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
  Save photo record.
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
  Build AI prompt.
  */

  const prompt =
    buildAIPrompt(
      checks
    );


  /*
  Run AI.
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
          inspection.id
      },
      500
    );

  }


  /*
  Match findings against safety_checks.
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
  Calculate overall result.
  */

  const overall =
    calculateOverall(
      findings
    );


  /*
  Save inspection items.
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
      "SAVE INSPECTION ITEMS ERROR:",
      detail
    );


    return jsonResponse(
      {
        success: false,

        error:
          "AI analysis completed but the findings could not be saved.",

        detail,

        inspection_id:
          inspection.id,

        ai_result: {

          scene_summary:
            aiResult.scene_summary,

          findings,

        },

      },
      500
    );

  }


  /*
  Update overall inspection result.
  */

  try {

    await updateInspection(
      env.SAFETY_DB,
      inspection.id,
      overall
    );

  } catch (error) {

    console.error(
      "UPDATE INSPECTION ERROR:",
      error
    );

  }


  /*
  Return result.
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


/*
============================================================
SINGLE INSPECTION
============================================================
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
            : String(error),

      },
      500
    );

  }

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

      timestamp:
        nowISO(),

    }
  );

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

      available_endpoints: [

        "GET /api/health",

        "GET /api/safety-checks",

        "GET /api/inspections",

        "GET /api/inspections/:id",

        "POST /api/analyze",

        "POST /api/analyse",

        "POST /api/analyze-photo",

        "POST /api/analyse-photo",

      ],

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
