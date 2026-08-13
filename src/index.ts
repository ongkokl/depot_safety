/*
 * ============================================================
 * SAFETY INSPECTION AI
 * Cloudflare Worker
 *
 * Workers AI:
 * @cf/meta/llama-3.2-11b-vision-instruct
 *
 * D1:
 *   inspections
 *   inspection_photos
 *   findings
 *   safety_checks
 *   corrective_actions
 *
 * R2:
 *   PHOTOS
 *
 * Vectorize:
 *   NOT USED
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
 * JSON RESPONSE SCHEMA
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
            type: "string"
          },

          title: {
            type: "string"
          },

          observation: {
            type: "string"
          },

          status: {
            type: "string"
          },

          risk_level: {
            type: "string"
          },

          confidence: {
            type: "number"
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
 * CATEGORY NORMALISATION
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
 * STATUS NORMALISATION
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
 * RISK NORMALISATION
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
 * CONFIDENCE NORMALISATION
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
   * AI sometimes returns 95 instead of 0.95.
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
 * FILE -> DATA URL
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
 * SAFETY AI PROMPT
 * ============================================================
 */

function buildPrompt(): string {

  return `
You are a workplace safety inspection AI assisting a
Singapore workplace safety inspector.

Analyse ONLY what can reasonably be seen in the photograph.

This is an assistance tool.
Do not make a final legal, regulatory or compliance decision.

IMPORTANT:

1. Do not invent hazards.

2. Do not assume a hazard exists merely because equipment
   is visible somewhere in the photograph.

3. If something cannot be confirmed visually, use
   CHECK_REQUIRED.

4. Use FAIL only when an unsafe condition is clearly visible.

5. Use PASS when the visible condition appears acceptable.

6. Maximum 6 findings.

7. Do not report every visible object.

8. Focus on workplace safety.

SAFETY CATEGORIES:

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

VISUAL REASONING:

A visible hard hat is evidence that a hard hat is being worn.

A visible safety vest or high-visibility clothing is evidence
of visible PPE.

If a guardrail is clearly visible, DO NOT say
"no guardrail".

If a guardrail is visible but its completeness, strength or
condition cannot be confirmed, use CHECK_REQUIRED.

A crane visible in the background does NOT automatically mean
the worker is exposed to a lifting hazard.

If lifting equipment is visible but no suspended load or worker
exposure can be confirmed, use CHECK_REQUIRED.

Only report a spill if a spill is actually visible.

Only report a fall hazard when there is reasonable visual
evidence.

Do not confuse shadows, reflections, stains or image artifacts
with hazards.

For uncertain conditions use CHECK_REQUIRED.

PPE EXAMPLE:

If worker clearly wears hard hat and high-visibility clothing:

category = PPE
status = PASS
risk_level = LOW

WORK AT HEIGHT EXAMPLE:

If guardrail is visible but its condition cannot be verified:

category = Work at Height
status = CHECK_REQUIRED
risk_level = MEDIUM

LIFTING EXAMPLE:

If crane/lifting equipment is visible but worker exposure to
suspended loads cannot be confirmed:

category = Lifting
status = CHECK_REQUIRED
risk_level = MEDIUM

FAIL should only be used when the unsafe condition is clearly
visible.

Return JSON with:

{
  "summary": "...",
  "findings": [
    {
      "category": "...",
      "title": "...",
      "observation": "...",
      "status": "PASS | CHECK_REQUIRED | FAIL",
      "risk_level": "LOW | MEDIUM | HIGH",
      "confidence": 0.0
    }
  ]
}

Return ONLY JSON.
`;
}


/*
 * ============================================================
 * FALLBACK JSON PROMPT
 * ============================================================
 */

function buildFallbackPrompt(): string {

  return `
Analyse the workplace safety photograph.

Return ONLY valid JSON.

Do not use Markdown.
Do not use ```.

Use exactly this structure:

{
  "summary": "short scene summary",
  "findings": [
    {
      "category": "PPE",
      "title": "short finding title",
      "observation": "what is visibly observed",
      "status": "PASS",
      "risk_level": "LOW",
      "confidence": 0.95
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

Allowed risk_level:

LOW
MEDIUM
HIGH

Rules:

- Do not invent hazards.
- Use CHECK_REQUIRED if something cannot be confirmed.
- Use FAIL only for a clearly visible unsafe condition.
- A visible guardrail must not be described as missing.
- A visible crane does not automatically mean lifting exposure.
- A visible hard hat is evidence of PPE being worn.
- A visible high-visibility vest is evidence of PPE being worn.
- Maximum 6 findings.
`;
}


/*
 * ============================================================
 * ROBUST AI RESPONSE PARSER
 *
 * Workers AI currently returns the generated text in
 * result.response for this model.
 *
 * This function also handles nested objects, JSON strings,
 * Markdown JSON and extra text surrounding JSON.
 * ============================================================
 */

function extractAIResponse(
  result: any
): any {

  console.log(
    "RAW WORKERS AI RESPONSE:",
    JSON.stringify(result)
  );


  function findStructuredObject(
    value: any,
    depth = 0
  ): any {

    if (
      depth > 8 ||
      value === null ||
      value === undefined
    ) {
      return null;
    }


    /*
     * Already structured.
     */

    if (
      typeof value === "object" &&
      !Array.isArray(value) &&
      Array.isArray(value.findings)
    ) {

      return value;
    }


    /*
     * String response.
     */

    if (
      typeof value === "string"
    ) {

      let cleaned =
        value.trim();


      /*
       * Remove common Markdown fences.
       */

      cleaned =
        cleaned
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


      /*
       * Try entire string.
       */

      try {

        const parsed =
          JSON.parse(
            cleaned
          );


        const found =
          findStructuredObject(
            parsed,
            depth + 1
          );


        if (found) {
          return found;
        }

      } catch {
        /*
         * Continue.
         */
      }


      /*
       * Look for JSON object inside text.
       */

      const firstBrace =
        cleaned.indexOf("{");

      const lastBrace =
        cleaned.lastIndexOf("}");


      if (
        firstBrace >= 0 &&
        lastBrace > firstBrace
      ) {

        const possibleJson =
          cleaned.slice(
            firstBrace,
            lastBrace + 1
          );


        try {

          const parsed =
            JSON.parse(
              possibleJson
            );


          const found =
            findStructuredObject(
              parsed,
              depth + 1
            );


          if (found) {
            return found;
          }

        } catch {
          /*
           * Continue.
           */
        }
      }


      return null;
    }


    /*
     * Array.
     */

    if (
      Array.isArray(value)
    ) {

      for (
        const item of value
      ) {

        const found =
          findStructuredObject(
            item,
            depth + 1
          );


        if (found) {
          return found;
        }
      }


      return null;
    }


    /*
     * Object.
     */

    if (
      typeof value === "object"
    ) {

      /*
       * Search common Workers AI response fields first.
       */

      const preferredKeys = [
        "response",
        "result",
        "output",
        "content",
        "text",
        "data"
      ];


      for (
        const key of preferredKeys
      ) {

        if (
          Object.prototype.hasOwnProperty.call(
            value,
            key
          )
        ) {

          const found =
            findStructuredObject(
              value[key],
              depth + 1
            );


          if (found) {
            return found;
          }
        }
      }


      /*
       * Search everything else.
       */

      for (
        const key of Object.keys(value)
      ) {

        if (
          preferredKeys.includes(key)
        ) {
          continue;
        }


        const found =
          findStructuredObject(
            value[key],
            depth + 1
          );


        if (found) {
          return found;
        }
      }
    }


    return null;
  }


  return findStructuredObject(
    result
  );
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


    const category =
      normaliseCategory(
        item.category ||
        "",
        title,
        observation
      );


    let status =
      normaliseStatus(
        item.status
      );


    let risk =
      normaliseRisk(
        item.risk_level
      );


    const confidence =
      normaliseConfidence(
        item.confidence
      );


    const combined =
      `${title} ${observation}`
        .toLowerCase();


    /*
     * --------------------------------------------------------
     * PPE SAFETY CORRECTION
     * --------------------------------------------------------
     */

    const ppeVisible =
      combined.includes(
        "hard hat"
      ) &&
      (
        combined.includes(
          "wear"
        ) ||
        combined.includes(
          "visible"
        )
      );


    const vestVisible =
      combined.includes(
        "safety vest"
      ) &&
      (
        combined.includes(
          "wear"
        ) ||
        combined.includes(
          "visible"
        )
      );


    if (
      category === "PPE" &&
      (
        ppeVisible ||
        vestVisible ||
        combined.includes(
          "high visibility clothing"
        ) ||
        combined.includes(
          "high-visibility clothing"
        )
      )
    ) {

      /*
       * Don't allow the AI to call visibly worn PPE a FAIL.
       */

      if (
        !combined.includes(
          "missing"
        ) &&
        !combined.includes(
          "not wearing"
        ) &&
        !combined.includes(
          "without"
        )
      ) {

        status =
          "PASS";

        risk =
          "LOW";
      }
    }


    /*
     * --------------------------------------------------------
     * GUARDRAIL SAFETY CORRECTION
     * --------------------------------------------------------
     */

    if (
      category === "Work at Height" &&
      combined.includes(
        "guardrail"
      )
    ) {

      const guardrailVisible =
        combined.includes(
          "guardrail is visible"
        ) ||
        combined.includes(
          "guardrail visible"
        ) ||
        combined.includes(
          "guardrail is present"
        ) ||
        combined.includes(
          "guardrail present"
        );


      if (
        guardrailVisible &&
        !combined.includes(
          "missing"
        ) &&
        !combined.includes(
          "no guardrail"
        )
      ) {

        /*
         * If the model says verify,
         * CHECK_REQUIRED is appropriate.
         */

        if (
          combined.includes(
            "verify"
          ) ||
          combined.includes(
            "condition"
          ) ||
          combined.includes(
            "secure"
          ) ||
          combined.includes(
            "complete"
          )
        ) {

          status =
            "CHECK_REQUIRED";

          risk =
            "MEDIUM";
        }
      }
    }


    /*
     * --------------------------------------------------------
     * LIFTING SAFETY CORRECTION
     * --------------------------------------------------------
     */

    if (
      category === "Lifting"
    ) {

      const equipmentOnly =
        (
          combined.includes(
            "crane is visible"
          ) ||
          combined.includes(
            "crane visible"
          ) ||
          combined.includes(
            "lifting equipment is visible"
          ) ||
          combined.includes(
            "lifting equipment visible"
          )
        ) &&
        !combined.includes(
          "suspended load"
        ) &&
        !combined.includes(
          "under a suspended load"
        ) &&
        !combined.includes(
          "worker is under"
        );


      if (
        equipmentOnly
      ) {

        status =
          "CHECK_REQUIRED";

        risk =
          "MEDIUM";
      }
    }


    findings.push({

      category,

      title,

      observation,

      status,

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
   * No findings.
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
 * LOAD WSH SAFETY CHECKS
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
 * MATCH WSH SAFETY CHECK
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


    if (
      check.category
        .toLowerCase()
        === category
    ) {

      score += 10;
    }


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
 * ATTACH WSH INFORMATION
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
 * OVERALL RESULT
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
   * inspections
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
   * R2
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
   * inspection_photos
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
   * findings
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
     * corrective_actions
     *
     * Automatically create action only for FAIL.
     * CHECK_REQUIRED is first verified by inspector.
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
 * RUN AI
 * ============================================================
 */

async function runSafetyAI(
  env: Env,
  image: string
): Promise<any> {

  /*
   * ----------------------------------------------------------
   * FIRST ATTEMPT
   *
   * JSON Schema
   * ----------------------------------------------------------
   */

  try {

    const result =
      await env.AI.run(
        MODEL,
        {
          messages: [

            {
              role: "system",

              content:
                "You are a careful Singapore workplace safety inspection assistant. Analyse only visible evidence."
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
      "AI JSON-SCHEMA RESULT:",
      JSON.stringify(result)
    );


    const parsed =
      extractAIResponse(
        result
      );


    if (
      parsed
    ) {

      return parsed;
    }


    /*
     * If JSON Schema produced an unexpected
     * response, continue to fallback.
     */

    console.warn(
      "JSON Schema response could not be parsed. Starting fallback."
    );

  } catch (
    error
  ) {

    console.warn(
      "JSON Schema AI request failed:",
      error
    );
  }


  /*
   * ----------------------------------------------------------
   * SECOND ATTEMPT
   *
   * Plain JSON Mode
   *
   * This is the important fallback.
   * ----------------------------------------------------------
   */

  const fallbackResult =
    await env.AI.run(
      MODEL,
      {
        messages: [

          {
            role: "system",

            content:
              "You are a workplace safety inspection assistant. Return ONLY valid JSON."
          },

          {
            role: "user",

            content:
              buildFallbackPrompt()
          }

        ],

        image,

        temperature:
          0,

        max_tokens:
          1600,

        response_format: {
          type:
            "json_object"
        }

      } as any
    );


  console.log(
    "AI FALLBACK RESULT:",
    JSON.stringify(
      fallbackResult
    )
  );


  const fallbackParsed =
    extractAIResponse(
      fallbackResult
    );


  if (
    fallbackParsed
  ) {

    return fallbackParsed;
  }


  /*
   * Last attempt: return raw response to parser.
   */

  throw new Error(
    "Workers AI returned an invalid JSON response."
  );
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
      !photo.type.startsWith(
        "image/"
      )
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
     * Maximum 8 MB.
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
     * Convert photo to Data URL.
     * --------------------------------------------------------
     */

    const image =
      await fileToDataUrl(
        photo
      );


    /*
     * --------------------------------------------------------
     * AI
     * --------------------------------------------------------
     */

    const aiData =
      await runSafetyAI(
        env,
        image
      );


    /*
     * --------------------------------------------------------
     * NORMALISE
     * --------------------------------------------------------
     */

    const parsed =
      normaliseAIFindings(
        aiData
      );


    /*
     * --------------------------------------------------------
     * LOAD WSH CHECKS
     * --------------------------------------------------------
     */

    const safetyChecks =
      await loadSafetyChecks(
        env
      );


    /*
     * --------------------------------------------------------
     * MATCH WSH GUIDANCE
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
     * RETURN
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
 * GET RECENT INSPECTIONS
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
 * GET SINGLE INSPECTION
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
 * MAIN FETCH
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
     * FRONTEND ASSETS
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


    /*
     * --------------------------------------------------------
     * DEFAULT
     * --------------------------------------------------------
     */

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

} satisfies ExportedHandler<Env>;
