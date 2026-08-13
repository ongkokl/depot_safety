interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
  ASSETS: Fetcher;
}

const VISION_MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";

const json = (
  data: unknown,
  status = 200
): Response => {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
};

function makeId(prefix: string): string {
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
   * PPE takes priority when the observation
   * is clearly about PPE.
   */

  if (
    /\bhelmet\b/.test(text) ||
    /\bhard hat\b/.test(text) ||
    /\bsafety vest\b/.test(text) ||
    /\bhi-vis\b/.test(text) ||
    /\bhigh visibility\b/.test(text) ||
    /\bhigh-visibility\b/.test(text) ||
    /\bgloves\b/.test(text) ||
    /\bsafety shoes\b/.test(text) ||
    /\bprotective equipment\b/.test(text) ||
    /\bppe\b/.test(text)
  ) {
    return "PPE";
  }


  /*
   * Work at Height.
   */

  if (
    /\bguardrail\b/.test(text) ||
    /\bhandrail\b/.test(text) ||
    /\bfall\b/.test(text) ||
    /\bedge protection\b/.test(text) ||
    /\bopen edge\b/.test(text) ||
    /\bopening\b/.test(text) ||
    /\bplatform\b/.test(text) ||
    /\bscaffold\b/.test(text) ||
    /\bladder\b/.test(text) ||
    /\belevated\b/.test(text) ||
    /\bheight\b/.test(text)
  ) {
    return "Work at Height";
  }


  /*
   * Lifting.
   */

  if (
    /\bcrane\b/.test(text) ||
    /\bsuspended load\b/.test(text) ||
    /\blifting\b/.test(text) ||
    /\bsling\b/.test(text) ||
    /\bhook\b/.test(text) ||
    /\blift\b/.test(text) ||
    /\bcontainer handling\b/.test(text)
  ) {
    return "Lifting";
  }


  /*
   * Vehicular safety.
   */

  if (
    /\btruck\b/.test(text) ||
    /\bprime mover\b/.test(text) ||
    /\bforklift\b/.test(text) ||
    /\bvehicle\b/.test(text) ||
    /\bpedestrian\b/.test(text) ||
    /\btraffic\b/.test(text) ||
    /\bdriveway\b/.test(text) ||
    /\broad\b/.test(text)
  ) {
    return "Vehicular Safety";
  }


  /*
   * Housekeeping.
   */

  if (
    /\bspill\b/.test(text) ||
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


  return [
    "Vehicular Safety",
    "Housekeeping",
    "PPE",
    "Work at Height",
    "Lifting"
  ].includes(category)
    ? category
    : "Other";
}


/* =========================================================
   SAFETY STATUS NORMALISATION
   ========================================================= */

function normaliseStatus(
  item: any
): string {

  const status =
    String(
      item?.status || ""
    ).toUpperCase();

  const observation =
    String(
      item?.observation || ""
    ).toLowerCase();

  const title =
    String(
      item?.title || ""
    ).toLowerCase();

  const combined =
    `${title} ${observation}`;


  /*
   * A visible or suspected hazard should
   * never be reported as PASS.
   */

  const hazardWords = [
    "hazard",
    "risk",
    "spill",
    "unsafe",
    "exposed",
    "fall",
    "suspended load",
    "obstruction",
    "blocked",
    "missing",
    "inadequate",
    "potential"
  ];

  const containsHazard =
    hazardWords.some(
      word =>
        combined.includes(word)
    );


  if (
    containsHazard &&
    status === "PASS"
  ) {
    return "CHECK_REQUIRED";
  }


  /*
   * Statements about absence are uncertain
   * unless the photograph clearly establishes
   * the absence.
   *
   * We deliberately use CHECK_REQUIRED here.
   */

  const absenceClaim =
    /\bno visible\b/.test(combined) ||
    /\bnot visible\b/.test(combined) ||
    /\bcannot see\b/.test(combined) ||
    /\bnot wearing\b/.test(combined) ||
    /\bmissing\b/.test(combined);

  if (
    absenceClaim &&
    status === "FAIL"
  ) {
    return "CHECK_REQUIRED";
  }


  if (
    status === "FAIL" ||
    status === "CHECK_REQUIRED" ||
    status === "PASS"
  ) {
    return status;
  }


  return "CHECK_REQUIRED";
}


/* =========================================================
   RISK NORMALISATION
   ========================================================= */

function normaliseRisk(
  item: any,
  status: string
): string {

  let risk =
    String(
      item?.risk_level || ""
    ).toUpperCase();


  if (
    ![
      "HIGH",
      "MEDIUM",
      "LOW"
    ].includes(risk)
  ) {
    risk = "MEDIUM";
  }


  /*
   * Don't allow PASS + HIGH risk.
   */

  if (
    status === "PASS" &&
    risk === "HIGH"
  ) {
    risk = "LOW";
  }


  return risk;
}


/* =========================================================
   VISION AI
   ========================================================= */

async function analyzeImage(
  env: Env,
  imageDataUrl: string
): Promise<any> {

  const prompt = `
You are a workplace safety inspection AI
for Singapore container terminals, depots,
warehouses and industrial workplaces.

Analyse the supplied workplace photograph.

IMPORTANT:

You must separate:

1. WHAT IS CLEARLY VISIBLE
2. WHAT MAY BE A SAFETY CONCERN
3. WHAT CANNOT BE DETERMINED FROM THE PHOTO

DO NOT make assumptions.

DO NOT invent hazards.

DO NOT infer that something is absent simply
because it is partly hidden, outside the frame,
blocked or difficult to see.

For example:

If a safety vest is visible, do NOT say
"no visible safety vest".

If a guardrail is visible, do NOT say
"no visible guardrail".

If a crane is visible but the worker's relationship
to the lifting operation cannot be established,
use CHECK_REQUIRED.

If a possible spill is not clearly visible,
do NOT report a spill.

If compliance cannot be established from a photograph,
use CHECK_REQUIRED.

The purpose of this system is to ASSIST a safety
inspector, not to make a final legal or compliance
decision.

==================================================
FIRST: VISUAL INVENTORY
==================================================

Look carefully for:

PEOPLE
- number of visible workers
- position of workers
- posture
- activity

PPE
- hard hat
- safety helmet
- high visibility vest
- safety clothing
- gloves
- safety footwear
- other visible PPE

WORK AT HEIGHT
- elevated platforms
- edges
- openings
- guardrails
- handrails
- ladders
- scaffolds
- fall exposure

LIFTING
- cranes
- lifting equipment
- hooks
- slings
- suspended loads
- container handling

VEHICLES
- trucks
- prime movers
- forklifts
- mobile equipment
- pedestrians
- traffic interaction

HOUSEKEEPING
- spills
- oil
- water
- debris
- clutter
- obstructions

==================================================
SECOND: SAFETY ASSESSMENT
==================================================

Only create an observation when:

A. Something potentially unsafe is visibly present,

OR

B. A safety condition needs physical/site verification.

Do not create findings simply because a category
exists.

For every observation, state the visible evidence.

==================================================
VERY IMPORTANT PPE RULE
==================================================

If a helmet, safety vest or other PPE is visible,
state that it is visible.

Do not call it missing.

The photograph alone may not establish whether
the PPE is appropriate for the task.

Therefore:

Visible PPE
=
PASS or CHECK_REQUIRED

Not visible PPE
=
CHECK_REQUIRED

Do NOT automatically use FAIL.

==================================================
VERY IMPORTANT GUARDRAIL RULE
==================================================

If a guardrail is visible:

Do NOT report "no visible guardrail".

Instead say something like:

"Guardrail is visible around the work area.
Verify that it is complete, secure and suitable
for fall prevention."

Use CHECK_REQUIRED if compliance cannot be
established from the image.

==================================================
VERY IMPORTANT SPILL RULE
==================================================

Only report a spill if liquid, oil or another
spilled substance is clearly visible.

Do not interpret shadows, stains, reflections,
dust or ordinary surface colour as a spill.

==================================================
VERY IMPORTANT LIFTING RULE
==================================================

If a crane or lifting equipment is visible:

Do not assume a lifting operation is currently
affecting the worker.

Use CHECK_REQUIRED if the relationship cannot
be determined.

==================================================
STATUS RULES
==================================================

PASS:
The visible condition appears acceptable,
but this does not confirm legal compliance.

CHECK_REQUIRED:
The photo indicates something that requires
physical/site verification.

FAIL:
Use only when a clearly visible unsafe condition
is strongly supported by the photograph.

When uncertain, use CHECK_REQUIRED.

==================================================
OUTPUT
==================================================

Return ONLY valid JSON.

No Markdown.
No code fences.
No explanation outside JSON.

Use exactly this structure:

{
  "scene_summary": "short factual description",
  "observations": [
    {
      "category": "PPE",
      "title": "short title",
      "observation": "visible evidence and what needs checking",
      "risk_level": "LOW",
      "confidence": 0.85,
      "status": "CHECK_REQUIRED"
    }
  ]
}

Allowed category values:

Vehicular Safety
Housekeeping
PPE
Work at Height
Lifting
Other

Allowed risk levels:

HIGH
MEDIUM
LOW

Allowed status:

PASS
CHECK_REQUIRED
FAIL

Maximum 6 observations.

Each observation must be concise.

Do not create an observation for every category.

Only report categories supported by the photograph.
`;


  try {

    const response: any =
      await env.AI.run(
        VISION_MODEL,
        {
          prompt,
          image: imageDataUrl,

          response_format: {
            type: "json_object"
          },

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


    let parsed: any;


    if (
      typeof raw === "object"
    ) {

      parsed = raw;

    } else {

      let text =
        String(raw).trim();


      /*
       * Defensive Markdown cleanup.
       */

      text =
        text
          .replace(
            /^```json\s*/i,
            ""
          )
          .replace(
            /^```\s*/i,
            ""
          )
          .replace(
            /```\s*$/i,
            ""
          )
          .trim();


      parsed =
        JSON.parse(text);

    }


    if (
      !parsed ||
      typeof parsed !== "object"
    ) {

      throw new Error(
        "AI returned invalid JSON."
      );

    }


    if (
      typeof parsed.scene_summary !==
      "string"
    ) {

      parsed.scene_summary =
        "Workplace scene analysed.";

    }


    if (
      !Array.isArray(
        parsed.observations
      )
    ) {

      parsed.observations = [];

    }


    /*
     * Maximum six observations.
     */

    parsed.observations =
      parsed.observations
        .slice(0, 6)
        .map(
          (item: any) => {

            let title =
              String(
                item?.title ||
                "Safety observation"
              ).trim();


            let observation =
              String(
                item?.observation ||
                "Further inspection required."
              ).trim();


            /*
             * Correct category.
             */

            const category =
              correctCategory(
                String(
                  item?.category ||
                  "Other"
                ),
                title,
                observation
              );


            /*
             * Correct status.
             */

            const status =
              normaliseStatus(
                {
                  ...item,
                  title,
                  observation
                }
              );


            /*
             * Correct risk.
             */

            const risk =
              normaliseRisk(
                item,
                status
              );


            /*
             * Confidence.
             */

            let confidence =
              Number(
                item?.confidence
              );


            if (
              Number.isNaN(
                confidence
              )
            ) {

              confidence = 0.5;

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
             * Special correction for
             * obvious absence statements.
             */

            const lower =
              `${title} ${observation}`
                .toLowerCase();


            if (
              (
                lower.includes(
                  "no visible safety vest"
                ) ||
                lower.includes(
                  "no visible vest"
                )
              )
            ) {

              title =
                "PPE requires verification";

              observation =
                "The photograph does not provide sufficient evidence to confirm whether all task-required PPE is provided and worn. Verify PPE requirements on site.";

            }


            if (
              lower.includes(
                "no visible guardrail"
              )
            ) {

              title =
                "Edge protection requires verification";

              observation =
                "Verify that suitable guardrails or other fall-prevention measures are provided and properly secured at the work area.";

            }


            return {

              category,

              title:
                title.slice(
                  0,
                  200
                ),

              observation:
                observation.slice(
                  0,
                  500
                ),

              risk_level:
                risk,

              confidence,

              status

            };

          }
        );


    /*
     * Remove duplicate observations.
     */

    const seen =
      new Set<string>();


    parsed.observations =
      parsed.observations.filter(
        (item: any) => {

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


    return parsed;


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
   FIND WSH CHECKS
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
      .map(() => "?")
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
   MATCH WSH CHECK
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


      /*
       * Keyword matching.
       */

      let bestScore =
        0;


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
       * If nothing matched by keyword,
       * use the first check in that category.
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
   MAIN WORKER
   ========================================================= */

export default {

  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {

    /*
     * CORS.
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

      /* =========================================
         HEALTH
         ========================================= */

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


      /* =========================================
         SAFETY CHECKS
         ========================================= */

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


      /* =========================================
         RECENT INSPECTIONS
         ========================================= */

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


      /* =========================================
         ANALYSE PHOTO
         ========================================= */

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


        /*
         * Validate photo.
         */

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


        /*
         * Create inspection.
         */

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


        /*
         * Store image in R2.
         */

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


        /*
         * Store inspection.
         */

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


        /*
         * Store photo record.
         */

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


        /*
         * Convert image to data URL.
         */

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


        /* =========================================
           AI ANALYSIS
           ========================================= */

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


        /* =========================================
           WSH MATCHING
           ========================================= */

        const checks =
          await findRelevantChecks(
            env,
            aiResult.observations ||
              []
          );


        const findings =
          enrichFindings(
            aiResult.observations ||
              [],
            checks
          );


        /* =========================================
           OVERALL RESULT
           ========================================= */

        let overall =
          "PASS";


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


        const hasCheck =
          findings.some(
            finding =>
              finding.status ===
              "CHECK_REQUIRED"
          );


        if (
          hasHighFail ||
          hasFail
        ) {

          overall =
            "ATTENTION";

        } else if (
          hasCheck
        ) {

          overall =
            "CHECK_REQUIRED";

        } else {

          overall =
            "PASS";

        }


        /*
         * Update inspection.
         */

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


        /* =========================================
           SAVE FINDINGS
           ========================================= */

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


        /* =========================================
           RESPONSE
           ========================================= */

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


      /* =========================================
         SINGLE INSPECTION
         ========================================= */

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


      /*
       * Static website.
       */

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
