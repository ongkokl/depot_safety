interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;

  // Optional. Keep this binding out of wrangler.toml for now.
  // VECTORIZE?: VectorizeIndex;
}

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const json = (data: unknown, status = 200): Response => {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
};

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Analyse a workplace image using Cloudflare Workers AI Vision.
 *
 * The model is instructed to return structured JSON using Cloudflare
 * Workers AI JSON Mode.
 */
async function analyzeImage(
  env: Env,
  imageDataUrl: string
): Promise<any> {

  const safetySchema = {
    type: "object",
    properties: {
      scene_summary: {
        type: "string"
      },

      observations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: [
                "Vehicular Safety",
                "Housekeeping",
                "PPE",
                "Work at Height",
                "Lifting",
                "Other"
              ]
            },

            title: {
              type: "string"
            },

            observation: {
              type: "string"
            },

            risk_level: {
              type: "string",
              enum: [
                "HIGH",
                "MEDIUM",
                "LOW"
              ]
            },

            confidence: {
              type: "number"
            },

            status: {
              type: "string",
              enum: [
                "FAIL",
                "CHECK_REQUIRED",
                "PASS"
              ]
            }
          },

          required: [
            "category",
            "title",
            "observation",
            "risk_level",
            "confidence",
            "status"
          ]
        }
      }
    },

    required: [
      "scene_summary",
      "observations"
    ]
  };

  try {

    const messages = [

      {
        role: "system",
        content: `
You are an AI assistant for workplace safety inspections in Singapore.

Your task is to examine a workplace photograph and identify visible
safety-related conditions that an inspector should check.

IMPORTANT:

1. Only report things that are visibly supported by the photograph.
2. Do not invent objects, hazards or activities.
3. Do not make legal conclusions.
4. Do not say that a workplace is legally compliant based only on a photo.
5. Use CHECK_REQUIRED when the photograph does not provide enough evidence.
6. PASS means that the visible condition appears acceptable only.
7. FAIL means a visible condition appears potentially unsafe.
8. HIGH risk should only be used for a clearly visible significant hazard.
9. Maximum 6 observations.
10. Keep each observation concise.
11. Do not include Markdown.
12. Return ONLY the JSON object required by the schema.

Focus on:

- Vehicular Safety
- Housekeeping
- PPE
- Work at Height
- Lifting
- Other obvious physical hazards

For example:

A worker wearing a helmet does NOT automatically mean the PPE requirement
is fully compliant. If the image cannot determine whether the PPE is
appropriate for the task, use CHECK_REQUIRED.

If a crane is visible but the photograph does not show whether a person is
inside an exclusion zone, use CHECK_REQUIRED rather than FAIL.

If there is a possible fall hazard near an edge, identify the visible
condition and recommend verification of fall protection.
`
      },

      {
        role: "user",
        content: `
Analyse this workplace safety inspection photograph.

Identify the visible workplace situation and the safety checks that an
inspector should perform.

Pay particular attention to:

1. People
2. Vehicles
3. Pedestrians
4. Guardrails
5. Edges/openings
6. Work at height
7. Lifting equipment
8. Suspended loads
9. PPE
10. Housekeeping
11. Obstructions
12. Spills or slippery surfaces

Do not assume something is unsafe if it cannot be seen clearly.
`
      }

    ];

    const response: any = await env.AI.run(
      VISION_MODEL,
      {
        messages,

        image: imageDataUrl,

        response_format: {
          type: "json_schema",
          json_schema: safetySchema
        },

        temperature: 0.1,

        max_tokens: 1200
      }
    );

    const raw = response?.response ?? response?.result ?? "";

    console.log(
      "Workers AI response:",
      JSON.stringify(response)
    );

    if (!raw) {

      throw new Error(
        "Workers AI returned an empty response."
      );

    }

    /*
     * JSON Mode normally returns a JSON string.
     *
     * Some Workers AI responses may already be objects, so handle both.
     */

    let parsed: any;

    if (typeof raw === "object") {

      parsed = raw;

    } else {

      let text = String(raw).trim();

      /*
       * Defensive cleanup in case the model still adds Markdown fences.
       */

      if (text.startsWith("```")) {

        text = text
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```\s*$/i, "")
          .trim();

      }

      parsed = JSON.parse(text);

    }

    /*
     * Basic validation.
     */

    if (
      !parsed ||
      typeof parsed !== "object"
    ) {

      throw new Error(
        "Workers AI returned an invalid JSON object."
      );

    }

    if (
      !Array.isArray(parsed.observations)
    ) {

      parsed.observations = [];

    }

    /*
     * Limit the number of findings.
     */

    parsed.observations =
      parsed.observations.slice(0, 6);

    /*
     * Normalise each finding.
     */

    parsed.observations =
      parsed.observations.map(
        (observation: any) => {

          const allowedCategories = [
            "Vehicular Safety",
            "Housekeeping",
            "PPE",
            "Work at Height",
            "Lifting",
            "Other"
          ];

          const allowedRisk = [
            "HIGH",
            "MEDIUM",
            "LOW"
          ];

          const allowedStatus = [
            "FAIL",
            "CHECK_REQUIRED",
            "PASS"
          ];

          const category =
            allowedCategories.includes(
              observation?.category
            )
              ? observation.category
              : "Other";

          const risk =
            allowedRisk.includes(
              observation?.risk_level
            )
              ? observation.risk_level
              : "MEDIUM";

          const status =
            allowedStatus.includes(
              observation?.status
            )
              ? observation.status
              : "CHECK_REQUIRED";

          let confidence =
            Number(
              observation?.confidence
            );

          if (
            Number.isNaN(confidence)
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

          return {

            category,

            title:
              String(
                observation?.title ||
                "Safety observation"
              ).slice(0, 200),

            observation:
              String(
                observation?.observation ||
                "Further inspection is required."
              ).slice(0, 500),

            risk_level:
              risk,

            confidence,

            status

          };

        }
      );

    return parsed;

  } catch (error: any) {

    console.error(
      "Workers AI analysis failed:",
      error
    );

    /*
     * IMPORTANT:
     * Throw the error instead of hiding it.
     * The API endpoint will return the real error to the browser.
     */

    throw new Error(
      `AI analysis failed: ${
        error?.message ||
        String(error)
      }`
    );

  }

}


/**
 * Find relevant WSH checks from D1.
 *
 * Vectorize is intentionally not required for the current MVP.
 * We will add semantic WSH matching after the Vision AI pipeline
 * is stable.
 */
async function findRelevantChecks(
  env: Env,
  observations: any[]
): Promise<any[]> {

  const categories = [
    ...new Set(
      observations
        .map(
          (observation) =>
            String(
              observation?.category ||
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


/**
 * Match AI observations to the current D1 safety checks.
 */
function enrichFindings(
  observations: any[],
  checks: any[]
): any[] {

  return observations.map(
    (observation) => {

      const candidates =
        checks.filter(
          (check) =>
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
       * First attempt:
       * keyword matching.
       */

      for (
        const check of candidates
      ) {

        const keywords =
          String(
            check.keywords || ""
          )
            .split(",")
            .map(
              (keyword: string) =>
                keyword
                  .trim()
                  .toLowerCase()
            )
            .filter(Boolean);

        const matched =
          keywords.some(
            (keyword) =>
              searchText.includes(
                keyword
              )
          );

        if (matched) {

          selectedCheck =
            check;

          break;

        }

      }

      /*
       * If no keyword matched,
       * use the first relevant
       * category check.
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


/**
 * Main Worker.
 */
export default {

  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {

    /*
     * CORS preflight.
     */

    if (
      request.method === "OPTIONS"
    ) {

      return new Response(
        null,
        {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers":
              "Content-Type, Authorization",
            "Access-Control-Allow-Methods":
              "GET, POST, OPTIONS"
          }
        }
      );

    }

    const url =
      new URL(request.url);

    try {

      /*
       * Health check.
       */

      if (
        url.pathname ===
          "/api/health" &&
        request.method === "GET"
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


      /*
       * Return current WSH checks.
       */

      if (
        url.pathname ===
          "/api/checks" &&
        request.method === "GET"
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
            result.results || []
        });

      }


      /*
       * Return recent inspections.
       */

      if (
        url.pathname ===
          "/api/inspections" &&
        request.method === "GET"
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
                ON f.inspection_id = i.id
              GROUP BY i.id
              ORDER BY i.created_at DESC
              LIMIT 100
              `
            )
            .all();

        return json({
          inspections:
            result.results || []
        });

      }


      /*
       * Analyse a new safety inspection photo.
       */
      if (
        url.pathname ===
          "/api/analyze" &&
        request.method === "POST"
      ) {

        const form =
          await request.formData();

        const file =
          form.get("photo");

        const location =
          String(
            form.get("location") ||
            "Unspecified"
          );

        const inspector =
          String(
            form.get("inspector") ||
            "Inspector"
          );


        /*
         * Validate uploaded file.
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
          id("insp");

        const inspectionNo =
          `SI-${new Date()
            .toISOString()
            .slice(0, 10)
            .replaceAll("-", "")}-${crypto
            .randomUUID()
            .slice(0, 6)
            .toUpperCase()}`;

        const photoId =
          id("photo");


        /*
         * Sanitise original filename.
         */

        const safeFileName =
          file.name.replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          );


        const objectKey =
          `${new Date()
            .toISOString()
            .slice(0, 10)}/${inspectionId}/${photoId}-${safeFileName}`;


        /*
         * Save photo to R2.
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
         * Create inspection record.
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
         * Create photo record.
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
         * Convert image to a data URL for Workers AI.
         */

        const bytes =
          new Uint8Array(
            await file.arrayBuffer()
          );

        let binary = "";

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


        /*
         * Run Vision AI.
         */

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

          /*
           * The inspection/photo have already
           * been saved successfully.
           *
           * Return the actual AI error to the
           * browser so debugging is easier.
           */

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


        /*
         * Get relevant WSH checks.
         */

        const checks =
          await findRelevantChecks(
            env,
            aiResult.observations ||
              []
          );


        /*
         * Match AI observations
         * with WSH checks.
         */

        const findings =
          enrichFindings(
            aiResult.observations ||
              [],
            checks
          );


        /*
         * Determine overall result.
         */

        let overall =
          "CHECK_REQUIRED";


        const hasHighFail =
          findings.some(
            (finding) =>
              finding.status ===
                "FAIL" &&
              finding.risk_level ===
                "HIGH"
          );


        const hasFail =
          findings.some(
            (finding) =>
              finding.status ===
              "FAIL"
          );


        const hasCheckRequired =
          findings.some(
            (finding) =>
              finding.status ===
              "CHECK_REQUIRED"
          );


        if (hasHighFail) {

          overall =
            "ATTENTION";

        } else if (hasFail) {

          overall =
            "ATTENTION";

        } else if (
          hasCheckRequired
        ) {

          overall =
            "CHECK_REQUIRED";

        } else {

          overall =
            "PASS";

        }


        /*
         * Update inspection result.
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


        /*
         * Save individual findings.
         */

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

              id("find"),

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

              finding.check_id,

              finding.source_title,

              finding.source_url,

              now()

            )
            .run();

        }


        /*
         * Return complete result to frontend.
         */

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


      /*
       * Get a single inspection.
       */

      if (
        url.pathname.startsWith(
          "/api/inspections/"
        ) &&
        request.method === "GET"
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
            result.results || []

        });

      }


      /*
       * Everything else is served
       * from the static assets directory.
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

      /*
       * Return the real error.
       * This is especially useful during
       * the MVP testing phase.
       */

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
