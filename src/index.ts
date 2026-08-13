interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
}

const VISION_MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";


/* =========================================================
   COMMON RESPONSE
   ========================================================= */

function json(
  data: unknown,
  status = 200
): Response {

  return Response.json(
    data,
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*"
      }
    }
  );

}


/* =========================================================
   ID / TIME
   ========================================================= */

function makeId(
  prefix: string
): string {

  return `${prefix}_${crypto.randomUUID()}`;

}


function now(): string {

  return new Date().toISOString();

}


/* =========================================================
   CATEGORY CORRECTION
   ========================================================= */

function correctCategory(
  category: string,
  title: string,
  observation: string
): string {

  const text = `
    ${category}
    ${title}
    ${observation}
  `.toLowerCase();


  /*
   * PPE
   */

  if (
    /\bhelmet\b/.test(text) ||
    /\bhard hat\b/.test(text) ||
    /\bsafety vest\b/.test(text) ||
    /\bsafety jacket\b/.test(text) ||
    /\bhi-vis\b/.test(text) ||
    /\bhigh visibility\b/.test(text) ||
    /\bhigh-visibility\b/.test(text) ||
    /\bgloves\b/.test(text) ||
    /\bsafety shoes\b/.test(text) ||
    /\bsafety footwear\b/.test(text) ||
    /\bprotective equipment\b/.test(text) ||
    /\bppe\b/.test(text)
  ) {

    return "PPE";

  }


  /*
   * Work at Height
   */

  if (
    /\bguardrail\b/.test(text) ||
    /\bguard rail\b/.test(text) ||
    /\bhandrail\b/.test(text) ||
    /\bfall\b/.test(text) ||
    /\bedge protection\b/.test(text) ||
    /\bopen edge\b/.test(text) ||
    /\bopening\b/.test(text) ||
    /\bplatform\b/.test(text) ||
    /\bscaffold\b/.test(text) ||
    /\bladder\b/.test(text) ||
    /\belevated\b/.test(text) ||
    /\bwork at height\b/.test(text)
  ) {

    return "Work at Height";

  }


  /*
   * Lifting
   */

  if (
    /\bcrane\b/.test(text) ||
    /\bsuspended load\b/.test(text) ||
    /\blifting\b/.test(text) ||
    /\blift\b/.test(text) ||
    /\bsling\b/.test(text) ||
    /\bhook\b/.test(text) ||
    /\bcontainer handling\b/.test(text)
  ) {

    return "Lifting";

  }


  /*
   * Vehicular Safety
   */

  if (
    /\btruck\b/.test(text) ||
    /\bprime mover\b/.test(text) ||
    /\bforklift\b/.test(text) ||
    /\bvehicle\b/.test(text) ||
    /\bvehicles\b/.test(text) ||
    /\bpedestrian\b/.test(text) ||
    /\btraffic\b/.test(text) ||
    /\bdriveway\b/.test(text) ||
    /\broad\b/.test(text)
  ) {

    return "Vehicular Safety";

  }


  /*
   * Housekeeping
   */

  if (
    /\bspill\b/.test(text) ||
    /\bspillage\b/.test(text) ||
    /\boil\b/.test(text) ||
    /\bwet floor\b/.test(text) ||
    /\bslippery\b/.test(text) ||
    /\bdebris\b/.test(text) ||
    /\bclutter\b/.test(text) ||
    /\bobstruction\b/.test(text) ||
    /\bhousekeeping\b/.test(text)
  ) {

    return "Housekeeping";

  }


  /*
   * Keep a valid supplied category.
   */

  if (
    [
      "Vehicular Safety",
      "Housekeeping",
      "PPE",
      "Work at Height",
      "Lifting",
      "Other"
    ].includes(category)
  ) {

    return category;

  }


  return "Other";

}


/* =========================================================
   STATUS CORRECTION
   ========================================================= */

function normaliseStatus(
  title: string,
  observation: string,
  status: string
): string {

  const combined =
    `
      ${title}
      ${observation}
    `
      .toLowerCase();


  let result =
    status.toUpperCase();


  /*
   * Valid statuses only.
   */

  if (
    ![
      "PASS",
      "CHECK_REQUIRED",
      "FAIL"
    ].includes(result)
  ) {

    result =
      "CHECK_REQUIRED";

  }


  /*
   * A possible hazard should not be PASS.
   */

  const hazardWords = [
    "hazard",
    "spill",
    "spillage",
    "oil",
    "wet floor",
    "slippery",
    "unsafe",
    "fall hazard",
    "suspended load",
    "obstruction",
    "blocked",
    "missing",
    "inadequate",
    "potential risk",
    "potential hazard"
  ];


  const possibleHazard =
    hazardWords.some(
      word =>
        combined.includes(word)
    );


  if (
    possibleHazard &&
    result === "PASS"
  ) {

    result =
      "CHECK_REQUIRED";

  }


  /*
   * Do not automatically treat an absence
   * statement as a definite FAIL.
   */

  const uncertainAbsence =
    combined.includes(
      "no visible"
    ) ||
    combined.includes(
      "not visible"
    ) ||
    combined.includes(
      "cannot see"
    ) ||
    combined.includes(
      "not wearing"
    ) ||
    combined.includes(
      "missing"
    );


  if (
    uncertainAbsence &&
    result === "FAIL"
  ) {

    result =
      "CHECK_REQUIRED";

  }


  return result;

}


/* =========================================================
   RISK CORRECTION
   ========================================================= */

function normaliseRisk(
  risk: string,
  status: string
): string {

  let result =
    risk.toUpperCase();


  if (
    ![
      "LOW",
      "MEDIUM",
      "HIGH"
    ].includes(result)
  ) {

    result =
      "MEDIUM";

  }


  /*
   * PASS + HIGH is inconsistent.
   */

  if (
    status === "PASS" &&
    result === "HIGH"
  ) {

    result =
      "LOW";

  }


  return result;

}


/* =========================================================
   VISION AI ANALYSIS
   ========================================================= */

async function analyzeImage(
  env: Env,
  imageDataUrl: string
): Promise<any> {

  const prompt = `
You are a workplace safety inspection AI for Singapore
container terminals, depots, warehouses and industrial
workplaces.

Analyse the supplied photograph carefully.

Your job is to ASSIST a safety inspector.

Do NOT make a final legal or compliance decision.

==================================================
IMPORTANT VISUAL RULES
==================================================

Only report things that can actually be supported
by the photograph.

Do NOT invent hazards.

Do NOT say something is missing simply because it
is partly hidden, outside the frame, blocked or
difficult to see.

If PPE is visible, recognise it.

If a guardrail is visible, recognise it.

If a crane is visible, do not automatically assume
the worker is exposed to a lifting operation.

If a spill is not clearly visible, do not report one.

Shadows, stains, reflections and normal floor
colour are NOT automatically spills.

When the photograph does not provide enough evidence,
use CHECK_REQUIRED.

==================================================
PPE
==================================================

Look for:

- hard hat
- safety helmet
- high visibility vest
- high visibility jacket
- safety clothing
- gloves
- safety footwear
- other PPE

If a safety vest is visible:

DO NOT say:

"No visible safety vest"

Instead state:

"High-visibility safety vest is visible."

The photograph may not establish whether the PPE
is appropriate for the specific task. In that case
use CHECK_REQUIRED.

==================================================
WORK AT HEIGHT
==================================================

Look for:

- guardrails
- handrails
- open edges
- openings
- platforms
- ladders
- scaffolding
- elevated work areas
- fall exposure

If a guardrail is visible:

DO NOT say:

"No visible guardrail"

Instead state:

"Guardrail is visible. Verify that it is complete,
secure and suitable for fall prevention."

==================================================
LIFTING
==================================================

Look for:

- cranes
- lifting equipment
- hooks
- slings
- suspended loads
- container handling

A crane in the background does NOT automatically
mean the worker is exposed to lifting.

Use CHECK_REQUIRED when the relationship between
the worker and lifting operation cannot be determined.

==================================================
VEHICULAR SAFETY
==================================================

Look for:

- trucks
- prime movers
- forklifts
- vehicles
- pedestrians
- traffic routes
- pedestrian segregation
- vehicle interaction

==================================================
HOUSEKEEPING
==================================================

Look for:

- spills
- oil
- wet surfaces
- debris
- clutter
- obstruction
- blocked access

Only report a spill when it is clearly visible.

==================================================
STATUS
==================================================

PASS:

The visible condition appears acceptable.

CHECK_REQUIRED:

The photograph indicates a condition that requires
physical/site verification.

FAIL:

Use only when a clearly visible potentially unsafe
condition is strongly supported by the photograph.

When uncertain, use CHECK_REQUIRED.

==================================================
OUTPUT FORMAT
==================================================

DO NOT RETURN JSON.

DO NOT USE MARKDOWN.

DO NOT USE BULLET POINTS.

DO NOT EXPLAIN YOUR ANSWER.

Return ONLY lines using this exact format:

SUMMARY|||short factual description of the scene

FINDING|||CATEGORY|||TITLE|||STATUS|||RISK|||CONFIDENCE|||OBSERVATION

Allowed CATEGORY:

PPE
Work at Height
Lifting
Vehicular Safety
Housekeeping
Other

Allowed STATUS:

PASS
CHECK_REQUIRED
FAIL

Allowed RISK:

LOW
MEDIUM
HIGH

CONFIDENCE must be a number between 0 and 1.

Maximum 6 findings.

Each observation should be concise.

==================================================
EXAMPLE
==================================================

SUMMARY|||Worker in a container handling area with guardrails and lifting equipment visible.

FINDING|||PPE|||Hard hat and safety vest visible|||PASS|||LOW|||0.95|||Worker is visibly wearing a hard hat and high-visibility clothing.

FINDING|||Work at Height|||Guardrail requires verification|||CHECK_REQUIRED|||MEDIUM|||0.85|||Guardrail is visible around the work area. Verify that it is complete, secure and suitable for fall prevention.

FINDING|||Lifting|||Lifting activity requires verification|||CHECK_REQUIRED|||MEDIUM|||0.75|||Lifting equipment is visible in the background. Verify that workers are not exposed to suspended loads or lifting operations.

RETURN ONLY THE SUMMARY AND FINDING LINES.
NO JSON.
NO MARKDOWN.
NO EXTRA TEXT.
`;


  try {

    /*
     * IMPORTANT:
     *
     * We intentionally do NOT use response_format.
     *
     * The model previously returned:
     *
     * "The image shows..."
     *
     * even when JSON mode was requested.
     *
     * Therefore this version uses a simple
     * delimiter-based response instead.
     */

    const response: any =
      await env.AI.run(
        VISION_MODEL,
        {
          prompt,
          image: imageDataUrl,

          temperature: 0.05,

          max_tokens: 1200
        }
      );


    console.log(
      "Workers AI response:",
      JSON.stringify(response)
    );


    const raw =
      response?.response ??
      response?.result ??
      "";


    if (!raw) {

      throw new Error(
        "Workers AI returned an empty response."
      );

    }


    const text =
      String(raw)
        .trim();


    console.log(
      "Workers AI text:",
      text
    );


    /*
     * =====================================================
     * SUMMARY
     * =====================================================
     */

    let sceneSummary =
      "Workplace scene analysed.";


    const summaryMatch =
      text.match(
        /SUMMARY\|\|\|([^\r\n]*)/i
      );


    if (
      summaryMatch &&
      summaryMatch[1]
    ) {

      sceneSummary =
        summaryMatch[1]
          .trim()
          .slice(
            0,
            500
          );

    }


    /*
     * =====================================================
     * FINDINGS
     * =====================================================
     */

    const observations:
      any[] = [];


    const lines =
      text
        .split(/\r?\n/)
        .map(
          line =>
            line.trim()
        )
        .filter(Boolean);


    for (
      const line of lines
    ) {

      if (
        !/^FINDING\|\|\|/i.test(
          line
        )
      ) {

        continue;

      }


      const parts =
        line.split(
          "|||"
        );


      /*
       * Expected:
       *
       * 0 = FINDING
       * 1 = CATEGORY
       * 2 = TITLE
       * 3 = STATUS
       * 4 = RISK
       * 5 = CONFIDENCE
       * 6 = OBSERVATION
       */

      if (
        parts.length < 7
      ) {

        console.warn(
          "Invalid FINDING line:",
          line
        );

        continue;

      }


      let category =
        parts[1]
          .trim();


      let title =
        parts[2]
          .trim();


      let status =
        parts[3]
          .trim()
          .toUpperCase();


      let risk =
        parts[4]
          .trim()
          .toUpperCase();


      let confidence =
        Number(
          parts[5]
            .trim()
        );


      let observation =
        parts
          .slice(6)
          .join("|||")
          .trim();


      /*
       * Correct category.
       */

      category =
        correctCategory(
          category,
          title,
          observation
        );


      /*
       * Correct status.
       */

      status =
        normaliseStatus(
          title,
          observation,
          status
        );


      /*
       * Correct risk.
       */

      risk =
        normaliseRisk(
          risk,
          status
        );


      /*
       * Correct confidence.
       */

      if (
        Number.isNaN(
          confidence
        )
      ) {

        confidence =
          0.5;

      }


      confidence =
        Math.max(
          0,
          Math.min(
            1,
            confidence
          )
        );


      /*
       * ===================================================
       * SPECIAL PPE PROTECTION
       * ===================================================
       */

      const lowerText =
        `
          ${title}
          ${observation}
        `
          .toLowerCase();


      if (
        lowerText.includes(
          "no visible safety vest"
        ) ||
        lowerText.includes(
          "no visible vest"
        )
      ) {

        category =
          "PPE";

        title =
          "PPE requires verification";

        observation =
          "The photograph does not provide sufficient evidence to confirm whether all task-required PPE is provided and worn.";

        status =
          "CHECK_REQUIRED";

        risk =
          "MEDIUM";

      }


      /*
       * ===================================================
       * SPECIAL GUARDRAIL PROTECTION
       * ===================================================
       */

      if (
        lowerText.includes(
          "no visible guardrail"
        ) ||
        lowerText.includes(
          "no guardrail"
        )
      ) {

        category =
          "Work at Height";

        title =
          "Edge protection requires verification";

        observation =
          "Verify that suitable guardrails or other fall-prevention measures are provided and properly secured at the work area.";

        status =
          "CHECK_REQUIRED";

        risk =
          "MEDIUM";

      }


      /*
       * ===================================================
       * LIMIT TEXT
       * ===================================================
       */

      title =
        title.slice(
          0,
          200
        );


      observation =
        observation.slice(
          0,
          500
        );


      /*
       * ===================================================
       * ADD
       * ===================================================
       */

      observations.push({

        category,

        title,

        observation,

        risk_level:
          risk,

        confidence,

        status

      });


      if (
        observations.length >= 6
      ) {

        break;

      }

    }


    /*
     * =====================================================
     * FALLBACK
     * =====================================================
     *
     * If the model completely ignores the requested
     * format, do not crash.
     */

    if (
      observations.length === 0
    ) {

      console.warn(
        "Vision model did not return FINDING lines."
      );


      const cleanText =
        text
          .replace(
            /```/g,
            ""
          )
          .trim();


      observations.push({

        category:
          "Other",

        title:
          "AI analysis requires review",

        observation:
          cleanText.slice(
            0,
            800
          ),

        risk_level:
          "MEDIUM",

        confidence:
          0.5,

        status:
          "CHECK_REQUIRED"

      });

    }


    /*
     * =====================================================
     * REMOVE DUPLICATES
     * ===================================================== */

    const seen =
      new Set<string>();


    const uniqueObservations =
      observations.filter(
        item => {

          const key =
            `${item.category}|${item.title}`
              .toLowerCase();


          if (
            seen.has(key)
          ) {

            return false;

          }


          seen.add(key);

          return true;

        }
      );


    /*
     * =====================================================
     * RETURN
     * ===================================================== */

    return {

      scene_summary:
        sceneSummary,

      observations:
        uniqueObservations

    };


  } catch (
    error: any
  ) {

    console.error(
      "Workers AI analysis failed:",
      error
    );


    throw new Error(
      `AI analysis failed: ${
        error?.message ||
        String(error)
      }`
    );

  }

}


/* =========================================================
   FIND RELEVANT WSH CHECKS
   ========================================================= */

async function findRelevantChecks(
  env: Env,
  observations: any[]
): Promise<any[]> {

  const categories =
    [
      ...new Set(
        observations
          .map(
            item =>
              String(
                item?.category ||
                ""
              )
          )
          .filter(Boolean)
      )
    ];


  if (
    categories.length === 0
  ) {

    return [];

  }


  const placeholders =
    categories
      .map(
        () => "?"
      )
      .join(",");


  const result =
    await env.SAFETY_DB
      .prepare(
        `
        SELECT *
        FROM safety_checks
        WHERE active = 1
        AND category IN (${placeholders})
        ORDER BY category, id
        `
      )
      .bind(
        ...categories
      )
      .all();


  return result.results || [];

}


/* =========================================================
   MATCH AI FINDINGS TO WSH CHECKS
   ========================================================= */

function enrichFindings(
  observations: any[],
  checks: any[]
): any[] {

  return observations.map(
    observation => {

      const candidates =
        checks.filter(
          check =>
            check.category ===
            observation.category
        );


      const searchText =
        `
          ${observation.title}
          ${observation.observation}
        `
          .toLowerCase();


      let selectedCheck:
        any = null;


      let bestScore =
        0;


      /*
       * Keyword matching.
       */

      for (
        const check of candidates
      ) {

        const keywords =
          String(
            check.keywords ||
            ""
          )
            .split(",")
            .map(
              (keyword: string) =>
                keyword
                  .trim()
                  .toLowerCase()
            )
            .filter(Boolean);


        let score =
          0;


        for (
          const keyword of keywords
        ) {

          if (
            searchText.includes(
              keyword
            )
          ) {

            score++;

          }

        }


        if (
          score > bestScore
        ) {

          bestScore =
            score;

          selectedCheck =
            check;

        }

      }


      /*
       * If no keyword match,
       * use first check in category.
       */

      if (
        !selectedCheck &&
        candidates.length > 0
      ) {

        selectedCheck =
          candidates[0];

      }


      return {

        ...observation,

        check_id:
          selectedCheck?.id ||
          null,

        check_question:
          selectedCheck?.check_question ||
          null,

        guidance:
          selectedCheck?.guidance ||
          null,

        source_title:
          selectedCheck?.source_title ||
          null,

        source_url:
          selectedCheck?.source_url ||
          null

      };

    }
  );

}


/* =========================================================
   SAVE FINDINGS
   ========================================================= */

async function saveFindings(
  env: Env,
  inspectionId: string,
  photoId: string,
  findings: any[]
): Promise<void> {

  for (
    const finding of findings
  ) {

    await env.SAFETY_DB
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

        makeId(
          "find"
        ),

        inspectionId,

        photoId,

        finding.category ||
          "Other",

        finding.title ||
          "Safety observation",

        finding.observation ||
          "",

        finding.status ||
          "CHECK_REQUIRED",

        finding.risk_level ||
          "MEDIUM",

        Number(
          finding.confidence ||
          0.5
        ),

        finding.check_id ||
          null,

        finding.source_title ||
          null,

        finding.source_url ||
          null,

        now()

      )
      .run();

  }

}


/* =========================================================
   DETERMINE OVERALL RESULT
   ========================================================= */

function determineOverallResult(
  findings: any[]
): string {

  const hasHighFail =
    findings.some(
      finding =>
        finding.status ===
          "FAIL" &&
        finding.risk_level ===
          "HIGH"
    );


  const hasFail =
    findings.some(
      finding =>
        finding.status ===
        "FAIL"
    );


  const hasCheckRequired =
    findings.some(
      finding =>
        finding.status ===
        "CHECK_REQUIRED"
    );


  if (
    hasHighFail ||
    hasFail
  ) {

    return "ATTENTION";

  }


  if (
    hasCheckRequired
  ) {

    return "CHECK_REQUIRED";

  }


  return "PASS";

}


/* =========================================================
   MAIN WORKER
   ========================================================= */

export default {

  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {

    /*
     * =====================================================
     * CORS PREFLIGHT
     * =====================================================
     */

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

            "Access-Control-Allow-Headers":
              "Content-Type, Authorization",

            "Access-Control-Allow-Methods":
              "GET, POST, OPTIONS"
          }
        }
      );

    }


    const url =
      new URL(
        request.url
      );


    try {

      /* ===================================================
         HEALTH CHECK
         =================================================== */

      if (
        url.pathname ===
          "/api/health" &&
        request.method ===
          "GET"
      ) {

        return json({

          ok: true,

          service:
            "safety-inspection-ai",

          ai_model:
            VISION_MODEL,

          vectorize:
            false

        });

      }


      /* ===================================================
         SAFETY CHECKS
         =================================================== */

      if (
        url.pathname ===
          "/api/checks" &&
        request.method ===
          "GET"
      ) {

        const result =
          await env.SAFETY_DB
            .prepare(
              `
              SELECT *
              FROM safety_checks
              WHERE active = 1
              ORDER BY category, id
              `
            )
            .all();


        return json({

          checks:
            result.results ||
            []

        });

      }


      /* ===================================================
         RECENT INSPECTIONS
         =================================================== */

      if (
        url.pathname ===
          "/api/inspections" &&
        request.method ===
          "GET"
      ) {

        const result =
          await env.SAFETY_DB
            .prepare(
              `
              SELECT
                i.*,
                COUNT(f.id) AS finding_count
              FROM inspections i
              LEFT JOIN findings f
                ON f.inspection_id =
                   i.id
              GROUP BY i.id
              ORDER BY i.created_at DESC
              LIMIT 100
              `
            )
            .all();


        return json({

          inspections:
            result.results ||
            []

        });

      }


      /* ===================================================
         ANALYSE PHOTO
         =================================================== */

      if (
        url.pathname ===
          "/api/analyze" &&
        request.method ===
          "POST"
      ) {

        const form =
          await request.formData();


        const file =
          form.get(
            "photo"
          );


        const location =
          String(
            form.get(
              "location"
            ) ||
            "Unspecified"
          );


        const inspector =
          String(
            form.get(
              "inspector"
            ) ||
            "Inspector"
          );


        /* -----------------------------------------------
           Validate photo
           ----------------------------------------------- */

        if (
          !(file instanceof File)
        ) {

          return json(
            {
              error:
                "Photo is required."
            },
            400
          );

        }


        if (
          !file.type.startsWith(
            "image/"
          )
        ) {

          return json(
            {
              error:
                "Only image files are supported."
            },
            400
          );

        }


        if (
          file.size >
          8 * 1024 * 1024
        ) {

          return json(
            {
              error:
                "Maximum photo size is 8 MB."
            },
            400
          );

        }


        /* -----------------------------------------------
           Create IDs
           ----------------------------------------------- */

        const inspectionId =
          makeId(
            "insp"
          );


        const inspectionNo =
          `SI-${new Date()
            .toISOString()
            .slice(
              0,
              10
            )
            .replaceAll(
              "-",
              ""
            )}-${crypto
            .randomUUID()
            .slice(
              0,
              6
            )
            .toUpperCase()}`;


        const photoId =
          makeId(
            "photo"
          );


        /* -----------------------------------------------
           R2 object key
           ----------------------------------------------- */

        const safeFileName =
          file.name.replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          );


        const objectKey =
          `${new Date()
            .toISOString()
            .slice(
              0,
              10
            )}/${inspectionId}/${photoId}-${safeFileName}`;


        /* -----------------------------------------------
           Store image in R2
           ----------------------------------------------- */

        await env.PHOTOS.put(
          objectKey,
          file.stream(),
          {
            httpMetadata: {
              contentType:
                file.type
            }
          }
        );


        /* -----------------------------------------------
           Create inspection
           ----------------------------------------------- */

        await env.SAFETY_DB
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
            inspectionId,
            inspectionNo,
            location,
            inspector,
            now(),
            "CHECK_REQUIRED"
          )
          .run();


        /* -----------------------------------------------
           Store photo record
           ----------------------------------------------- */

        await env.SAFETY_DB
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
            file.name,
            file.type,
            now()
          )
          .run();


        /* -----------------------------------------------
           Convert image to data URL
           ----------------------------------------------- */

        const bytes =
          new Uint8Array(
            await file.arrayBuffer()
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

          binary +=
            String.fromCharCode(
              ...bytes.subarray(
                i,
                i + chunkSize
              )
            );

        }


        const imageDataUrl =
          `data:${file.type};base64,${btoa(
            binary
          )}`;


        /* -----------------------------------------------
           Run Vision AI
           ----------------------------------------------- */

        let aiResult: any;


        try {

          aiResult =
            await analyzeImage(
              env,
              imageDataUrl
            );

        } catch (
          aiError: any
        ) {

          console.error(
            "AI ERROR:",
            aiError
          );


          return json(
            {

              error:
                "AI analysis failed.",

              detail:
                aiError?.message ||
                String(aiError),

              inspection_id:
                inspectionId,

              inspection_no:
                inspectionNo

            },
            500
          );

        }


        /* -----------------------------------------------
           Find relevant WSH checks
           ----------------------------------------------- */

        const checks =
          await findRelevantChecks(
            env,
            aiResult.observations ||
              []
          );


        /* -----------------------------------------------
           Match findings to WSH checks
           ----------------------------------------------- */

        const findings =
          enrichFindings(
            aiResult.observations ||
              [],
            checks
          );


        /* -----------------------------------------------
           Overall result
           ----------------------------------------------- */

        const overall =
          determineOverallResult(
            findings
          );


        /* -----------------------------------------------
           Update inspection
           ----------------------------------------------- */

        await env.SAFETY_DB
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


        /* -----------------------------------------------
           Save findings
           ----------------------------------------------- */

        await saveFindings(
          env,
          inspectionId,
          photoId,
          findings
        );


        /* -----------------------------------------------
           Return result
           ----------------------------------------------- */

        return json({

          inspection_id:
            inspectionId,

          inspection_no:
            inspectionNo,

          location,

          inspector,

          overall_result:
            overall,

          scene_summary:
            aiResult.scene_summary ||
            "",

          findings

        });

      }


      /* ===================================================
         SINGLE INSPECTION
         =================================================== */

      if (
        url.pathname.startsWith(
          "/api/inspections/"
        ) &&
        request.method ===
          "GET"
      ) {

        const inspectionId =
          url.pathname
            .split("/")
            .pop();


        if (
          !inspectionId
        ) {

          return json(
            {
              error:
                "Inspection ID is required."
            },
            400
          );

        }


        const inspection =
          await env.SAFETY_DB
            .prepare(
              `
              SELECT *
              FROM inspections
              WHERE id = ?
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


        const result =
          await env.SAFETY_DB
            .prepare(
              `
              SELECT *
              FROM findings
              WHERE inspection_id = ?
              ORDER BY created_at
              `
            )
            .bind(
              inspectionId
            )
            .all();


        return json({

          inspection,

          findings:
            result.results ||
            []

        });

      }


      /* ===================================================
         STATIC WEBSITE
         =================================================== */

      return env.ASSETS.fetch(
        request
      );


    } catch (
      error: any
    ) {

      console.error(
        "WORKER ERROR:",
        error
      );


      return json(
        {

          error:
            "Server error",

          detail:
            error?.message ||
            String(error)

        },
        500
      );

    }

  }

};
