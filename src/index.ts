export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
}

const AI_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

type FindingStatus = "PASS" | "FAIL" | "CHECK_REQUIRED";
type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

interface SafetyCheck {
  id: string;
  category: string;
  check_question: string;
  guidance: string;
  source_title: string;
  source_url: string;
  keywords: string;
}

interface AIFinding {
  category?: string;
  title?: string;
  observation?: string;
  status?: string;
  risk_level?: string;
  confidence?: number;
  check_id?: string;
}

interface NormalizedFinding {
  id: string;
  inspection_id: string;
  photo_id: string;
  category: string;
  title: string;
  observation: string;
  status: FindingStatus;
  risk_level: RiskLevel;
  confidence: number;
  check_id: string | null;
  source_title: string | null;
  source_url: string | null;
  created_at: string;
}

interface AIResult {
  summary?: string;
  findings?: AIFinding[];
}

interface RequestPhoto {
  bytes: ArrayBuffer;
  contentType: string;
  fileName: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

function text(data: string, status = 200): Response {
  return new Response(data, {
    status,
    headers: {
      "content-type": "text/plain; charset=UTF-8",
      "cache-control": "no-store",
    },
  });
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function uuid(): string {
  return crypto.randomUUID();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function inspectionNumber(date = new Date()): string {
  return (
    "SI-" +
    date.getUTCFullYear() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    "-" +
    crypto.randomUUID().replace(/-/g, "").substring(0, 6).toUpperCase()
  );
}

function normalizeContentType(value: string | null | undefined): string {
  const v = String(value || "").toLowerCase().split(";")[0].trim();

  if (v === "image/png") return "image/png";
  if (v === "image/webp") return "image/webp";
  if (v === "image/gif") return "image/gif";
  if (v === "image/heic") return "image/heic";
  if (v === "image/heif") return "image/heif";
  if (v === "image/jpeg" || v === "image/jpg") return "image/jpeg";

  return "image/jpeg";
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    default:
      return "jpg";
  }
}

function safeFileName(name: string): string {
  const cleaned = String(name || "photo.jpg")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .substring(0, 150);

  return cleaned || "photo.jpg";
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);

  let binary = "";

  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(
      i,
      Math.min(i + chunkSize, bytes.length)
    );

    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function dataUri(
  buffer: ArrayBuffer,
  contentType: string
): string {
  return `data:${contentType};base64,${bytesToBase64(buffer)}`;
}

function cleanText(value: unknown, maxLength = 1200): string {
  if (value === null || value === undefined) return "";

  return String(value)
    .replace(/\u0000/g, "")
    .trim()
    .substring(0, maxLength);
}

function normalizeStatus(value: unknown): FindingStatus {
  const v = String(value || "")
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (v === "FAIL") return "FAIL";
  if (
    v === "PASS" ||
    v === "SAFE" ||
    v === "COMPLIANT"
  ) {
    return "PASS";
  }

  return "CHECK_REQUIRED";
}

function normalizeRisk(value: unknown): RiskLevel {
  const v = String(value || "").toUpperCase();

  if (v === "HIGH") return "HIGH";
  if (v === "LOW") return "LOW";

  return "MEDIUM";
}

function normalizeConfidence(value: unknown): number {
  let n = Number(value);

  if (!Number.isFinite(n)) {
    return 0.5;
  }

  // Models sometimes return 95 instead of 0.95.
  if (n > 1 && n <= 100) {
    n = n / 100;
  }

  if (n < 0) n = 0;
  if (n > 1) n = 1;

  return Math.round(n * 100) / 100;
}

function normalizeCategory(value: unknown): string {
  const v = cleanText(value, 80);

  if (!v) return "Other";

  const lower = v.toLowerCase();

  if (lower.includes("ppe")) return "PPE";
  if (lower.includes("height")) return "Work at Height";
  if (lower.includes("house")) return "Housekeeping";
  if (lower.includes("lift")) return "Lifting";
  if (
    lower.includes("vehicle") ||
    lower.includes("traffic")
  ) {
    return "Vehicular Safety";
  }
  if (lower.includes("electrical")) return "Electrical Safety";
  if (lower.includes("fire")) return "Fire Safety";
  if (lower.includes("storage")) return "Storage";

  return v;
}

function extractJsonCandidate(textValue: string): unknown | null {
  let textValueClean = textValue.trim();

  if (!textValueClean) return null;

  // Remove markdown code fences.
  textValueClean = textValueClean
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // Direct JSON.
  try {
    return JSON.parse(textValueClean);
  } catch {
    // Continue.
  }

  // Search for the first JSON object.
  const objectStart = textValueClean.indexOf("{");
  const objectEnd = textValueClean.lastIndexOf("}");

  if (
    objectStart >= 0 &&
    objectEnd > objectStart
  ) {
    const candidate = textValueClean.substring(
      objectStart,
      objectEnd + 1
    );

    try {
      return JSON.parse(candidate);
    } catch {
      // Continue.
    }
  }

  // Search for a JSON array.
  const arrayStart = textValueClean.indexOf("[");
  const arrayEnd = textValueClean.lastIndexOf("]");

  if (
    arrayStart >= 0 &&
    arrayEnd > arrayStart
  ) {
    const candidate = textValueClean.substring(
      arrayStart,
      arrayEnd + 1
    );

    try {
      return JSON.parse(candidate);
    } catch {
      // Continue.
    }
  }

  return null;
}

function getAIResponseText(result: any): string {
  if (!result) return "";

  if (typeof result === "string") {
    return result;
  }

  if (typeof result.response === "string") {
    return result.response;
  }

  if (typeof result.result === "string") {
    return result.result;
  }

  if (typeof result.output === "string") {
    return result.output;
  }

  if (typeof result.text === "string") {
    return result.text;
  }

  // Some response formats may put the actual object here.
  if (
    result.response &&
    typeof result.response === "object"
  ) {
    try {
      return JSON.stringify(result.response);
    } catch {
      return "";
    }
  }

  return "";
}

function parseAIResult(raw: unknown): AIResult | null {
  let candidate: any = raw;

  if (typeof raw === "string") {
    candidate = extractJsonCandidate(raw);
  }

  if (!candidate) return null;

  // Workers AI may return { response: "..." }.
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof candidate.response === "string"
  ) {
    const nested = extractJsonCandidate(candidate.response);

    if (nested) {
      candidate = nested;
    }
  }

  // Workers AI / JSON mode can sometimes return:
  // { response: { findings: [...] } }
  if (
    candidate &&
    typeof candidate === "object" &&
    candidate.response &&
    typeof candidate.response === "object"
  ) {
    candidate = candidate.response;
  }

  if (Array.isArray(candidate)) {
    return {
      findings: candidate,
    };
  }

  if (
    !candidate ||
    typeof candidate !== "object"
  ) {
    return null;
  }

  let findings: any = candidate.findings;

  if (!Array.isArray(findings)) {
    findings = candidate.observations;
  }

  if (!Array.isArray(findings)) {
    findings = candidate.results;
  }

  if (!Array.isArray(findings)) {
    findings = candidate.items;
  }

  if (!Array.isArray(findings)) {
    findings = [];
  }

  return {
    summary:
      typeof candidate.summary === "string"
        ? candidate.summary
        : undefined,
    findings,
  };
}

function categoryMatch(
  findingCategory: string,
  checkCategory: string
): boolean {
  const a = findingCategory.toLowerCase();
  const b = checkCategory.toLowerCase();

  if (a === b) return true;

  if (
    a.includes("vehicle") &&
    b.includes("vehicle")
  ) {
    return true;
  }

  if (
    a.includes("traffic") &&
    b.includes("vehicle")
  ) {
    return true;
  }

  if (
    a.includes("height") &&
    b.includes("height")
  ) {
    return true;
  }

  if (
    a.includes("ppe") &&
    b.includes("ppe")
  ) {
    return true;
  }

  if (
    a.includes("house") &&
    b.includes("house")
  ) {
    return true;
  }

  if (
    a.includes("lift") &&
    b.includes("lift")
  ) {
    return true;
  }

  return false;
}

function findBestSafetyCheck(
  finding: AIFinding,
  checks: SafetyCheck[]
): SafetyCheck | null {
  if (!checks.length) return null;

  const checkId = cleanText(finding.check_id, 100);

  if (checkId) {
    const exact = checks.find(
      (c) => c.id === checkId
    );

    if (exact) return exact;
  }

  const category = normalizeCategory(
    finding.category
  );

  const categoryChecks = checks.filter((c) =>
    categoryMatch(category, c.category)
  );

  if (categoryChecks.length === 1) {
    return categoryChecks[0];
  }

  const title = cleanText(
    finding.title,
    200
  ).toLowerCase();

  const observation = cleanText(
    finding.observation,
    500
  ).toLowerCase();

  const combined =
    `${category} ${title} ${observation}`.toLowerCase();

  let best: SafetyCheck | null = null;
  let bestScore = 0;

  for (const check of categoryChecks.length
    ? categoryChecks
    : checks) {
    const keywords = String(
      check.keywords || ""
    )
      .toLowerCase()
      .split(/[,\s;|]+/)
      .map((x) => x.trim())
      .filter(Boolean);

    let score = 0;

    for (const keyword of keywords) {
      if (keyword.length >= 3 && combined.includes(keyword)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = check;
    }
  }

  return best || categoryChecks[0] || null;
}

function normalizeFindings(
  findings: AIFinding[],
  inspectionId: string,
  photoId: string,
  checks: SafetyCheck[]
): NormalizedFinding[] {
  const output: NormalizedFinding[] = [];
  const now = new Date().toISOString();

  for (const raw of findings) {
    if (!raw || typeof raw !== "object") {
      continue;
    }

    const category = normalizeCategory(
      raw.category
    );

    const title =
      cleanText(raw.title, 200) ||
      "Safety observation";

    const observation =
      cleanText(raw.observation, 1500) ||
      cleanText(raw.title, 1500);

    if (!observation) {
      continue;
    }

    const status = normalizeStatus(
      raw.status
    );

    const riskLevel = normalizeRisk(
      raw.risk_level
    );

    const confidence =
      normalizeConfidence(raw.confidence);

    const check = findBestSafetyCheck(
      raw,
      checks
    );

    output.push({
      id: uuid(),
      inspection_id: inspectionId,
      photo_id: photoId,
      category,
      title,
      observation,
      status,
      risk_level: riskLevel,
      confidence,
      check_id:
        check?.id ||
        cleanText(raw.check_id, 100) ||
        null,
      source_title:
        check?.source_title ||
        null,
      source_url:
        check?.source_url ||
        null,
      created_at: now,
    });

    // Keep database output small and predictable.
    if (output.length >= 8) {
      break;
    }
  }

  return output;
}

function overallResult(
  findings: NormalizedFinding[]
): "PASS" | "ATTENTION" | "CHECK_REQUIRED" {
  if (
    findings.some(
      (f) => f.status === "FAIL"
    )
  ) {
    return "ATTENTION";
  }

  if (
    findings.some(
      (f) => f.status === "CHECK_REQUIRED"
    )
  ) {
    return "CHECK_REQUIRED";
  }

  if (
    findings.length > 0 &&
    findings.every(
      (f) => f.status === "PASS"
    )
  ) {
    return "PASS";
  }

  return "CHECK_REQUIRED";
}

function buildSummary(
  findings: NormalizedFinding[]
): string {
  if (!findings.length) {
    return "No structured safety findings were returned. Physical/site verification is required.";
  }

  const fail = findings.filter(
    (f) => f.status === "FAIL"
  ).length;

  const check = findings.filter(
    (f) => f.status === "CHECK_REQUIRED"
  ).length;

  const pass = findings.filter(
    (f) => f.status === "PASS"
  ).length;

  if (fail > 0) {
    return `${fail} safety finding(s) require corrective attention. ${check} item(s) require verification and ${pass} item(s) were assessed as PASS.`;
  }

  if (check > 0) {
    return `${check} safety item(s) require site verification. ${pass} item(s) were assessed as PASS.`;
  }

  return `${pass} visible safety item(s) were assessed as PASS. Physical/site verification is still required.`;
}

function buildPrompt(
  checks: SafetyCheck[]
): string {
  const checkText = checks
    .slice(0, 40)
    .map(
      (c) =>
        `CHECK_ID=${c.id}
CATEGORY=${c.category}
QUESTION=${c.check_question}
GUIDANCE=${c.guidance}`
    )
    .join("\n\n");

  return `
You are a workplace safety inspection assistant for a Singapore shipping/container depot.

Analyse ONLY what is visibly supported by the photograph.

Do NOT assume that something is safe simply because it cannot be seen.

IMPORTANT:
- Do not invent hazards.
- Do not invent PPE.
- Do not invent vehicles.
- Do not invent work at height.
- Do not treat a crane in the background as proof that the worker is performing lifting.
- Do not treat containers in the background as proof of a hazard.
- If something cannot be confirmed from the image, use CHECK_REQUIRED rather than PASS.
- PASS means the visible evidence supports that the item appears satisfactory.
- FAIL means a visible unsafe condition is reasonably clear.
- CHECK_REQUIRED means the image indicates that the item needs physical/site verification.
- Confidence must be between 0 and 1.
- Only create findings for safety topics that are relevant to visible evidence in the photograph.
- Do not create a finding merely because a category exists in the checklist.
- Prefer 3 to 6 useful findings. Maximum 8.
- Keep each observation concise.
- Use the supplied safety checks where applicable.
- The check_id must be one of the supplied CHECK_ID values, or null if no suitable check exists.

The standard safety categories may include:
PPE
Work at Height
Housekeeping
Lifting
Vehicular Safety
Electrical Safety
Fire Safety
Storage
Other

For example:
- A clearly visible hard hat/high visibility vest can support a PPE finding.
- A visible unprotected edge or unsafe elevated work area can support Work at Height.
- Visible spills, obstruction, debris or poor storage can support Housekeeping.
- A person visibly under or near a suspended load can support Lifting.
- Clearly visible pedestrian/vehicle conflict can support Vehicular Safety.
- If an item cannot be verified from the photograph, use CHECK_REQUIRED.

Return ONLY valid JSON.

Required structure:

{
  "summary": "short summary",
  "findings": [
    {
      "category": "PPE",
      "title": "short title",
      "observation": "what is visibly observed",
      "status": "PASS",
      "risk_level": "LOW",
      "confidence": 0.90,
      "check_id": "check-id"
    }
  ]
}

Available WSH safety checks:

${checkText}
`.trim();
}

async function getSafetyChecks(
  env: Env
): Promise<SafetyCheck[]> {
  try {
    const result = await env.SAFETY_DB
      .prepare(`
        SELECT
          id,
          category,
          check_question,
          guidance,
          source_title,
          source_url,
          keywords
        FROM safety_checks
        WHERE active = 1
        ORDER BY category, id
        LIMIT 40
      `)
      .all<SafetyCheck>();

    return result.results || [];
  } catch {
    return [];
  }
}

async function parsePhotoRequest(
  request: Request
): Promise<{
  photo: RequestPhoto;
  location: string;
  inspector: string;
}> {
  const contentType =
    request.headers.get("content-type") || "";

  // ---------------------------------------------------------
  // multipart/form-data
  // ---------------------------------------------------------
  if (
    contentType
      .toLowerCase()
      .includes("multipart/form-data")
  ) {
    const form = await request.formData();

    let file: File | null = null;

    const possibleNames = [
      "photo",
      "image",
      "file",
      "photoFile",
    ];

    for (const name of possibleNames) {
      const candidate = form.get(name);

      if (
        candidate &&
        typeof candidate !== "string" &&
        "arrayBuffer" in candidate
      ) {
        file = candidate as File;
        break;
      }
    }

    if (!file) {
      // Find the first File in the form.
      for (const [, value] of form.entries()) {
        if (
          value &&
          typeof value !== "string" &&
          "arrayBuffer" in value
        ) {
          file = value as File;
          break;
        }
      }
    }

    if (!file) {
      throw new Error(
        "No image file was uploaded."
      );
    }

    const bytes = await file.arrayBuffer();

    if (!bytes.byteLength) {
      throw new Error(
        "The uploaded image is empty."
      );
    }

    if (bytes.byteLength > 15 * 1024 * 1024) {
      throw new Error(
        "The image is too large. Maximum size is 15 MB."
      );
    }

    const ct = normalizeContentType(
      file.type
    );

    return {
      photo: {
        bytes,
        contentType: ct,
        fileName: safeFileName(
          file.name || "photo.jpg"
        ),
      },
      location: cleanText(
        form.get("location"),
        200
      ),
      inspector: cleanText(
        form.get("inspector"),
        200
      ),
    };
  }

  // ---------------------------------------------------------
  // JSON request
  // ---------------------------------------------------------
  let body: any;

  try {
    body = await request.json();
  } catch {
    throw new Error(
      "Invalid request body."
    );
  }

  if (!body || typeof body !== "object") {
    throw new Error(
      "Invalid request body."
    );
  }

  const imageValue =
    body.image ||
    body.imageBase64 ||
    body.photo;

  if (
    typeof imageValue !== "string" ||
    !imageValue.trim()
  ) {
    throw new Error(
      "No image was supplied."
    );
  }

  let base64 = imageValue.trim();

  let ct =
    normalizeContentType(
      body.contentType ||
        body.mimeType ||
        "image/jpeg"
    );

  // data:image/jpeg;base64,...
  const match = base64.match(
    /^data:(image\/[^;]+);base64,(.+)$/s
  );

  if (match) {
    ct = normalizeContentType(match[1]);
    base64 = match[2];
  }

  let binary: string;

  try {
    binary = atob(base64);
  } catch {
    throw new Error(
      "Invalid base64 image data."
    );
  }

  const bytes = new Uint8Array(
    binary.length
  );

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  if (!bytes.byteLength) {
    throw new Error(
      "The supplied image is empty."
    );
  }

  if (bytes.byteLength > 15 * 1024 * 1024) {
    throw new Error(
      "The image is too large. Maximum size is 15 MB."
    );
  }

  return {
    photo: {
      bytes: bytes.buffer,
      contentType: ct,
      fileName: safeFileName(
        body.fileName ||
          `photo.${extensionFor(ct)}`
      ),
    },
    location: cleanText(
      body.location,
      200
    ),
    inspector: cleanText(
      body.inspector,
      200
    ),
  };
}

async function runVisionAI(
  env: Env,
  image: ArrayBuffer,
  contentType: string,
  checks: SafetyCheck[]
): Promise<{
  parsed: AIResult | null;
  rawText: string;
}> {
  const imageData = dataUri(
    image,
    contentType
  );

  const prompt = buildPrompt(
    checks
  );

  let result: any;

  try {
    result = await env.AI.run(
      AI_MODEL,
      {
        prompt,
        image: imageData,

        max_tokens: 1400,
        temperature: 0.1,
        top_p: 0.8,

        response_format: {
          type: "json_schema",
          json_schema: {
            type: "object",
            properties: {
              summary: {
                type: "string",
              },
              findings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    category: {
                      type: "string",
                    },
                    title: {
                      type: "string",
                    },
                    observation: {
                      type: "string",
                    },
                    status: {
                      type: "string",
                      enum: [
                        "PASS",
                        "FAIL",
                        "CHECK_REQUIRED",
                      ],
                    },
                    risk_level: {
                      type: "string",
                      enum: [
                        "LOW",
                        "MEDIUM",
                        "HIGH",
                      ],
                    },
                    confidence: {
                      type: "number",
                    },
                    check_id: {
                      type: "string",
                    },
                  },
                  required: [
                    "category",
                    "title",
                    "observation",
                    "status",
                    "risk_level",
                    "confidence",
                    "check_id",
                  ],
                },
              },
            },
            required: [
              "summary",
              "findings",
            ],
          },
        },
      }
    );
  } catch (error) {
    throw new Error(
      `Workers AI request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const rawText = getAIResponseText(
    result
  );

  const parsed =
    parseAIResult(result) ||
    parseAIResult(rawText);

  return {
    parsed,
    rawText,
  };
}

async function insertInspection(
  env: Env,
  inspectionId: string,
  inspectionNo: string,
  location: string,
  inspector: string,
  createdAt: string
): Promise<void> {
  await env.SAFETY_DB
    .prepare(`
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
    `)
    .bind(
      inspectionId,
      inspectionNo,
      location || null,
      inspector || null,
      createdAt,
      "CHECK_REQUIRED"
    )
    .run();
}

async function insertPhoto(
  env: Env,
  photoId: string,
  inspectionId: string,
  objectKey: string,
  fileName: string,
  contentType: string,
  createdAt: string
): Promise<void> {
  await env.SAFETY_DB
    .prepare(`
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
    `)
    .bind(
      photoId,
      inspectionId,
      objectKey,
      fileName,
      contentType,
      createdAt
    )
    .run();
}

async function insertFindings(
  env: Env,
  findings: NormalizedFinding[]
): Promise<void> {
  if (!findings.length) {
    return;
  }

  const statements =
    findings.map((finding) =>
      env.SAFETY_DB
        .prepare(`
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
        `)
        .bind(
          finding.id,
          finding.inspection_id,
          finding.photo_id,
          finding.category,
          finding.title,
          finding.observation,
          finding.status,
          finding.risk_level,
          finding.confidence,
          finding.check_id,
          finding.source_title,
          finding.source_url,
          finding.created_at
        )
    );

  await env.SAFETY_DB.batch(
    statements
  );
}

async function updateInspectionResult(
  env: Env,
  inspectionId: string,
  result:
    | "PASS"
    | "ATTENTION"
    | "CHECK_REQUIRED"
): Promise<void> {
  await env.SAFETY_DB
    .prepare(`
      UPDATE inspections
      SET overall_result = ?
      WHERE id = ?
    `)
    .bind(
      result,
      inspectionId
    )
    .run();
}

async function handleAnalyze(
  request: Request,
  env: Env
): Promise<Response> {
  let parsedRequest:
    | {
        photo: RequestPhoto;
        location: string;
        inspector: string;
      }
    | undefined;

  let inspectionId = "";
  let photoId = "";
  let objectKey = "";

  try {
    // -------------------------------------------------------
    // 1. Receive image
    // -------------------------------------------------------
    parsedRequest =
      await parsePhotoRequest(
        request
      );

    const {
      photo,
      location,
      inspector,
    } = parsedRequest;

    // -------------------------------------------------------
    // 2. IDs
    // -------------------------------------------------------
    inspectionId = uuid();
    photoId = uuid();

    const now =
      new Date().toISOString();

    const inspectionNo =
      inspectionNumber();

    // -------------------------------------------------------
    // 3. IMPORTANT:
    // Generate the R2 object key HERE.
    //
    // The browser does NOT provide objectKey.
    // -------------------------------------------------------
    objectKey =
      `inspections/${inspectionId}/${photoId}.${extensionFor(
        photo.contentType
      )}`;

    // -------------------------------------------------------
    // 4. Save inspection first
    // -------------------------------------------------------
    await insertInspection(
      env,
      inspectionId,
      inspectionNo,
      location,
      inspector,
      now
    );

    // -------------------------------------------------------
    // 5. Existing R2 bucket.
    // NO CHANGE to PHOTOS binding.
    // -------------------------------------------------------
    await env.PHOTOS.put(
      objectKey,
      photo.bytes,
      {
        httpMetadata: {
          contentType:
            photo.contentType,
          contentDisposition:
            `inline; filename="${photo.fileName}"`,
        },
        customMetadata: {
          inspectionId,
          photoId,
          inspectionNo,
          location: location || "",
          inspector: inspector || "",
        },
      }
    );

    // -------------------------------------------------------
    // 6. Save R2 object key to inspection_photos.
    //
    // This fixes:
    // NOT NULL constraint failed:
    // inspection_photos.object_key
    // -------------------------------------------------------
    await insertPhoto(
      env,
      photoId,
      inspectionId,
      objectKey,
      photo.fileName,
      photo.contentType,
      now
    );

    // -------------------------------------------------------
    // 7. Get WSH checks
    // -------------------------------------------------------
    const checks =
      await getSafetyChecks(
        env
      );

    // -------------------------------------------------------
    // 8. Run vision AI
    // -------------------------------------------------------
    const ai =
      await runVisionAI(
        env,
        photo.bytes,
        photo.contentType,
        checks
      );

    // -------------------------------------------------------
    // 9. Parse AI response
    // -------------------------------------------------------
    if (!ai.parsed) {
      await updateInspectionResult(
        env,
        inspectionId,
        "CHECK_REQUIRED"
      );

      return json(
        {
          ok: false,
          inspectionId,
          inspectionNo,
          photoId,
          objectKey,
          error:
            "Workers AI did not return valid JSON.",
          modelResponse:
            ai.rawText.substring(
              0,
              5000
            ),
        },
        502
      );
    }

    const aiFindings =
      Array.isArray(
        ai.parsed.findings
      )
        ? ai.parsed.findings
        : [];

    // -------------------------------------------------------
    // 10. Normalize and connect to WSH checks
    // -------------------------------------------------------
    const findings =
      normalizeFindings(
        aiFindings,
        inspectionId,
        photoId,
        checks
      );

    // -------------------------------------------------------
    // 11. Save findings
    // -------------------------------------------------------
    await insertFindings(
      env,
      findings
    );

    // -------------------------------------------------------
    // 12. Calculate overall result
    // -------------------------------------------------------
    const result =
      overallResult(
        findings
      );

    await updateInspectionResult(
      env,
      inspectionId,
      result
    );

    // -------------------------------------------------------
    // 13. Return clean response to frontend
    // -------------------------------------------------------
    return json({
      ok: true,

      inspection: {
        id: inspectionId,
        inspection_no:
          inspectionNo,
        location:
          location || "",
        inspector:
          inspector || "",
        overall_result:
          result,
        created_at: now,
      },

      photo: {
        id: photoId,
        object_key:
          objectKey,
        file_name:
          photo.fileName,
        content_type:
          photo.contentType,
      },

      summary:
        ai.parsed.summary ||
        buildSummary(findings),

      findings,

      counts: {
        total: findings.length,
        pass: findings.filter(
          (f) => f.status === "PASS"
        ).length,
        fail: findings.filter(
          (f) => f.status === "FAIL"
        ).length,
        check_required:
          findings.filter(
            (f) =>
              f.status ===
              "CHECK_REQUIRED"
          ).length,
      },

      message:
        "Analysis completed.",
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    // -------------------------------------------------------
    // Best-effort cleanup if R2 upload succeeded but
    // something later failed.
    // -------------------------------------------------------
    if (objectKey) {
      try {
        await env.PHOTOS.delete(
          objectKey
        );
      } catch {
        // Ignore cleanup failure.
      }
    }

    return json(
      {
        ok: false,
        error: message,
        inspectionId:
          inspectionId || null,
        photoId:
          photoId || null,
      },
      500
    );
  }
}

async function getRecentInspections(
  env: Env
): Promise<Response> {
  try {
    const result =
      await env.SAFETY_DB
        .prepare(`
          SELECT
            i.id,
            i.inspection_no,
            i.location,
            i.inspector,
            i.created_at,
            i.overall_result
          FROM inspections i
          ORDER BY i.created_at DESC
          LIMIT 20
        `)
        .all();

    return json({
      ok: true,
      inspections:
        result.results || [],
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
        inspections: [],
      },
      500
    );
  }
}

async function getInspection(
  env: Env,
  inspectionId: string
): Promise<Response> {
  try {
    const inspection =
      await env.SAFETY_DB
        .prepare(`
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
        `)
        .bind(inspectionId)
        .first();

    if (!inspection) {
      return json(
        {
          ok: false,
          error:
            "Inspection not found.",
        },
        404
      );
    }

    const photos =
      await env.SAFETY_DB
        .prepare(`
          SELECT
            id,
            inspection_id,
            object_key,
            file_name,
            content_type,
            created_at
          FROM inspection_photos
          WHERE inspection_id = ?
          ORDER BY created_at
        `)
        .bind(inspectionId)
        .all();

    const findings =
      await env.SAFETY_DB
        .prepare(`
          SELECT
            f.id,
            f.inspection_id,
            f.photo_id,
            f.category,
            f.title,
            f.observation,
            f.status,
            f.risk_level,
            f.confidence,
            f.check_id,
            f.source_title,
            f.source_url,
            f.created_at
          FROM findings f
          WHERE f.inspection_id = ?
          ORDER BY f.created_at
        `)
        .bind(inspectionId)
        .all();

    return json({
      ok: true,
      inspection,
      photos:
        photos.results || [],
      findings:
        findings.results || [],
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}

async function getStats(
  env: Env
): Promise<Response> {
  try {
    const inspections =
      await env.SAFETY_DB
        .prepare(`
          SELECT COUNT(*) AS count
          FROM inspections
        `)
        .first<{ count: number }>();

    const attention =
      await env.SAFETY_DB
        .prepare(`
          SELECT COUNT(*) AS count
          FROM inspections
          WHERE overall_result = 'ATTENTION'
        `)
        .first<{ count: number }>();

    const checkRequired =
      await env.SAFETY_DB
        .prepare(`
          SELECT COUNT(*) AS count
          FROM inspections
          WHERE overall_result = 'CHECK_REQUIRED'
        `)
        .first<{ count: number }>();

    const failFindings =
      await env.SAFETY_DB
        .prepare(`
          SELECT COUNT(*) AS count
          FROM findings
          WHERE status = 'FAIL'
        `)
        .first<{ count: number }>();

    return json({
      ok: true,
      stats: {
        inspections:
          Number(
            inspections?.count || 0
          ),
        attention:
          Number(
            attention?.count || 0
          ),
        check_required:
          Number(
            checkRequired?.count || 0
          ),
        fail_findings:
          Number(
            failFindings?.count || 0
          ),
      },
    });
  } catch (error) {
    return json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}

async function serveR2Photo(
  env: Env,
  objectKey: string
): Promise<Response> {
  try {
    const object =
      await env.PHOTOS.get(
        objectKey
      );

    if (!object) {
      return text(
        "Photo not found.",
        404
      );
    }

    const headers =
      new Headers();

    object.writeHttpMetadata(
      headers
    );

    headers.set(
      "etag",
      object.httpEtag
    );

    headers.set(
      "cache-control",
      "public, max-age=31536000, immutable"
    );

    return new Response(
      object.body,
      {
        status: 200,
        headers,
      }
    );
  } catch (error) {
    return text(
      error instanceof Error
        ? error.message
        : String(error),
      500
    );
  }
}

async function handleApi(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const pathname =
    url.pathname;

  // ---------------------------------------------------------
  // POST /api/analyze
  // ---------------------------------------------------------
  if (
    request.method === "POST" &&
    pathname === "/api/analyze"
  ) {
    return handleAnalyze(
      request,
      env
    );
  }

  // ---------------------------------------------------------
  // GET /api/inspections
  // ---------------------------------------------------------
  if (
    request.method === "GET" &&
    pathname === "/api/inspections"
  ) {
    return getRecentInspections(
      env
    );
  }

  // ---------------------------------------------------------
  // GET /api/inspection/:id
  // ---------------------------------------------------------
  if (
    request.method === "GET" &&
    pathname.startsWith(
      "/api/inspection/"
    )
  ) {
    const id =
      pathname.substring(
        "/api/inspection/".length
      );

    if (!id) {
      return json(
        {
          ok: false,
          error:
            "Missing inspection ID.",
        },
        400
      );
    }

    return getInspection(
      env,
      id
    );
  }

  // ---------------------------------------------------------
  // GET /api/stats
  // ---------------------------------------------------------
  if (
    request.method === "GET" &&
    pathname === "/api/stats"
  ) {
    return getStats(env);
  }

  // ---------------------------------------------------------
  // GET /api/photo?key=...
  // ---------------------------------------------------------
  if (
    request.method === "GET" &&
    pathname === "/api/photo"
  ) {
    const key =
      url.searchParams.get(
        "key"
      );

    if (!key) {
      return text(
        "Missing photo key.",
        400
      );
    }

    return serveR2Photo(
      env,
      key
    );
  }

  return json(
    {
      ok: false,
      error: "API endpoint not found.",
    },
    404
  );
}

function htmlFallback(): Response {
  return new Response(
    `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Safety Inspection AI</title>
</head>
<body>
<h1>Safety Inspection AI</h1>
<p>Web application is available.</p>
</body>
</html>`,
    {
      status: 200,
      headers: {
        "content-type":
          "text/html; charset=UTF-8",
        "cache-control":
          "no-store",
      },
    }
  );
}

export default {
  async fetch(
    request: Request,
    env: Env
  ): Promise<Response> {
    try {
      if (
        request.method === "OPTIONS"
      ) {
        return withCors(
          new Response(null, {
            status: 204,
            headers:
              corsHeaders(),
          })
        );
      }

      const url =
        new URL(request.url);

      // -----------------------------------------------------
      // API
      // -----------------------------------------------------
      if (
        url.pathname.startsWith(
          "/api/"
        )
      ) {
        return withCors(
          await handleApi(
            request,
            env,
            url
          )
        );
      }

      // -----------------------------------------------------
      // Let Cloudflare Assets serve index.html, CSS, JS etc.
      //
      // This is important because your wrangler.toml has:
      //
      // [assets]
      // directory = "./public"
      // -----------------------------------------------------
      const assetResponse =
        await env.ASSETS?.fetch(
          request
        );

      if (assetResponse) {
        return assetResponse;
      }

      return htmlFallback();
    } catch (error) {
      return withCors(
        json(
          {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
          500
        )
      );
    }
  },
} satisfies ExportedHandler<Env>;
