/*
 * ============================================================
 * SAFETY INSPECTION AI
 * Cloudflare Worker
 *
 * Database:
 *   D1
 *
 * Tables:
 *   inspections
 *   inspection_photos
 *   findings
 *   safety_checks
 *   corrective_actions
 *
 * AI:
 *   @cf/meta/llama-3.2-11b-vision-instruct
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

  const now =
    new Date();

  const date =
    now.toISOString()
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
 * NORMALISE STATUS / RISK
 * ============================================================
 */


function normaliseStatus(
  value: string
): ParsedFinding["status"] {

  const v =
    value
      .toUpperCase()
      .replace(/[\s-]+/g, "_");


  if (
    v === "PASS"
  ) {

    return "PASS";

  }


  if (
    v === "FAIL"
  ) {

    return "FAIL";

  }


  return "CHECK_REQUIRED";

}


function normaliseRisk(
  value: string
): ParsedFinding["risk_level"] {

  const v =
    value
      .toUpperCase()
      .trim();


  if (
    v === "LOW"
  ) {

    return "LOW";

  }


  if (
    v === "HIGH"
  ) {

    return "HIGH";

  }


  return "MEDIUM";

}


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
   * Handle models returning 95 instead of 0.95.
   */

  if (
    n > 1
  ) {

    n =
      n / 100;

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
    new Uint8Array(
      buffer
    );


  let binary =
    "";


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
 * EXTRACT AI RESPONSE
 * ============================================================
 */


function extractAiText(
  result: any
): string {

  if (
    typeof result === "string"
  ) {

    return result.trim();

  }


  if (
    typeof result?.response === "string"
  ) {

    return result.response.trim();

  }


  if (
    typeof result?.result === "string"
  ) {

    return result.result.trim();

  }


  return "";

}


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

This is an assistance tool. Do not make a final legal,
regulatory or compliance decision.

IMPORTANT:

- Do not invent hazards.
- Do not assume a hazard exists because equipment is visible.
- If something cannot be confirmed visually, use CHECK_REQUIRED.
- Use FAIL only when an unsafe condition is clearly visible.
- Use PASS when the visible condition appears acceptable.
- Maximum 6 findings.

SAFETY AREAS:

1. PPE
   - hard hat
   - safety helmet
   - safety vest
   - high visibility clothing
   - gloves
   - safety shoes

2. Work at Height
   - guardrails
   - handrails
   - open edges
   - platforms
   - ladders
   - scaffolds
   - fall hazards

3. Lifting
   - cranes
   - lifting equipment
   - hooks
   - slings
   - suspended loads
   - container lifting

4. Vehicular Safety
   - trucks
   - prime movers
   - forklifts
   - vehicles
   - pedestrian routes
   - traffic interaction

5. Housekeeping
   - spills
   - oil
   - water
   - wet surfaces
   - debris
   - clutter
   - blocked access
   - obstructions

SAFETY RULES:

1. If a hard hat is clearly visible, recognise it as PPE.
2. If a safety vest is clearly visible, recognise it as PPE.
3. If a guardrail is visible, do NOT say there is no guardrail.
4. A crane in the background does not automatically mean
   the worker is exposed to a lifting hazard.
5. Only report a spill when a spill is actually visible.
6. Shadows, reflections and stains are not automatically spills.
7. Only report a fall hazard when there is reasonable visual evidence.
8. If uncertain, use CHECK_REQUIRED.
9. Do not invent WSH requirements that cannot be related to
   the visible condition.

RETURN THIS EXACT MACHINE-READABLE FORMAT:

SUMMARY|||short factual description

FINDING|||CATEGORY|||TITLE|||STATUS|||RISK|||CONFIDENCE|||OBSERVATION

CATEGORY must be one of:

PPE
Work at Height
Lifting
Vehicular Safety
Housekeeping
Other

STATUS must be one of:

PASS
CHECK_REQUIRED
FAIL

RISK must be one of:

LOW
MEDIUM
HIGH

CONFIDENCE must be between 0 and 1.

Example:

SUMMARY|||Worker in a container handling area with guardrails and lifting equipment visible.

FINDING|||PPE|||Hard hat and safety vest visible|||PASS|||LOW|||0.95|||Worker is visibly wearing a hard hat and high visibility clothing.

FINDING|||Work at Height|||Guardrail requires verification|||CHECK_REQUIRED|||MEDIUM|||Guardrail is visible around the work area. Verify that it is complete and secure.

FINDING|||Lifting|||Lifting activity requires verification|||CHECK_REQUIRED|||MEDIUM|||Lifting equipment is visible in the background. Verify that workers are not exposed to suspended loads.

Do not return JSON.
Do not return markdown.
Do not explain the answer.
Only return SUMMARY and FINDING lines.
`;

}


/*
 * ============================================================
 * PARSE EXACT FORMAT
 * ============================================================
 */


function parseExact(
  raw: string
): {
  summary: string;
  findings: ParsedFinding[];
} | null {

  const lines =
    raw
      .split(/\r?\n/)
      .map(x => x.trim())
      .filter(Boolean);


  let summary =
    "";


  const summaryLine =
    lines.find(
      x =>
        /^SUMMARY\|\|\|/i.test(x)
    );


  if (
    summaryLine
  ) {

    summary =
      text(
        summaryLine
          .split("|||")
          .slice(1)
          .join("|||"),
        600
      );

  }


  const findings:
    ParsedFinding[] = [];


  for (
    const line of lines
  ) {

    if (
      !/^FINDING\|\|\|/i.test(line)
    ) {

      continue;

    }


    const parts =
      line.split("|||");


    if (
      parts.length < 7
    ) {

      continue;

    }


    const category =
      normaliseCategory(
        parts[1],
        parts[2],
        parts.slice(6).join("|||")
      );


    const title =
      text(
        parts[2],
        300
      );


    const status =
      normaliseStatus(
        parts[3]
      );


    const risk =
      normaliseRisk(
        parts[4]
      );


    const confidence =
      normaliseConfidence(
        parts[5]
      );


    const observation =
      text(
        parts
          .slice(6)
          .join("|||"),
        1000
      );


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


  if (
    findings.length === 0
  ) {

    return null;

  }


  return {

    summary:
      summary ||
      "Workplace scene analysed.",

    findings

  };

}


/*
 * ============================================================
 * PARSE MARKDOWN / NATURAL LANGUAGE FALLBACK
 * ============================================================
 *
 * This handles the response your model previously returned:
 *
 * **Summary** Worker...
 *
 * **PPE**:
 * Category: PPE
 * Title: ...
 * Status: PASS
 * Risk: LOW
 * Confidence: 0.95
 *
 * ============================================================
 */


function parseFallback(
  raw: string
): {
  summary: string;
  findings: ParsedFinding[];
} | null {

  const clean =
    raw
      .replace(/\*\*/g, "")
      .replace(/__/g, "")
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();


  if (
    !clean
  ) {

    return null;

  }


  let summary =
    "Workplace scene analysed.";


  const summaryMatch =
    clean.match(
      /Summary\s+(.+?)(?=\s+(?:Finding\s+)?(?:PPE|Work at Height|Lifting|Vehicular Safety|Housekeeping)\s*:)/i
    );


  if (
    summaryMatch
  ) {

    summary =
      text(
        summaryMatch[1],
        600
      );

  }


  /*
   * Find category blocks.
   */

  const categoryRegex =
    /(?:Finding\s+)?(PPE|Work at Height|Lifting|Vehicular Safety|Housekeeping)\s*:/gi;


  const matches =
    [...clean.matchAll(categoryRegex)];


  if (
    matches.length === 0
  ) {

    return null;

  }


  const findings:
    ParsedFinding[] = [];


  for (
    let i = 0;
    i < matches.length &&
    findings.length < 6;
    i++
  ) {

    const match =
      matches[i];


    const category =
      normaliseCategory(
        match[1]
      );


    const start =
      (
        match.index || 0
      ) +
      match[0].length;


    const end =
      i + 1 <
      matches.length
        ? (
            matches[i + 1].index ||
            clean.length
          )
        : clean.length;


    const block =
      clean
        .slice(
          start,
          end
        )
        .trim();


    const titleMatch =
      block.match(
        /Title\s*:\s*(.*?)(?=\s*\+\s*Status:|\s+Status:|\s*$)/i
      );


    const statusMatch =
      block.match(
        /Status\s*:\s*(PASS|FAIL|CHECK_REQUIRED)/i
      );


    const riskMatch =
      block.match(
        /Risk\s*:\s*(LOW|MEDIUM|HIGH)/i
      );


    const confidenceMatch =
      block.match(
        /Confidence\s*:\s*([0-9.]+)/i
      );


    const categoryMatch =
      block.match(
        /Category\s*:\s*([^+]+?)(?=\s*\+\s*Title:|\s+Title:|\s*$)/i
      );


    const title =
      text(
        titleMatch?.[1] ||
        block.split("+")[0],
        300
      );


    let observation =
      text(
        block
          .split(
            "+ Category:"
          )[0]
          .split(
            "Category:"
          )[0],
        1000
      );


    if (
      !observation
    ) {

      observation =
        title;

    }


    let status =
      normaliseStatus(
        statusMatch?.[1] ||
        "CHECK_REQUIRED"
      );


    const risk =
      normaliseRisk(
        riskMatch?.[1] ||
        "MEDIUM"
      );


    const confidence =
      normaliseConfidence(
        confidenceMatch?.[1] ||
        0.5
      );


    const combined =
      `${title} ${observation}`
        .toLowerCase();


    /*
     * Safety correction.
     */

    if (
      (
        combined.includes(
          "requires verification"
        ) ||
        combined.includes(
          "verify"
        ) ||
        combined.includes(
          "uncertain"
        ) ||
        combined.includes(
          "not clear"
        )
      ) &&
      status === "PASS"
    ) {

      status =
        "CHECK_REQUIRED";

    }


    /*
     * A clearly visible vest should not become
     * a missing-vest failure.
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
          "high visibility"
        ) ||
        combined.includes(
          "high-visibility"
        )
      )
    ) {

      status =
        "PASS";

    }


    /*
     * A visible guardrail should not become
     * "no guardrail".
     */

    if (
      category === "Work at Height" &&
      combined.includes(
        "guardrail"
      ) &&
      !combined.includes(
        "missing"
      ) &&
      !combined.includes(
        "no visible"
      ) &&
      status === "FAIL"
    ) {

      status =
        "CHECK_REQUIRED";

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

  }


  return {

    summary,

    findings

  };

}


/*
 * ============================================================
 * PARSE AI RESPONSE
 * ============================================================
 */


function parseAiResponse(
  raw: string
): {
  summary: string;
  findings: ParsedFinding[];
} {

  /*
   * First try the exact format.
   */

  const exact =
    parseExact(
      raw
    );


  if (
    exact
  ) {

    return exact;

  }


  /*
   * Then handle the natural language format.
   */

  const fallback =
    parseFallback(
      raw
    );


  if (
    fallback
  ) {

    return fallback;

  }


  /*
   * Last resort.
   */

  return {

    summary:
      "The AI returned an unstructured observation.",

    findings: [

      {

        category:
          "Other",

        title:
          "AI analysis requires review",

        observation:
          text(
            raw,
            1000
          ),

        status:
          "CHECK_REQUIRED",

        risk_level:
          "MEDIUM",

        confidence:
          0.5

      }

    ]

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


  return (
    result.results ||
    []
  );

}


/*
 * ============================================================
 * MATCH FINDING TO SAFETY CHECK
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
   * 1. Exact category match.
   */

  const categoryMatches =
    checks.filter(
      check =>
        check.category
          .toLowerCase()
          === category
    );


  if (
    categoryMatches.length === 1
  ) {

    return categoryMatches[0];

  }


  /*
   * 2. Keyword matching.
   */

  const searchText =
    `${finding.title} ${finding.observation}`
      .toLowerCase();


  let best:
    SafetyCheck | null =
      null;


  let bestScore =
    0;


  for (
    const check of
      categoryMatches.length > 0
        ? categoryMatches
        : checks
  ) {

    const keywords =
      String(
        check.keywords ||
        ""
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


    for (
      const keyword of
        keywords
    ) {

      if (
        searchText.includes(
          keyword
        )
      ) {

        score +=
          2;

      }

    }


    /*
     * Category gets a strong weighting.
     */

    if (
      check.category
        .toLowerCase()
        === category
    ) {

      score +=
        5;

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


  if (
    best
  ) {

    return best;

  }


  /*
   * 3. Category fallback.
   */

  if (
    categoryMatches.length > 0
  ) {

    return categoryMatches[0];

  }


  return null;

}


/*
 * ============================================================
 * ATTACH WSH CHECKS
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
 * OVERALL STATUS
 * ============================================================
 */


function calculateOverall(
  findings: ParsedFinding[]
): "PASS" | "CHECK_REQUIRED" | "ATTENTION" {

  if (
    findings.some(
      x =>
        x.status === "FAIL"
    )
  ) {

    return "ATTENTION";

  }


  if (
    findings.some(
      x =>
        x.status === "CHECK_REQUIRED"
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
): Promise<{
  inspectionId: string;
  inspectionNo: string;
  photoId: string;
}> {

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
   * 1. INSPECTION
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
   * 2. SAVE PHOTO TO R2
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
   * 3. PHOTO RECORD
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

      photo.type ||
        "image/jpeg",

      createdAt

    )
    .run();


  /*
   * ----------------------------------------------------------
   * 4. FINDINGS
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

        finding.check_id ||
          null,

        finding.source_title ||
          null,

        finding.source_url ||
          null,

        createdAt

      )
      .run();


    /*
     * --------------------------------------------------------
     * 5. CORRECTIVE ACTION
     * --------------------------------------------------------
     *
     * Automatically create an OPEN action only for FAIL.
     *
     * CHECK_REQUIRED is left for the inspector to verify.
     * --------------------------------------------------------
     */

    if (
      finding.status ===
      "FAIL"
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
 * POST /api/analyze
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
     * Convert photo for Vision model.
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

    const aiResult =
      await env.AI.run(
        MODEL,
        {
          messages: [

            {
              role:
                "system",

              content:
                "You are a careful Singapore workplace safety inspection assistant. Analyse only visible evidence."
            },

            {
              role:
                "user",

              content:
                buildPrompt()
            }

          ],

          image,

          temperature:
            0.05,

          max_tokens:
            1400

        } as any
      );


    const raw =
      extractAiText(
        aiResult
      );


    console.log(
      "AI raw response:",
      raw
    );


    if (
      !raw
    ) {

      throw new Error(
        "Workers AI returned an empty response."
      );

    }


    /*
     * --------------------------------------------------------
     * Parse
     * --------------------------------------------------------
     */

    const parsed =
      parseAiResponse(
        raw
      );


    /*
     * --------------------------------------------------------
     * Match against safety_checks D1 table
     * --------------------------------------------------------
     */

    const safetyChecks =
      await loadSafetyChecks(
        env
      );


    const findings =
      attachSafetyChecks(
        parsed.findings,
        safetyChecks
      );


    /*
     * --------------------------------------------------------
     * Overall result
     * --------------------------------------------------------
     */

    const overall =
      calculateOverall(
        findings
      );


    /*
     * --------------------------------------------------------
     * Save
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
     * Return
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
 * GET /api/inspections
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
 * GET /api/inspections/:id
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
        findingsResult.results ||
        [],

      photos:
        photosResult.results ||
        [],

      corrective_actions:
        actionsResult.results ||
        []

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
 * FETCH HANDLER
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
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status:
            204,

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
     * ANALYSE
     * --------------------------------------------------------
     */

    if (
      url.pathname ===
      "/api/analyze"
    ) {

      if (
        request.method !==
        "POST"
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
        request.method !==
        "GET"
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

    const prefix =
      "/api/inspections/";


    if (
      url.pathname.startsWith(
        prefix
      )
    ) {

      const id =
        decodeURIComponent(
          url.pathname.slice(
            prefix.length
          )
        );


      if (
        id
      ) {

        return getInspection(
          env,
          id
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
        status:
          200,

        headers: {
          "Content-Type":
            "text/plain"
        }
      }
    );

  }

};
