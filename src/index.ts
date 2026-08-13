/*
 * ============================================================
 * SAFETY INSPECTION AI
 * Cloudflare Worker
 *
 * Vision model:
 *   @cf/meta/llama-3.2-11b-vision-instruct
 *
 * Storage:
 *   D1: SAFETY_DB
 *   R2: PHOTOS
 *
 * Vectorize:
 *   NOT USED
 *
 * D1 tables:
 *   inspections
 *   inspection_items
 *   inspection_photos
 * ============================================================
 */


interface Env {

  AI: Ai;

  SAFETY_DB: D1Database;

  PHOTOS: R2Bucket;

  ASSETS: Fetcher;

}


const VISION_MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct";


/*
 * ============================================================
 * WSH GUIDANCE
 * ============================================================
 */

interface WshGuidance {

  category: string;

  check_question: string;

  guidance: string;

  source_title: string;

  source_url: string;

}


const WSH_GUIDANCE:
  Record<string, WshGuidance> = {

  PPE: {

    category:
      "PPE",

    check_question:
      "Are workers provided with and wearing the appropriate personal protective equipment for the task?",

    guidance:
      "Verify that required PPE is provided, suitable for the work activity and correctly worn.",

    source_title:
      "WSH Council resources",

    source_url:
      "https://www.tal.sg/wshc/topics"

  },


  "Work at Height": {

    category:
      "Work at Height",

    check_question:
      "Is there a visible fall hazard requiring fall prevention or protection?",

    guidance:
      "If work at height is visible, verify that suitable edge protection, safe access and fall prevention or protection measures are provided.",

    source_title:
      "Preventing Falls from Height",

    source_url:
      "https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights"

  },


  Lifting: {

    category:
      "Lifting",

    check_question:
      "Are lifting operations and suspended loads controlled to prevent workers from being exposed to lifting hazards?",

    guidance:
      "Where lifting equipment or lifting operations are visible, verify that the lifting activity is properly controlled and workers are kept clear of suspended loads.",

    source_title:
      "WSH Council Lifting resources",

    source_url:
      "https://www.tal.sg/wshc/topics/lifting"

  },


  "Vehicular Safety": {

    category:
      "Vehicular Safety",

    check_question:
      "Are pedestrians and vehicles safely segregated and are vehicle routes clearly managed?",

    guidance:
      "Verify that pedestrian walkways and vehicle routes are clearly demarcated, visible and kept free of obstructions.",

    source_title:
      "Workplace Traffic Safety Management",

    source_url:
      "https://www.tal.sg/wshc/topics/vehicular-safety/workplace-traffic-safety-management"

  },


  Housekeeping: {

    category:
      "Housekeeping",

    check_question:
      "Are there visible spills, oily, wet or dirty surfaces, debris or obstructions that could create a hazard?",

    guidance:
      "Check for spilled substances, oily or wet surfaces, debris and obstructions and ensure hazards are controlled promptly.",

    source_title:
      "Workplace Housekeeping",

    source_url:
      "https://www.tal.sg/wshc/topics/housekeeping/workplace-housekeeping"

  },


  Other: {

    category:
      "Other",

    check_question:
      "Is there any other visible condition that could create a workplace safety or health risk?",

    guidance:
      "Verify the condition physically and determine whether additional controls are required.",

    source_title:
      "Workplace Safety and Health Council",

    source_url:
      "https://www.tal.sg/wshc"

  }

};


/*
 * ============================================================
 * BASIC HELPERS
 * ============================================================
 */


function json(
  data: any,
  status = 200
): Response {

  return new Response(
    JSON.stringify(
      data
    ),
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


function cleanText(
  value: any,
  maxLength = 1000
): string {

  return String(
    value ?? ""
  )
    .replace(
      /\*\*/g,
      ""
    )
    .replace(
      /`/g,
      ""
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim()
    .slice(
      0,
      maxLength
    );

}


function generateInspectionNo(): string {

  const now =
    new Date();

  const date =
    now
      .toISOString()
      .slice(
        0,
        10
      )
      .replace(
        /-/g,
        ""
      );

  const random =
    crypto
      .randomUUID()
      .replace(
        /-/g,
        ""
      )
      .slice(
        0,
        6
      )
      .toUpperCase();

  return (
    `SI-${date}-${random}`
  );

}


function normaliseCategory(
  category: string,
  title = "",
  observation = ""
): string {

  const text =
    `${category} ${title} ${observation}`
      .toLowerCase();


  if (
    text.includes("ppe") ||
    text.includes("hard hat") ||
    text.includes("helmet") ||
    text.includes("safety vest") ||
    text.includes("hi-vis") ||
    text.includes("high visibility") ||
    text.includes("glove") ||
    text.includes("safety shoe")
  ) {

    return "PPE";

  }


  if (
    text.includes("height") ||
    text.includes("guardrail") ||
    text.includes("handrail") ||
    text.includes("open edge") ||
    text.includes("fall hazard") ||
    text.includes("ladder") ||
    text.includes("scaffold")
  ) {

    return "Work at Height";

  }


  if (
    text.includes("lifting") ||
    text.includes("crane") ||
    text.includes("sling") ||
    text.includes("hook") ||
    text.includes("suspended load") ||
    text.includes("lifting equipment")
  ) {

    return "Lifting";

  }


  if (
    text.includes("vehicle") ||
    text.includes("truck") ||
    text.includes("prime mover") ||
    text.includes("forklift") ||
    text.includes("traffic") ||
    text.includes("pedestrian")
  ) {

    return "Vehicular Safety";

  }


  if (
    text.includes("spill") ||
    text.includes("oil") ||
    text.includes("wet") ||
    text.includes("slippery") ||
    text.includes("debris") ||
    text.includes("clutter") ||
    text.includes("housekeeping") ||
    text.includes("obstruction")
  ) {

    return "Housekeeping";

  }


  return "Other";

}


function getGuidance(
  category: string
): WshGuidance {

  return (
    WSH_GUIDANCE[
      category
    ] ||
    WSH_GUIDANCE.Other
  );

}


/*
 * ============================================================
 * IMAGE HELPERS
 * ============================================================
 */


function arrayBufferToDataUrl(
  buffer: ArrayBuffer,
  contentType: string
): string {

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


  const base64 =
    btoa(
      binary
    );


  return (
    `data:${contentType};base64,${base64}`
  );

}


/*
 * ============================================================
 * AI RESPONSE EXTRACTION
 * ============================================================
 */


function extractAiText(
  response: any
): string {

  if (
    typeof response ===
    "string"
  ) {

    return response.trim();

  }


  if (
    typeof response?.response ===
    "string"
  ) {

    return response.response.trim();

  }


  if (
    typeof response?.result ===
    "string"
  ) {

    return response.result.trim();

  }


  if (
    typeof response?.response?.response ===
    "string"
  ) {

    return response
      .response
      .response
      .trim();

  }


  return "";

}


/*
 * ============================================================
 * PARSE VISION RESPONSE
 * ============================================================
 *
 * Supports both:
 *
 * FORMAT A:
 *
 * SUMMARY|||...
 * FINDING|||PPE|||...|||PASS|||LOW|||0.95|||...
 *
 *
 * FORMAT B:
 *
 * **Summary** Worker...
 *
 * **Finding**
 * **PPE**: Hard hat and safety vest visible
 * + Category: PPE
 * + Title: Worker is visibly wearing...
 * + Status: PASS
 * + Risk: LOW
 * + Confidence: 0.95
 *
 * **Work at Height**: Guardrail requires verification
 * + Category: Work at Height
 * ...
 * ============================================================
 */


interface ParsedFinding {

  category: string;

  title: string;

  status:
    | "PASS"
    | "CHECK_REQUIRED"
    | "FAIL";

  risk_level:
    | "LOW"
    | "MEDIUM"
    | "HIGH";

  confidence: number;

  observation: string;

  check_question: string;

  guidance: string;

  source_title: string;

  source_url: string;

}


interface ParsedAnalysis {

  scene_summary: string;

  findings: ParsedFinding[];

}


function parseExactFormat(
  text: string
): ParsedAnalysis | null {

  const lines =
    text
      .split(/\r?\n/)
      .map(
        line =>
          line.trim()
      )
      .filter(Boolean);


  const summaryLine =
    lines.find(
      line =>
        /^SUMMARY\|\|\|/i.test(
          line
        )
    );


  const summary =
    summaryLine
      ? cleanText(
          summaryLine
            .split(
              "|||"
            )
            .slice(1)
            .join("|||"),
          500
        )
      : "";


  const findings:
    ParsedFinding[] = [];


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


    if (
      parts.length < 7
    ) {

      continue;

    }


    const category =
      normaliseCategory(
        parts[1],
        parts[2],
        parts[6]
      );


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


    if (
      ![
        "PASS",
        "CHECK_REQUIRED",
        "FAIL"
      ].includes(
        status
      )
    ) {

      status =
        "CHECK_REQUIRED";

    }


    if (
      ![
        "LOW",
        "MEDIUM",
        "HIGH"
      ].includes(
        risk
      )
    ) {

      risk =
        "MEDIUM";

    }


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


    const guidance =
      getGuidance(
        category
      );


    findings.push({

      category,

      title:
        cleanText(
          parts[2],
          200
        ),

      status:
        status as ParsedFinding["status"],

      risk_level:
        risk as ParsedFinding["risk_level"],

      confidence,

      observation:
        cleanText(
          parts
            .slice(6)
            .join("|||"),
          800
        ),

      check_question:
        guidance.check_question,

      guidance:
        guidance.guidance,

      source_title:
        guidance.source_title,

      source_url:
        guidance.source_url

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

    scene_summary:
      summary ||
      "Workplace scene analysed.",

    findings

  };

}


function parseMarkdownFormat(
  text: string
): ParsedAnalysis | null {

  /*
   * Remove markdown emphasis.
   */

  const clean =
    text
      .replace(
        /\*\*/g,
        ""
      )
      .replace(
        /__/g,
        ""
      )
      .replace(
        /\r?\n/g,
        " "
      )
      .replace(
        /\s+/g,
        " "
      )
      .trim();


  /*
   * --------------------------------------------------------
   * SUMMARY
   * --------------------------------------------------------
   */

  let sceneSummary =
    "Workplace scene analysed.";


  const firstCategoryRegex =
    /(?:Finding\s+)?(?:PPE|Work at Height|Lifting|Vehicular Safety|Housekeeping)\s*:/i;


  const firstCategory =
    clean.search(
      firstCategoryRegex
    );


  const summaryMatch =
    clean.match(
      /Summary\s+(.+)/i
    );


  if (
    summaryMatch
  ) {

    let summaryText =
      summaryMatch[1];


    if (
      firstCategory >= 0
    ) {

      summaryText =
        clean.slice(
          summaryMatch.index! +
          summaryMatch[0]
            .indexOf(
              summaryMatch[1]
            ),
          firstCategory
        );

    }


    sceneSummary =
      cleanText(
        summaryText,
        500
      );

  }


  /*
   * --------------------------------------------------------
   * FIND CATEGORY BLOCKS
   * --------------------------------------------------------
   *
   * This is important because the Vision model has been
   * returning:
   *
   * PPE: ...
   * + Category: PPE
   * + Title: ...
   *
   * Work at Height: ...
   * + Category: Work at Height
   *
   * etc.
   */

  const categoryRegex =
    /(?:Finding\s+)?(PPE|Work at Height|Lifting|Vehicular Safety|Housekeeping)\s*:/gi;


  const matches =
    [
      ...clean.matchAll(
        categoryRegex
      )
    ];


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
        match.index ??
        0
      ) +
      match[0].length;


    const end =
      i + 1 <
      matches.length
        ? (
            matches[i + 1]
              .index ??
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


    /*
     * ------------------------------------------------------
     * Text before + Category is the model's observation.
     * ------------------------------------------------------
     */

    const categoryMarker =
      block.search(
        /\+\s*Category\s*:/i
      );


    let leadText =
      categoryMarker >= 0
        ? block.slice(
            0,
            categoryMarker
          )
        : block;


    leadText =
      cleanText(
        leadText
          .replace(
            /^\+?\s*/,
            ""
          ),
        500
      );


    /*
     * ------------------------------------------------------
     * TITLE
     * ------------------------------------------------------
     */

    const titleMatch =
      block.match(
        /(?:\+\s*)?Title\s*:\s*(.*?)(?=\s*\+\s*Status\s*:|\s*$)/i
      );


    let title =
      titleMatch?.[1]
        ? cleanText(
            titleMatch[1],
            200
          )
        : leadText;


    if (
      !title
    ) {

      title =
        "Safety observation";

    }


    /*
     * ------------------------------------------------------
     * STATUS
     * ------------------------------------------------------
     */

    const statusMatch =
      block.match(
        /(?:\+\s*)?Status\s*:\s*(PASS|FAIL|CHECK_REQUIRED)/i
      );


    let status =
      (
        statusMatch?.[1] ||
        "CHECK_REQUIRED"
      )
        .toUpperCase();


    /*
     * ------------------------------------------------------
     * RISK
     * ------------------------------------------------------
     */

    const riskMatch =
      block.match(
        /(?:\+\s*)?Risk\s*:\s*(LOW|MEDIUM|HIGH)/i
      );


    let risk =
      (
        riskMatch?.[1] ||
        "MEDIUM"
      )
        .toUpperCase();


    /*
     * ------------------------------------------------------
     * CONFIDENCE
     * ------------------------------------------------------
     */

    const confidenceMatch =
      block.match(
        /(?:\+\s*)?Confidence\s*:\s*([0-9.]+)/i
      );


    let confidence =
      Number(
        confidenceMatch?.[1] ||
        0.5
      );


    /*
     * ------------------------------------------------------
     * VALIDATION
     * ------------------------------------------------------
     */

    if (
      ![
        "PASS",
        "CHECK_REQUIRED",
        "FAIL"
      ].includes(
        status
      )
    ) {

      status =
        "CHECK_REQUIRED";

    }


    if (
      ![
        "LOW",
        "MEDIUM",
        "HIGH"
      ].includes(
        risk
      )
    ) {

      risk =
        "MEDIUM";

    }


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
     * ------------------------------------------------------
     * SAFETY RULES
     * ------------------------------------------------------
     */

    const combined =
      (
        `${title} ${leadText}`
      )
        .toLowerCase();


    /*
     * If model says "requires verification",
     * don't allow PASS.
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
     * Do not turn uncertain absence into FAIL.
     */

    if (
      (
        combined.includes(
          "no visible"
        ) ||
        combined.includes(
          "not visible"
        ) ||
        combined.includes(
          "not wearing"
        ) ||
        combined.includes(
          "missing"
        )
      ) &&
      status === "FAIL"
    ) {

      status =
        "CHECK_REQUIRED";

    }


    /*
     * Never incorrectly flag a visible vest.
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
          "high-visibility clothing"
        ) ||
        combined.includes(
          "high visibility clothing"
        )
      )
    ) {

      if (
        status !== "FAIL"
      ) {

        status =
          "PASS";

      }

    }


    /*
     * Never incorrectly flag a visible guardrail.
     */

    if (
      category === "Work at Height" &&
      (
        combined.includes(
          "guardrail is visible"
        ) ||
        combined.includes(
          "guardrail visible"
        ) ||
        combined.includes(
          "guard rails are visible"
        )
      )
    ) {

      /*
       * Visible guardrail itself is not a FAIL.
       * Physical verification may still be required.
       */

      if (
        status === "FAIL" &&
        !combined.includes(
          "damaged"
        ) &&
        !combined.includes(
          "broken"
        ) &&
        !combined.includes(
          "missing"
        )
      ) {

        status =
          "CHECK_REQUIRED";

      }

    }


    const guidance =
      getGuidance(
        category
      );


    findings.push({

      category,

      title,

      status:
        status as ParsedFinding["status"],

      risk_level:
        risk as ParsedFinding["risk_level"],

      confidence,

      observation:
        leadText ||
        title,

      check_question:
        guidance.check_question,

      guidance:
        guidance.guidance,

      source_title:
        guidance.source_title,

      source_url:
        guidance.source_url

    });

  }


  if (
    findings.length === 0
  ) {

    return null;

  }


  return {

    scene_summary:
      sceneSummary,

    findings

  };

}


function parseAiAnalysis(
  text: string
): ParsedAnalysis {

  /*
   * First try the exact format.
   */

  const exact =
    parseExactFormat(
      text
    );


  if (
    exact
  ) {

    return exact;

  }


  /*
   * Then parse the markdown/natural language
   * format actually returned by the model.
   */

  const markdown =
    parseMarkdownFormat(
      text
    );


  if (
    markdown
  ) {

    return markdown;

  }


  /*
   * Last resort.
   *
   * Never crash just because the model ignored
   * our formatting instructions.
   */

  const guidance =
    getGuidance(
      "Other"
    );


  return {

    scene_summary:
      "The AI returned an unstructured observation.",

    findings: [

      {

        category:
          "Other",

        title:
          "AI analysis requires review",

        status:
          "CHECK_REQUIRED",

        risk_level:
          "MEDIUM",

        confidence:
          0.5,

        observation:
          cleanText(
            text,
            1000
          ),

        check_question:
          guidance.check_question,

        guidance:
          guidance.guidance,

        source_title:
          guidance.source_title,

        source_url:
          guidance.source_url

      }

    ]

  };

}


/*
 * ============================================================
 * OVERALL RESULT
 * ============================================================
 */


function calculateOverallResult(
  findings: ParsedFinding[]
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
 * ============================================================
 * SAVE INSPECTION
 * ============================================================
 */


async function saveInspection(
  env: Env,
  inspectionNo: string,
  location: string,
  inspector: string,
  overallResult: string,
  findings: ParsedFinding[],
  imageFile: File | null
): Promise<{
  id: string;
  inspectionNo: string;
}> {

  const inspectionId =
    crypto.randomUUID();


  const now =
    new Date();


  const createdAt =
    now.toISOString();


  const inspectionDate =
    createdAt.slice(
      0,
      10
    );


  const inspectionMonth =
    createdAt.slice(
      0,
      7
    );


  /*
   * --------------------------------------------------------
   * D1 INSPECTION
   * --------------------------------------------------------
   */

  const statements:
    D1PreparedStatement[] = [];


  statements.push(
    env.SAFETY_DB.prepare(
      `
      INSERT INTO inspections (
        id,
        confirmation_no,
        document_no,
        inspection_month,
        inspection_date,
        platform_id,
        location,
        rated_load,
        platform_height,
        inspector_name,
        supervisor_reviewer,
        overall_status,
        do_not_use_tag,
        isolated,
        supervisor_informed,
        repair_raised,
        created_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      `
    ).bind(

      inspectionId,

      inspectionNo,

      inspectionNo,

      inspectionMonth,

      inspectionDate,

      "AI-VISION",

      location,

      null,

      null,

      inspector,

      null,

      overallResult,

      0,

      0,

      0,

      0,

      createdAt

    )
  );


  /*
   * --------------------------------------------------------
   * D1 ITEMS
   * --------------------------------------------------------
   */

  findings.forEach(
    (
      finding,
      index
    ) => {

      const guidance =
        getGuidance(
          finding.category
        );


      const remark =
        [
          finding.observation,

          "",

          `WSH check: ${guidance.check_question}`,

          guidance.guidance,

          `Source: ${guidance.source_title}`,

          `Source URL: ${guidance.source_url}`,

          `AI confidence: ${Math.round(
            finding.confidence * 100
          )}%`,

          `Risk: ${finding.risk_level}`

        ]
          .join("\n");


      statements.push(
        env.SAFETY_DB.prepare(
          `
          INSERT INTO inspection_items (
            id,
            inspection_id,
            item_no,
            item_title,
            result,
            remark,
            due_date
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?
          )
          `
        ).bind(

          crypto.randomUUID(),

          inspectionId,

          index + 1,

          finding.title,

          finding.status,

          remark,

          null

        )
      );

    }
  );


  /*
   * --------------------------------------------------------
   * EXECUTE D1
   * --------------------------------------------------------
   */

  await env.SAFETY_DB.batch(
    statements
  );


  /*
   * --------------------------------------------------------
   * SAVE PHOTO TO R2
   * --------------------------------------------------------
   */

  if (
    imageFile
  ) {

    try {

      const safeName =
        imageFile.name
          .replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
          );


      const objectKey =
        `inspections/${inspectionId}/${Date.now()}-${safeName}`;


      const buffer =
        await imageFile.arrayBuffer();


      await env.PHOTOS.put(
        objectKey,
        buffer,
        {
          httpMetadata: {
            contentType:
              imageFile.type ||
              "image/jpeg"
          }
        }
      );


      await env.SAFETY_DB
        .prepare(
          `
          INSERT INTO inspection_photos (
            id,
            inspection_id,
            item_no,
            object_key,
            original_name,
            content_type,
            created_at
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?
          )
          `
        )
        .bind(

          crypto.randomUUID(),

          inspectionId,

          0,

          objectKey,

          imageFile.name,

          imageFile.type ||
            "image/jpeg",

          createdAt

        )
        .run();

    } catch (
      photoError
    ) {

      /*
       * Do not fail the entire inspection if
       * the R2 photo save has a temporary issue.
       */

      console.error(
        "Photo storage error:",
        photoError
      );

    }

  }


  return {

    id:
      inspectionId,

    inspectionNo

  };

}


/*
 * ============================================================
 * BUILD API FINDING
 * ============================================================
 */


function buildFindingFromItem(
  item: any
): any {

  const title =
    cleanText(
      item.item_title,
      300
    );


  const remark =
    String(
      item.remark ||
      ""
    );


  /*
   * Extract observation.
   *
   * Everything before "WSH check:" is the
   * original AI observation.
   */

  const observation =
    cleanText(
      remark
        .split(
          "WSH check:"
        )[0],
      800
    );


  const category =
    normaliseCategory(
      "",
      title,
      observation
    );


  const guidance =
    getGuidance(
      category
    );


  const confidenceMatch =
    remark.match(
      /AI confidence:\s*([0-9]+)%/i
    );


  const confidence =
    confidenceMatch
      ? Number(
          confidenceMatch[1]
        ) / 100
      : 0.5;


  const riskMatch =
    remark.match(
      /Risk:\s*(LOW|MEDIUM|HIGH)/i
    );


  const risk =
    riskMatch?.[1] ||
    "MEDIUM";


  return {

    category,

    title,

    status:
      item.result ||
      "CHECK_REQUIRED",

    risk_level:
      risk,

    confidence,

    observation:
      observation ||
      "Physical verification required.",

    check_question:
      guidance.check_question,

    guidance:
      guidance.guidance,

    source_title:
      guidance.source_title,

    source_url:
      guidance.source_url

  };

}


/*
 * ============================================================
 * API: ANALYSE
 * ============================================================
 */


async function handleAnalyze(
  request: Request,
  env: Env
): Promise<Response> {

  try {

    const form =
      await request.formData();


    const photo =
      form.get(
        "photo"
      );


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
            "Uploaded file is not an image."
        },
        400
      );

    }


    /*
     * 8 MB application limit.
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
      String(
        form.get(
          "location"
        ) ||
        "Unspecified"
      )
        .trim()
        .slice(
          0,
          200
        );


    const inspector =
      String(
        form.get(
          "inspector"
        ) ||
        "Inspector"
      )
        .trim()
        .slice(
          0,
          200
        );


    /*
     * --------------------------------------------------------
     * IMAGE
     * --------------------------------------------------------
     */

    const buffer =
      await photo.arrayBuffer();


    const imageDataUrl =
      arrayBufferToDataUrl(
        buffer,
        photo.type ||
          "image/jpeg"
      );


    /*
     * --------------------------------------------------------
     * AI PROMPT
     * --------------------------------------------------------
     *
     * IMPORTANT:
     *
     * No JSON response_format is used.
     *
     * The current Vision model has been returning natural
     * language even when JSON was requested.
     */

    const prompt = `
You are a workplace safety inspection AI for
Singapore container terminals, depots and industrial
workplaces.

Analyse the photograph carefully.

Your job is to identify ONLY safety conditions that
can reasonably be observed in the photograph.

Do not invent hazards.

Do not assume that a hazard exists simply because
an object is present in the background.

Do not report something as missing when it is visible.

If a condition cannot be confirmed from the photograph,
use CHECK_REQUIRED.

The result assists a human safety inspector.
It is NOT a final legal or compliance decision.

==================================================
SAFETY AREAS
==================================================

PPE:
- hard hats
- helmets
- safety vests
- high visibility clothing
- gloves
- safety shoes

WORK AT HEIGHT:
- guardrails
- handrails
- open edges
- openings
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
- pedestrians
- vehicle/pedestrian interaction
- traffic routes

HOUSEKEEPING:
- spills
- oil
- water
- wet surfaces
- debris
- clutter
- blocked access
- obstructions

==================================================
IMPORTANT SAFETY RULES
==================================================

1. If a safety vest is clearly visible,
   recognise it as visible PPE.

2. If a hard hat is clearly visible,
   recognise it as visible PPE.

3. If a guardrail is visible,
   do NOT report "no visible guardrail".

4. A crane in the background does NOT automatically
   mean that the worker is exposed to a lifting hazard.

5. Only report a spill when a spill is actually visible.

6. Shadows, stains and reflections are not automatically
   spills.

7. Only report a fall hazard when the photograph provides
   reasonable visual evidence.

8. If the photograph cannot confirm a condition,
   use CHECK_REQUIRED.

9. Use FAIL only when a potentially unsafe condition
   is clearly visible.

10. Use PASS when the visible condition appears
    acceptable.

11. Maximum 6 findings.

==================================================
OUTPUT
==================================================

Do NOT return JSON.

Do NOT use a JSON code block.

Do NOT explain your answer.

Return a short summary followed by findings.

Preferred format:

SUMMARY|||short factual description of the scene

FINDING|||CATEGORY|||TITLE|||STATUS|||RISK|||CONFIDENCE|||OBSERVATION

CATEGORY:
PPE
Work at Height
Lifting
Vehicular Safety
Housekeeping
Other

STATUS:
PASS
CHECK_REQUIRED
FAIL

RISK:
LOW
MEDIUM
HIGH

CONFIDENCE:
number from 0 to 1

Example:

SUMMARY|||Worker performing work in a container handling area with guardrails and lifting equipment visible.

FINDING|||PPE|||Hard hat and safety vest visible|||PASS|||LOW|||0.95|||Worker is visibly wearing a hard hat and high-visibility clothing.

FINDING|||Work at Height|||Guardrail requires verification|||CHECK_REQUIRED|||MEDIUM|||0.85|||Guardrail is visible around the work area. Verify that it is complete, secure and suitable for fall prevention.

FINDING|||Lifting|||Lifting activity requires verification|||CHECK_REQUIRED|||MEDIUM|||0.75|||Lifting equipment is visible in the background. Verify that workers are not exposed to suspended loads.

Remember:
ONLY return the summary and findings.
`;


    /*
     * --------------------------------------------------------
     * RUN VISION MODEL
     * --------------------------------------------------------
     */

    let aiResponse: any;


    try {

      aiResponse =
        await env.AI.run(
          VISION_MODEL,
          {
            prompt,

            image:
              imageDataUrl,

            temperature:
              0.05,

            max_tokens:
              1400

          } as any
        );

    } catch (
      aiError: any
    ) {

      console.error(
        "Workers AI error:",
        aiError
      );


      throw new Error(
        `Workers AI request failed: ${
          aiError?.message ||
          String(aiError)
        }`
      );

    }


    /*
     * --------------------------------------------------------
     * EXTRACT RAW TEXT
     * --------------------------------------------------------
     */

    const rawText =
      extractAiText(
        aiResponse
      );


    console.log(
      "Workers AI raw response:",
      JSON.stringify(
        aiResponse
      )
    );


    console.log(
      "Workers AI text:",
      rawText
    );


    if (
      !rawText
    ) {

      throw new Error(
        "Workers AI returned an empty response."
      );

    }


    /*
     * --------------------------------------------------------
     * PARSE
     * --------------------------------------------------------
     */

    const analysis =
      parseAiAnalysis(
        rawText
      );


    /*
     * --------------------------------------------------------
     * OVERALL STATUS
     * --------------------------------------------------------
     */

    const overallResult =
      calculateOverallResult(
        analysis.findings
      );


    /*
     * --------------------------------------------------------
     * INSPECTION NUMBER
     * --------------------------------------------------------
     */

    const inspectionNo =
      generateInspectionNo();


    /*
     * --------------------------------------------------------
     * SAVE D1 + R2
     * --------------------------------------------------------
     */

    const saved =
      await saveInspection(
        env,

        inspectionNo,

        location,

        inspector,

        overallResult,

        analysis.findings,

        photo

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
        saved.id,

      inspection_no:
        saved.inspectionNo,

      overall_result:
        overallResult,

      scene_summary:
        analysis.scene_summary,

      findings:
        analysis.findings

    });


  } catch (
    error: any
  ) {

    console.error(
      "Analysis failed:",
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
 * API: RECENT INSPECTIONS
 * ============================================================
 */


async function handleInspections(
  env: Env
): Promise<Response> {

  try {

    const result =
      await env.SAFETY_DB
        .prepare(
          `
          SELECT
            id,
            confirmation_no AS inspection_no,
            location,
            inspector_name,
            overall_status AS overall_result,
            created_at
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
      "Inspection list error:",
      error
    );


    return json(
      {
        error:
          "Unable to load inspections.",

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
 * API: SINGLE INSPECTION
 * ============================================================
 */


async function handleInspection(
  env: Env,
  id: string
): Promise<Response> {

  try {

    const inspectionResult =
      await env.SAFETY_DB
        .prepare(
          `
          SELECT
            id,
            confirmation_no AS inspection_no,
            document_no,
            inspection_month,
            inspection_date,
            platform_id,
            location,
            inspector_name,
            supervisor_reviewer,
            overall_status AS overall_result,
            do_not_use_tag,
            isolated,
            supervisor_informed,
            repair_raised,
            created_at
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
      !inspectionResult
    ) {

      return json(
        {
          error:
            "Inspection not found."
        },
        404
      );

    }


    const itemsResult =
      await env.SAFETY_DB
        .prepare(
          `
          SELECT
            id,
            inspection_id,
            item_no,
            item_title,
            result,
            remark,
            due_date
          FROM inspection_items
          WHERE inspection_id = ?
          ORDER BY item_no ASC
          `
        )
        .bind(
          id
        )
        .all();


    const findings =
      (
        itemsResult.results ||
        []
      )
        .map(
          item =>
            buildFindingFromItem(
              item
            )
        );


    /*
     * Scene summary is reconstructed from the first
     * stored observation because the current D1 schema
     * does not have a dedicated scene_summary column.
     */

    const sceneSummary =
      findings.length > 0
        ? "Previously recorded workplace safety inspection."
        : "Previously recorded inspection.";


    return json({

      inspection:
        inspectionResult,

      findings,

      scene_summary:
        sceneSummary

    });


  } catch (
    error: any
  ) {

    console.error(
      "Single inspection error:",
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
 * API: HEALTH CHECK
 * ============================================================
 */


async function handleHealth(
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
        VISION_MODEL,

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
 * MAIN FETCH HANDLER
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
     * CORS PREFLIGHT
     * --------------------------------------------------------
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
              "Content-Type",

            "Access-Control-Allow-Methods":
              "GET,POST,OPTIONS"

          }

        }
      );

    }


    /*
     * --------------------------------------------------------
     * API ROUTES
     * --------------------------------------------------------
     */

    if (
      url.pathname ===
      "/api/health"
    ) {

      return handleHealth(
        env
      );

    }


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


      return handleAnalyze(
        request,
        env
      );

    }


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


      return handleInspections(
        env
      );

    }


    /*
     * /api/inspections/:id
     */

    const inspectionPrefix =
      "/api/inspections/";


    if (
      url.pathname.startsWith(
        inspectionPrefix
      )
    ) {

      const id =
        decodeURIComponent(
          url.pathname.slice(
            inspectionPrefix.length
          )
        );


      if (
        id
      ) {

        return handleInspection(
          env,
          id
        );

      }

    }


    /*
     * --------------------------------------------------------
     * STATIC FRONTEND
     * --------------------------------------------------------
     */

    try {

      return env.ASSETS.fetch(
        request
      );

    } catch (
      error
    ) {

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

  }

};
