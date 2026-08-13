/*
 * ============================================================
 * SAFETY INSPECTION AI
 * Cloudflare Worker
 *
 * D1 TABLES USED:
 *
 * inspections
 * inspection_photos
 * findings
 * safety_checks
 * corrective_actions
 *
 * Workers AI:
 * @cf/meta/llama-3.2-11b-vision-instruct
 *
 * Vectorize:
 * NOT USED
 * ============================================================
 */

interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS?: Fetcher;
}

const MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";


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
  status: string;
  risk_level: string;
  confidence: number;
}

interface ParsedFinding {
  category: string;
  title: string;
  observation: string;
  status: "PASS" | "CHECK_REQUIRED" | "FAIL";
  risk_level: "LOW" | "MEDIUM" | "HIGH";
  confidence: number;

  check_id?: string;
  check_question?: string;
  guidance?: string;
  source_title?: string;
  source_url?: string;
}


/*
 * ============================================================
 * RESPONSE HELPERS
 * ============================================================
 */

function json(
  data: any,
  status = 200
): Response {

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8",

        "Access-Control-Allow-Origin":
          "*",

        "Access-Control-Allow-Headers":
          "Content-Type",

        "Access-Control-Allow-Methods":
          "GET,POST,OPTIONS"
      }
    }
  );
}


function text(
  value: any,
  max = 1000
): string {

  return String(value ?? "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}


function newId(): string {
  return crypto.randomUUID();
}


function inspectionNumber(): string {

  const date =
    new Date()
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");

  const random =
    crypto.randomUUID()
      .replace(/-/g, "")
      .slice(0, 6)
      .toUpperCase();

  return `SI-${date}-${random}`;
}


/*
 * ============================================================
 * NORMALISE CATEGORY
 * ============================================================
 */

function normaliseCategory(
  category: string,
  title = "",
  observation = ""
): string {

  const value =
    `${category} ${title} ${observation}`
      .toLowerCase();


  if (
    value.includes("ppe") ||
    value.includes("hard hat") ||
    value.includes("helmet") ||
    value.includes("safety vest") ||
    value.includes("high visibility") ||
    value.includes("high-visibility") ||
    value.includes("hi-vis") ||
    value.includes("glove") ||
    value.includes("safety shoe")
  ) {
    return "PPE";
  }


  if (
    value.includes("work at height") ||
    value.includes("height") ||
    value.includes("guardrail") ||
    value.includes("guard rail") ||
    value.includes("handrail") ||
    value.includes("fall hazard") ||
    value.includes("open edge") ||
    value.includes("ladder") ||
    value.includes("scaffold")
  ) {
    return "Work at Height";
  }


  if (
    value.includes("lifting") ||
    value.includes("crane") ||
    value.includes("suspended load") ||
    value.includes("lifting equipment") ||
    value.includes("hook") ||
    value.includes("sling")
  ) {
    return "Lifting";
  }


  if (
    value.includes("vehicular") ||
    value.includes("vehicle") ||
    value.includes("truck") ||
    value.includes("prime mover") ||
    value.includes("forklift") ||
    value.includes("traffic") ||
    value.includes("pedestrian")
  ) {
    return "Vehicular Safety";
  }


  if (
    value.includes("housekeeping") ||
    value.includes("spill") ||
    value.includes("oil") ||
    value.includes("wet surface") ||
    value.includes("slippery") ||
    value.includes("debris") ||
    value.includes("clutter") ||
    value.includes("obstruction")
  ) {
    return "Housekeeping";
  }


  return "Other";
}


/*
 * ============================================================
 * NORMALISE STATUS
 * ============================================================
 */

function normaliseStatus(
  value: any
): "PASS" | "CHECK_REQUIRED" | "FAIL" {

  const v =
    String(value ?? "")
      .toUpperCase()
      .replace(/[\s-]+/g, "_")
      .trim();


  if (v === "PASS") {
    return "PASS";
  }


  if (v === "FAIL") {
    return "FAIL";
  }


  return "CHECK_REQUIRED";
}


/*
 * ============================================================
 * NORMALISE RISK
 * ============================================================
 */

function normaliseRisk(
  value: any
): "LOW" | "MEDIUM" | "HIGH" {

  const v =
    String(value ?? "")
      .toUpperCase()
      .trim();


  if (v === "LOW") {
    return "LOW";
  }


  if (v === "HIGH") {
    return "HIGH";
  }


  return "MEDIUM";
}


/*
 * ============================================================
 * NORMALISE CONFIDENCE
 * ============================================================
 */

function normaliseConfidence(
  value: any
): number {

  let n =
    Number(value);


  if (
    Number.isNaN(n)
  ) {
    return 0.5;
  }


  /*
   * Model may return 95 instead of 0.95.
   */

  if (n > 1) {
    n = n / 100;
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
 * ============================================================
 * IMAGE -> DATA URL
 * ============================================================
 */

async function fileToDataUrl(
  file: File
): Promise<string> {

  const buffer =
    await file.arrayBuffer();

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


  return (
    `data:${file.type || "image/jpeg"};base64,${btoa(binary)}`
  );
}


/*
 * ============================================================
 * AI JSON SCHEMA
 * ============================================================
 */

const AI_RESPONSE_SCHEMA = {

  type: "object",

  properties: {

    summary: {
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
              "CHECK_REQUIRED",
              "FAIL"
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
            type: "number",
            minimum: 0,
            maximum: 1
          }

        },

        required: [
          "category",
          "title",
          "observation",
          "status",
          "risk_level",
          "confidence"
        ]

      }

    }

  },

  required: [
    "summary",
    "findings"
  ]

};


/*
 * ============================================================
 * AI PROMPT
 * ============================================================
 */

function buildPrompt(): string {

  return `
You are a workplace safety inspection AI assisting a
Singapore workplace safety inspector.

Analyse ONLY what can reasonably be seen in the photograph.

This is an assistance tool.
Do not make a final legal, regulatory or compliance decision.

IMPORTANT SAFETY RULES:

1. Do not invent hazards.

2. Do not assume a hazard exists merely because equipment
   is visible somewhere in the photograph.

3. If something cannot be confirmed visually, use
   CHECK_REQUIRED.

4. Use FAIL only when an unsafe condition is clearly visible.

5. Use PASS when the visible condition appears acceptable.

6. Maximum 6 findings.

7. Do not report every visible object as a safety issue.

8. Focus on conditions relevant to workplace safety inspection.

SAFETY AREAS:

PPE:
- hard hat
- safety helmet
- safety vest
- high visibility clothing
- gloves
- safety shoes

WORK AT HEIGHT:
- guardrails
- handrails
- open edges
- platforms
- ladders
- scaffolds
- fall hazards

LIFTING:
- cranes
- lifting equipment
- hooks
- slings
- suspended loads
- container lifting

VEHICULAR SAFETY:
- trucks
- prime movers
- forklifts
- vehicles
- pedestrian routes
- vehicle/pedestrian interaction

HOUSEKEEPING:
- spills
- oil
- water
- wet surfaces
- debris
- clutter
- blocked access
- obstructions

IMPORTANT VISUAL REASONING:

A visible hard hat is evidence of PPE compliance.
A visible safety vest is evidence of PPE compliance.

If a guardrail is clearly visible, DO NOT say
"no guardrail".

If a guardrail is visible but its completeness or condition
cannot be confirmed, use CHECK_REQUIRED.

A crane visible in the background does NOT automatically
mean the worker is exposed to a lifting hazard.

If lifting equipment is visible but no suspended load or
worker exposure can be confirmed, use CHECK_REQUIRED rather
than FAIL.

Only report a spill if a spill is actually visible.

Only report a fall hazard when there is reasonable visual
evidence.

Do not confuse shadows, reflections or stains with hazards.

For uncertain conditions use CHECK_REQUIRED.

CONFIDENCE:

Return confidence between 0 and 1.

PASS examples:

Hard hat clearly visible:
PASS / LOW / high confidence.

Safety vest clearly visible:
PASS / LOW / high confidence.

FAIL examples:

Worker clearly standing under a suspended load:
FAIL / HIGH.

Clearly missing required guardrail at an exposed edge:
FAIL / HIGH.

CHECK_REQUIRED examples:

Guardrail visible but condition cannot be fully confirmed.

Crane or lifting equipment visible but worker exposure
cannot be confirmed.

PPE requirement cannot be confirmed from the photograph.

Return ONLY the structured JSON response requested by
the system schema.
`;
}


/*
 * ============================================================
 * EXTRACT AI RESULT
 * ============================================================
 */

function extractAIResponse(
  result: any
): any {

  /*
   * Workers AI JSON Mode normally returns:
   *
   * {
   *   response: {...}
   * }
   *
   * But handle several possible response forms.
   */

  if (
    result &&
    typeof result.response === "object"
  ) {
    return result.response;
  }


  if (
    result &&
    typeof result.result === "object"
  ) {
    return result.result;
  }


  if (
    typeof result?.response === "string"
  ) {

    try {
      return JSON.parse(
        result.response
      );
    } catch {
      return null;
    }

  }


  if (
    typeof result?.result === "string"
  ) {

    try {
      return JSON.parse(
        result.result
      );
    } catch {
      return null;
    }

  }


  return null;
}


/*
 * ============================================================
 * NORMALISE AI FINDINGS
 * ============================================================
 */

function normaliseAIFindings(
  data: any
): {
  summary: string;
  findings: ParsedFinding[];
} {

  const summary =
    text(
      data?.summary ||
      "Workplace scene analysed.",
      600
    );


  const sourceFindings =
    Array.isArray(
      data?.findings
    )
      ? data.findings
      : [];


  const findings:
    ParsedFinding[] = [];


  for (
    const item of sourceFindings
  ) {

    if (
      !item ||
      typeof item !== "object"
    ) {
      continue;
    }


    const title =
      text(
        item.title ||
        "AI finding requires review",
        300
      );


    const observation =
      text(
        item.observation ||
        title,
        1000
      );


    let category =
      normaliseCategory(
        item.category ||
        "",
        title,
        observation
      );


    const status =
      normaliseStatus(
        item.status
      );


    const risk =
      normaliseRisk(
        item.risk_level
      );


    const confidence =
      normaliseConfidence(
        item.confidence
      );


    /*
     * Additional safety corrections.
     */

    const combined =
      `${title} ${observation}`
        .toLowerCase();


    /*
     * If the AI says the vest is visible,
     * it must not become a missing-vest finding.
     */

    if (
      category === "PPE" &&
      (
        combined.includes(
          "safety vest visible"
        ) ||
        combined.includes(
          "vest visible"
        ) ||
        combined.includes(
          "high visibility clothing"
        ) ||
        combined.includes(
          "high-visibility clothing"
        ) ||
        combined.includes(
          "wearing a hard hat"
        )
      )
    ) {

      if (
        status !== "FAIL"
      ) {

        findings.push({

          category,

          title,

          observation,

          status:
            "PASS",

          risk_level:
            "LOW",

          confidence

        });

        continue;
      }
    }


    /*
     * If a guardrail is visibly present,
     * don't allow "no guardrail" type logic.
     */

    let correctedStatus =
      status;


    if (
      category === "Work at Height" &&
      combined.includes(
        "guardrail"
      ) &&
      (
        combined.includes(
          "visible"
        ) ||
        combined.includes(
          "present"
        )
      ) &&
      !combined.includes(
        "missing"
      ) &&
      !combined.includes(
        "no guardrail"
      )
    ) {

      if (
        status === "FAIL" &&
        combined.includes(
          "verify"
        )
      ) {

        correctedStatus =
          "CHECK_REQUIRED";
      }
    }


    /*
     * Lifting:
     *
     * Equipment visible alone should normally
     * be CHECK_REQUIRED rather than FAIL.
     */

    if (
      category === "Lifting" &&
      (
        combined.includes(
          "equipment is visible"
        ) ||
        combined.includes(
          "crane is visible"
        ) ||
        combined.includes(
          "lifting equipment is visible"
        )
      ) &&
      !combined.includes(
        "suspended load"
      ) &&
      !combined.includes(
        "worker is under"
      )
    ) {

      if (
        correctedStatus === "FAIL"
      ) {

        correctedStatus =
          "CHECK_REQUIRED";
      }
    }


    findings.push({

      category,

      title,

      observation,

      status:
        correctedStatus,

      risk_level:
        risk,

      confidence

    });


    if (
      findings.length >= 6
    ) {
      break;
    }
  }


  /*
   * If AI returned nothing, create a review item.
   */

  if (
    findings.length === 0
  ) {

    findings.push({

      category:
        "Other",

      title:
        "AI analysis requires review",

      observation:
        "The AI did not return a usable safety finding. Physical verification is required.",

      status:
        "CHECK_REQUIRED",

      risk_level:
        "MEDIUM",

      confidence:
        0.5

    });

  }


  return {
    summary,
    findings
  };
}


/*
 * ============================================================
 * LOAD SAFETY CHECKS
 * ============================================================
 */

async function loadSafetyChecks(
  env: Env
): Promise<SafetyCheck[]> {

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
          keywords,
          active
        FROM safety_checks
        WHERE active = 1
        ORDER BY category
        `
      )
      .all<SafetyCheck>();


  return result.results || [];
}


/*
 * ============================================================
 * MATCH SAFETY CHECK
 * ============================================================
 */

function matchSafetyCheck(
  finding: ParsedFinding,
  checks: SafetyCheck[]
): SafetyCheck | null {

  if (
    checks.length === 0
  ) {
    return null;
  }


  const category =
    finding.category
      .toLowerCase();


  /*
   * First restrict to the same category.
   */

  const categoryMatches =
    checks.filter(
      check =>
        check.category
          .toLowerCase()
          === category
    );


  const candidates =
    categoryMatches.length > 0
      ? categoryMatches
      : checks;


  const searchText =
    `${finding.title} ${finding.observation}`
      .toLowerCase();


  let best:
    SafetyCheck | null =
      null;

  let bestScore =
    -1;


  for (
    const check of candidates
  ) {

    const keywords =
      String(
        check.keywords || ""
      )
        .toLowerCase()
        .split(
          /[,;|]+/
        )
        .map(
          x => x.trim()
        )
        .filter(Boolean);


    let score =
      0;


    /*
     * Category match.
     */

    if (
      check.category
        .toLowerCase()
        === category
    ) {

      score += 10;
    }


    /*
     * Keyword match.
     */

    for (
      const keyword of keywords
    ) {

      if (
        keyword.length >= 2 &&
        searchText.includes(
          keyword
        )
      ) {

        score += 3;
      }
    }


    /*
     * Check question terms.
     */

    const questionWords =
      check.check_question
        .toLowerCase()
        .split(/\W+/)
        .filter(
          word =>
            word.length >= 4
        );


    for (
      const word of questionWords
    ) {

      if (
        searchText.includes(word)
      ) {

        score += 0.25;
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
 * ATTACH WSH CHECK
 * ============================================================
 */

function attachSafetyChecks(
  findings: ParsedFinding[],
  checks: SafetyCheck[]
): ParsedFinding[] {

  return findings.map(
    finding => {

      const check =
        matchSafetyCheck(
          finding,
          checks
        );


      if (
        !check
      ) {

        return finding;
      }


      return {

        ...finding,

        check_id:
          check.id,

        check_question:
          check.check_question,

        guidance:
          check.guidance,

        source_title:
          check.source_title,

        source_url:
          check.source_url

      };
    }
  );
}


/*
 * ============================================================
 * CALCULATE OVERALL RESULT
 * ============================================================
 */

function calculateOverall(
  findings: ParsedFinding[]
): "PASS" | "CHECK_REQUIRED" | "ATTENTION" {

  if (
    findings.some(
      finding =>
        finding.status === "FAIL"
    )
  ) {

    return "ATTENTION";
  }


  if (
    findings.some(
      finding =>
        finding.status === "CHECK_REQUIRED"
    )
  ) {

    return "CHECK_REQUIRED";
  }


  return "PASS";
}


/*
 * ============================================================
 * SAVE INSPECTION
 * ============================================================
 */

async function saveInspection(
  env: Env,
  location: string,
  inspector: string,
  photo: File,
  findings: ParsedFinding[],
  overall: string
) {

  const inspectionId =
    newId();

  const inspectionNo =
    inspectionNumber();

  const photoId =
    newId();

  const createdAt =
    new Date()
      .toISOString();


  /*
   * ----------------------------------------------------------
   * INSPECTIONS
   * ----------------------------------------------------------
   */

  await env.SAFETY_DB
    .prepare(
      `
      INSERT INTO inspections (
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
      inspectionId,
      inspectionNo,
      location,
      inspector,
      createdAt,
      overall
    )
    .run();


  /*
   * ----------------------------------------------------------
   * R2 PHOTO
   * ----------------------------------------------------------
   */

  const safeFileName =
    photo.name
      .replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
      );


  const objectKey =
    `inspections/${inspectionId}/${Date.now()}-${safeFileName}`;


  const photoBuffer =
    await photo.arrayBuffer();


  await env.PHOTOS.put(
    objectKey,
    photoBuffer,
    {
      httpMetadata: {
        contentType:
          photo.type ||
          "image/jpeg"
      }
    }
  );


  /*
   * ----------------------------------------------------------
   * INSPECTION PHOTO
   * ----------------------------------------------------------
   */

  await env.SAFETY_DB
    .prepare(
      `
      INSERT INTO inspection_photos (
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
      photo.name,
      photo.type || "image/jpeg",
      createdAt
    )
    .run();


  /*
   * ----------------------------------------------------------
   * FINDINGS
   * ----------------------------------------------------------
   */

  for (
    const finding of findings
  ) {

    const findingId =
      newId();


    await env.SAFETY_DB
      .prepare(
        `
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
        `
      )
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
        createdAt
      )
      .run();


    /*
     * --------------------------------------------------------
     * CORRECTIVE ACTION
     *
     * Only create automatically for FAIL.
     *
     * CHECK_REQUIRED requires inspector verification first.
     * --------------------------------------------------------
     */

    if (
      finding.status === "FAIL"
    ) {

      await env.SAFETY_DB
        .prepare(
          `
          INSERT INTO corrective_actions (
            id,
            finding_id,
            description,
            responsible_person,
            due_date,
            status,
            created_at,
            completed_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .bind(
          newId(),
          findingId,
          `Correct the unsafe condition identified: ${finding.title}. ${finding.observation}`,
          null,
          null,
          "OPEN",
          createdAt,
          null
        )
        .run();
    }
  }


  return {
    inspectionId,
    inspectionNo,
    photoId
  };
}


/*
 * ============================================================
 * ANALYSE PHOTO
 * ============================================================
 */

async function analyze(
  request: Request,
  env: Env
): Promise<Response> {

  try {

    const form =
      await request.formData();


    const photo =
      form.get("photo");


    if (
      !(photo instanceof File)
    ) {

      return json(
        {
          error:
            "No photo uploaded."
        },
        400
      );
    }


    if (
      !photo.type.startsWith("image/")
    ) {

      return json(
        {
          error:
            "The uploaded file is not an image."
        },
        400
      );
    }


    /*
     * 8 MB maximum.
     */

    if (
      photo.size >
      8 * 1024 * 1024
    ) {

      return json(
        {
          error:
            "Photo is too large. Maximum size is 8 MB."
        },
        400
      );
    }


    const location =
      text(
        form.get("location") ||
        "Unspecified",
        200
      );


    const inspector =
      text(
        form.get("inspector") ||
        "Inspector",
        200
      );


    /*
     * --------------------------------------------------------
     * IMAGE
     * --------------------------------------------------------
     */

    const image =
      await fileToDataUrl(
        photo
      );


    /*
     * --------------------------------------------------------
     * WORKERS AI
     *
     * JSON Mode is supported by this model.
     * --------------------------------------------------------
     */

    const aiResult =
      await env.AI.run(
        MODEL,
        {
          messages: [

            {
              role: "system",

              content:
                "You are a careful Singapore workplace safety inspection assistant. Analyse only visible evidence and return the requested structured result."
            },

            {
              role: "user",

              content:
                buildPrompt()
            }

          ],

          image,

          temperature:
            0.05,

          max_tokens:
            1600,

          response_format: {
            type:
              "json_schema",

            json_schema:
              AI_RESPONSE_SCHEMA
          }

        } as any
      );


    console.log(
      "Workers AI result:",
      JSON.stringify(
        aiResult
      )
    );


    /*
     * --------------------------------------------------------
     * EXTRACT JSON
     * --------------------------------------------------------
     */

    const aiData =
      extractAIResponse(
        aiResult
      );


    if (
      !aiData
    ) {

      throw new Error(
        "Workers AI returned an invalid structured response."
      );
    }


    /*
     * --------------------------------------------------------
     * NORMALISE FINDINGS
     * --------------------------------------------------------
     */

    const parsed =
      normaliseAIFindings(
        aiData
      );


    /*
     * --------------------------------------------------------
     * LOAD WSH SAFETY CHECKS
     * --------------------------------------------------------
     */

    const safetyChecks =
      await loadSafetyChecks(
        env
      );


    /*
     * --------------------------------------------------------
     * MATCH WSH CHECKS
     * --------------------------------------------------------
     */

    const findings =
      attachSafetyChecks(
        parsed.findings,
        safetyChecks
      );


    /*
     * --------------------------------------------------------
     * OVERALL RESULT
     * --------------------------------------------------------
     */

    const overall =
      calculateOverall(
        findings
      );


    /*
     * --------------------------------------------------------
     * SAVE TO D1
     * --------------------------------------------------------
     */

    const saved =
      await saveInspection(
        env,
        location,
        inspector,
        photo,
        findings,
        overall
      );


    /*
     * --------------------------------------------------------
     * RESPONSE
     * --------------------------------------------------------
     */

    return json({

      ok:
        true,

      inspection_id:
        saved.inspectionId,

      inspection_no:
        saved.inspectionNo,

      photo_id:
        saved.photoId,

      location,

      inspector,

      overall_result:
        overall,

      scene_summary:
        parsed.summary,

      findings

    });


  } catch (
    error: any
  ) {

    console.error(
      "ANALYSIS ERROR:",
      error
    );


    return json(
      {
        error:
          "AI analysis failed.",

        detail:
          error?.message ||
          String(error)
      },
      500
    );
  }
}


/*
 * ============================================================
 * RECENT INSPECTIONS
 * ============================================================
 */

async function getInspections(
  env: Env
): Promise<Response> {

  try {

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
          LIMIT 50
          `
        )
        .all();


    return json({
      inspections:
        result.results || []
    });


  } catch (
    error: any
  ) {

    console.error(
      "GET INSPECTIONS ERROR:",
      error
    );


    return json(
      {
        error:
          "Unable to load recent inspections.",

        detail:
          error?.message ||
          String(error)
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

async function getInspection(
  env: Env,
  inspectionId: string
): Promise<Response> {

  try {

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
        .bind(
          inspectionId
        )
        .first();


    if (
      !inspection
    ) {

      return json(
        {
          error:
            "Inspection not found."
        },
        404
      );
    }


    const findingsResult =
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
          FROM findings
          WHERE inspection_id = ?
          ORDER BY created_at ASC
          `
        )
        .bind(
          inspectionId
        )
        .all();


    const photosResult =
      await env.SAFETY_DB
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
        .bind(
          inspectionId
        )
        .all();


    const actionsResult =
      await env.SAFETY_DB
        .prepare(
          `
          SELECT
            id,
            finding_id,
            description,
            responsible_person,
            due_date,
            status,
            created_at,
            completed_at
          FROM corrective_actions
          WHERE finding_id IN (
            SELECT id
            FROM findings
            WHERE inspection_id = ?
          )
          ORDER BY created_at ASC
          `
        )
        .bind(
          inspectionId
        )
        .all();


    return json({

      inspection,

      findings:
        findingsResult.results || [],

      photos:
        photosResult.results || [],

      corrective_actions:
        actionsResult.results || []

    });


  } catch (
    error: any
  ) {

    console.error(
      "GET INSPECTION ERROR:",
      error
    );


    return json(
      {
        error:
          "Unable to load inspection.",

        detail:
          error?.message ||
          String(error)
      },
      500
    );
  }
}


/*
 * ============================================================
 * HEALTH CHECK
 * ============================================================
 */

async function health(
  env: Env
): Promise<Response> {

  try {

    await env.SAFETY_DB
      .prepare(
        "SELECT 1 AS ok"
      )
      .first();


    return json({

      ok:
        true,

      service:
        "Safety Inspection AI",

      model:
        MODEL,

      vectorize:
        false

    });


  } catch (
    error: any
  ) {

    return json(
      {
        ok:
          false,

        error:
          error?.message ||
          String(error)
      },
      500
    );
  }
}


/*
 * ============================================================
 * FETCH
 * ============================================================
 */

export default {

  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {

    const url =
      new URL(
        request.url
      );


    /*
     * --------------------------------------------------------
     * CORS
     * --------------------------------------------------------
     */

    if (
      request.method === "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,

          headers: {

            "Access-Control-Allow-Origin":
              "*",

            "Access-Control-Allow-Headers":
              "Content-Type",

            "Access-Control-Allow-Methods":
              "GET,POST,OPTIONS"

          }
        }
      );
    }


    /*
     * --------------------------------------------------------
     * HEALTH
     * --------------------------------------------------------
     */

    if (
      url.pathname ===
      "/api/health"
    ) {

      return health(
        env
      );
    }


    /*
     * --------------------------------------------------------
     * ANALYSE PHOTO
     * --------------------------------------------------------
     */

    if (
      url.pathname ===
      "/api/analyze"
    ) {

      if (
        request.method !== "POST"
      ) {

        return json(
          {
            error:
              "Method not allowed."
          },
          405
        );
      }


      return analyze(
        request,
        env
      );
    }


    /*
     * --------------------------------------------------------
     * RECENT INSPECTIONS
     * --------------------------------------------------------
     */

    if (
      url.pathname ===
      "/api/inspections"
    ) {

      if (
        request.method !== "GET"
      ) {

        return json(
          {
            error:
              "Method not allowed."
          },
          405
        );
      }


      return getInspections(
        env
      );
    }


    /*
     * --------------------------------------------------------
     * SINGLE INSPECTION
     * --------------------------------------------------------
     */

    const inspectionPrefix =
      "/api/inspections/";


    if (
      url.pathname.startsWith(
        inspectionPrefix
      )
    ) {

      const inspectionId =
        decodeURIComponent(
          url.pathname.slice(
            inspectionPrefix.length
          )
        );


      if (
        inspectionId
      ) {

        return getInspection(
          env,
          inspectionId
        );
      }
    }


    /*
     * --------------------------------------------------------
     * FRONTEND
     * --------------------------------------------------------
     */

    if (
      env.ASSETS
    ) {

      try {

        return env.ASSETS.fetch(
          request
        );

      } catch (
        error
      ) {

        console.error(
          "ASSETS ERROR:",
          error
        );
      }
    }


    return new Response(
      "Safety Inspection AI",
      {
        status: 200,

        headers: {
          "Content-Type":
            "text/plain"
        }
      }
    );
  }

};
