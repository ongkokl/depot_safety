export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
}

/* =========================================================
   CONFIGURATION
   ========================================================= */

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AI_OUTPUT = 1200;

const ALLOWED_CATEGORIES = [
  "PPE",
  "Housekeeping",
  "Vehicular Safety",
  "Work at Height",
  "Lifting",
  "Electrical Safety",
  "Fire Safety",
  "Storage",
  "Other",
] as const;

type Category = (typeof ALLOWED_CATEGORIES)[number];

type FindingStatus =
  | "PASS"
  | "CHECK_REQUIRED"
  | "FAIL";

type RiskLevel =
  | "LOW"
  | "MEDIUM"
  | "HIGH";

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
  id?: string;
  inspection_id?: string;
  photo_id?: string;
  category: Category;
  title: string;
  observation: string;
  status: FindingStatus;
  risk_level: RiskLevel;
  confidence: number;
  check_id?: string | null;
  source_title?: string | null;
  source_url?: string | null;
}

interface AIResult {
  summary?: string;
  findings?: unknown[];
}

interface AnalyzeRequest {
  image?: string;
  imageBase64?: string;
  mimeType?: string;
  location?: string;
  inspector?: string;
  objectKey?: string;
  photoId?: string;
}

/* =========================================================
   BASIC HELPERS
   ========================================================= */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanText(value: unknown, max = 4000): string {
  return text(value)
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, max);
}

function makeId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

  return `${prefix}-${random}`;
}

function inspectionNumber(): string {
  const now = new Date();

  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");

  return `SI-${yyyy}${mm}${dd}-${Math.random()
    .toString(16)
    .slice(2, 8)
    .toUpperCase()}`;
}

function clampConfidence(value: unknown): number {
  let n = Number(value);

  if (!Number.isFinite(n)) {
    return 0.5;
  }

  if (n > 1) {
    n = n / 100;
  }

  if (n < 0) n = 0;
  if (n > 1) n = 1;

  return Math.round(n * 100) / 100;
}

function confidencePercent(value: number): number {
  return Math.round(clampConfidence(value) * 100);
}

function normalizeCategory(value: unknown): Category {
  const s = text(value).toLowerCase();

  if (s.includes("ppe") || s.includes("personal protective")) {
    return "PPE";
  }

  if (
    s.includes("house") ||
    s.includes("clean") ||
    s.includes("spill") ||
    s.includes("slip")
  ) {
    return "Housekeeping";
  }

  if (
    s.includes("vehicle") ||
    s.includes("traffic") ||
    s.includes("truck") ||
    s.includes("pedestrian")
  ) {
    return "Vehicular Safety";
  }

  if (
    s.includes("height") ||
    s.includes("guardrail") ||
    s.includes("guard rail") ||
    s.includes("fall") ||
    s.includes("ladder") ||
    s.includes("scaffold")
  ) {
    return "Work at Height";
  }

  if (
    s.includes("lifting") ||
    s.includes("crane") ||
    s.includes("suspended load") ||
    s.includes("rigging") ||
    s.includes("hoist")
  ) {
    return "Lifting";
  }

  if (
    s.includes("electrical") ||
    s.includes("cable") ||
    s.includes("wire") ||
    s.includes("socket") ||
    s.includes("power")
  ) {
    return "Electrical Safety";
  }

  if (
    s.includes("fire") ||
    s.includes("extinguisher") ||
    s.includes("flammable") ||
    s.includes("smoke")
  ) {
    return "Fire Safety";
  }

  if (
    s.includes("storage") ||
    s.includes("stack") ||
    s.includes("stored") ||
    s.includes("material")
  ) {
    return "Storage";
  }

  return "Other";
}

function normalizeStatus(value: unknown): FindingStatus {
  const s = text(value)
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (
    s === "PASS" ||
    s === "SAFE" ||
    s === "COMPLIANT" ||
    s === "OK"
  ) {
    return "PASS";
  }

  if (
    s === "FAIL" ||
    s === "UNSAFE" ||
    s === "NON_COMPLIANT" ||
    s === "NONCOMPLIANT"
  ) {
    return "FAIL";
  }

  return "CHECK_REQUIRED";
}

function normalizeRisk(
  value: unknown,
  status: FindingStatus
): RiskLevel {
  const s = text(value).toUpperCase();

  if (s.includes("HIGH")) {
    return "HIGH";
  }

  if (s.includes("LOW")) {
    return "LOW";
  }

  if (s.includes("MEDIUM")) {
    return "MEDIUM";
  }

  if (status === "FAIL") {
    return "HIGH";
  }

  if (status === "PASS") {
    return "LOW";
  }

  return "MEDIUM";
}

/* =========================================================
   IMAGE HELPERS
   ========================================================= */

function removeDataPrefix(value: string): string {
  const comma = value.indexOf(",");

  if (
    value.startsWith("data:") &&
    comma >= 0
  ) {
    return value.slice(comma + 1);
  }

  return value;
}

function estimateBase64Bytes(base64: string): number {
  const clean = base64.replace(/\s/g, "");

  if (!clean) {
    return 0;
  }

  let padding = 0;

  if (clean.endsWith("==")) {
    padding = 2;
  } else if (clean.endsWith("=")) {
    padding = 1;
  }

  return Math.floor((clean.length * 3) / 4) - padding;
}

function normalizeImageInput(
  image: unknown,
  mimeType?: string
): string {
  if (typeof image !== "string") {
    throw new Error("No image was supplied.");
  }

  let value = image.trim();

  if (!value) {
    throw new Error("The image is empty.");
  }

  /*
   * The frontend may send either:
   *
   * data:image/jpeg;base64,/9j/...
   *
   * or:
   *
   * /9j/...
   */

  if (value.startsWith("data:")) {
    const bytes = estimateBase64Bytes(
      removeDataPrefix(value)
    );

    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error("Image is larger than 8 MB.");
    }

    return value;
  }

  const clean = removeDataPrefix(value);

  const bytes = estimateBase64Bytes(clean);

  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error("Image is larger than 8 MB.");
  }

  const type =
    mimeType && mimeType.startsWith("image/")
      ? mimeType
      : "image/jpeg";

  return `data:${type};base64,${clean}`;
}

/* =========================================================
   SAFETY CHECK DATABASE
   ========================================================= */

async function loadSafetyChecks(
  db: D1Database
): Promise<SafetyCheck[]> {
  try {
    const result = await db
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
        LIMIT 100
        `
      )
      .run<SafetyCheck>();

    return result.results || [];
  } catch (error) {
    console.error("Unable to load safety_checks:", error);

    return [];
  }
}

/* =========================================================
   BUILD AI PROMPT
   ========================================================= */

function buildSafetyCheckContext(
  checks: SafetyCheck[]
): string {
  if (!checks.length) {
    return `
No safety_checks records are currently available.

Do not invent WSH source information.
If a finding cannot be mapped to a known check, use
category "Other" and leave check_id/source information empty.
`;
  }

  return checks
    .map((check) => {
      return `
CHECK_ID: ${check.id}
CATEGORY: ${cleanText(check.category, 100)}
QUESTION: ${cleanText(check.check_question, 500)}
GUIDANCE: ${cleanText(check.guidance, 800)}
SOURCE_TITLE: ${cleanText(check.source_title, 200)}
SOURCE_URL: ${cleanText(check.source_url, 500)}
KEYWORDS: ${cleanText(check.keywords, 300)}
`;
    })
    .join("\n---\n");
}

function buildPrompt(
  checks: SafetyCheck[]
): string {
  return `
You are a workplace safety visual inspection assistant.

Analyze ONLY what is visibly supported by the photograph.

This is a Singapore workplace safety inspection.
The inspection uses the supplied WSH safety checks as the authoritative
source for check questions and source information.

IMPORTANT RULES:

1. Do not invent hazards.
2. Do not assume an activity is happening merely because equipment exists
   somewhere in the background.
3. Do not create a finding for a category that cannot reasonably be assessed
   from the photograph.
4. If PPE is clearly visible, it can be assessed.
5. If a person is clearly near an exposed edge, guardrail, ladder,
   scaffold or elevated platform, Work at Height may be assessed.
6. If a person appears exposed to a suspended load or active lifting activity,
   Lifting may be assessed.
7. If vehicle/pedestrian routes are visible, Vehicular Safety may be assessed.
8. If the floor/work area is visible, Housekeeping may be assessed.
9. If electrical equipment, cables, sockets or electrical hazards are visible,
   Electrical Safety may be assessed.
10. If fire equipment, smoke, flames or obvious fire hazards are visible,
    Fire Safety may be assessed.
11. If materials/containers are visibly stacked or stored, Storage may be
    assessed.
12. Do NOT report "not visible" categories as CHECK_REQUIRED findings.
13. PASS means the visible condition appears satisfactory.
14. CHECK_REQUIRED means something relevant is visible but cannot be
    confidently determined from the photograph.
15. FAIL means a visible unsafe condition is reasonably clear.
16. Never use 100% confidence unless the evidence is exceptionally clear.
17. Normal confidence should generally be between 0.60 and 0.95.
18. Confidence must describe confidence in the visual observation, not
    confidence in legal compliance.
19. A clean area should normally be PASS / LOW.
20. Clearly visible required PPE should normally be PASS / LOW.
21. A possible hazard that requires physical verification should normally be
    CHECK_REQUIRED / MEDIUM.
22. A clear serious visible hazard should normally be FAIL / HIGH.

Return JSON only if possible.

The JSON should have this structure:

{
  "summary": "short description of the visible workplace scene",
  "findings": [
    {
      "category": "PPE",
      "title": "short meaningful title",
      "observation": "what is actually visible",
      "status": "PASS",
      "risk_level": "LOW",
      "confidence": 0.85,
      "check_id": "matching check id or null"
    }
  ]
}

Only return actual visible findings.

Do not include markdown.
Do not include explanations outside the JSON.

AVAILABLE WSH SAFETY CHECKS:

${buildSafetyCheckContext(checks)}
`;
}

/* =========================================================
   AI CALL
   ========================================================= */

async function runVisionAI(
  env: Env,
  imageDataUrl: string,
  checks: SafetyCheck[]
): Promise<string> {
  const prompt = buildPrompt(checks);

  /*
   * Cloudflare's current Llama 3.2 Vision API accepts:
   *
   * {
   *   prompt,
   *   image: "data:image/jpeg;base64,..."
   * }
   *
   * We intentionally use this form instead of sending an invalid
   * nested content array.
   */

  const result = await env.AI.run(
    MODEL,
    {
      prompt,
      image: imageDataUrl,
      max_tokens: MAX_AI_OUTPUT,
      temperature: 0.1,
      top_p: 0.9,
    } as any
  );

  const response =
    typeof result === "string"
      ? result
      : (result as any)?.response ??
        (result as any)?.result ??
        "";

  if (!response) {
    throw new Error(
      "Workers AI returned an empty response."
    );
  }

  return String(response).trim();
}

/* =========================================================
   JSON EXTRACTION
   ========================================================= */

function stripMarkdownCodeFence(
  value: string
): string {
  return value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonObject(
  value: string
): unknown | null {
  const cleaned =
    stripMarkdownCodeFence(value);

  try {
    return JSON.parse(cleaned);
  } catch {
    // Continue.
  }

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");

  if (first >= 0 && last > first) {
    const candidate =
      cleaned.slice(first, last + 1);

    try {
      return JSON.parse(candidate);
    } catch {
      // Continue.
    }
  }

  return null;
}

/* =========================================================
   TEXT RESPONSE PARSER
   ========================================================= */

function splitModelText(
  value: string
): string[] {
  return value
    .split(/\n(?=\s*(?:[-*•]|\d+[.)])\s*)/g)
    .map((x) => x.trim())
    .filter(Boolean);
}

function inferStatusFromObservation(
  observation: string
): FindingStatus {
  const s = observation.toLowerCase();

  const failWords = [
    "no safety vest",
    "no hard hat",
    "without ppe",
    "missing ppe",
    "unsafe",
    "poor housekeeping",
    "spill",
    "oil spill",
    "blocked",
    "obstruction",
    "unguarded",
    "no guardrail",
    "missing guardrail",
    "exposed to suspended",
    "suspended load above",
    "damaged cable",
    "exposed wire",
    "fire",
    "smoke",
  ];

  for (const word of failWords) {
    if (s.includes(word)) {
      return "FAIL";
    }
  }

  const passWords = [
    "clean",
    "free of clutter",
    "no visible spill",
    "no visible hazard",
    "wearing a safety vest",
    "wearing a hard hat",
    "wearing appropriate ppe",
    "clearly segregated",
    "properly stored",
    "secure",
    "safe",
    "satisfactory",
  ];

  for (const word of passWords) {
    if (s.includes(word)) {
      return "PASS";
    }
  }

  return "CHECK_REQUIRED";
}

function inferRiskFromStatus(
  status: FindingStatus,
  observation: string
): RiskLevel {
  if (status === "FAIL") {
    const s = observation.toLowerCase();

    const serious = [
      "suspended load",
      "fall",
      "unguarded edge",
      "no guardrail",
      "electrical",
      "fire",
      "vehicle",
      "crane",
    ];

    if (
      serious.some((word) =>
        s.includes(word)
      )
    ) {
      return "HIGH";
    }

    return "MEDIUM";
  }

  if (status === "PASS") {
    return "LOW";
  }

  return "MEDIUM";
}

function parseTextFinding(
  line: string
): Finding | null {
  let raw = line
    .replace(/^[-*•]\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .trim();

  if (!raw) {
    return null;
  }

  const category =
    normalizeCategory(raw);

  /*
   * Skip generic model prose that isn't actually
   * a useful finding.
   */

  if (
    raw.length < 20 ||
    /^overall\b/i.test(raw) ||
    /^the image\b/i.test(raw)
  ) {
    return null;
  }

  const status =
    inferStatusFromObservation(raw);

  const risk =
    inferRiskFromStatus(status, raw);

  return {
    category,
    title:
      category === "Other"
        ? "Safety observation"
        : `${category} observation`,
    observation: cleanText(raw, 1000),
    status,
    risk_level: risk,
    confidence: 0.6,
    check_id: null,
    source_title: null,
    source_url: null,
  };
}

/* =========================================================
   PARSE AI RESPONSE
   ========================================================= */

function parseAIResponse(
  response: string
): AIResult {
  const parsed =
    extractJsonObject(response);

  if (parsed && typeof parsed === "object") {
    const obj = parsed as any;

    if (Array.isArray(obj.findings)) {
      return {
        summary:
          typeof obj.summary === "string"
            ? obj.summary
            : "",
        findings: obj.findings,
      };
    }

    /*
     * Some model responses return:
     *
     * {
     *   category: ...
     * }
     *
     * instead of wrapping it in findings.
     */

    if (
      obj.category ||
      obj.observation ||
      obj.title
    ) {
      return {
        summary: "",
        findings: [obj],
      };
    }
  }

  /*
   * IMPORTANT:
   *
   * Do not fail just because Llama returned normal prose.
   *
   * The model has already analyzed the photograph.
   * We convert useful prose into findings locally.
   */

  const lines =
    splitModelText(response);

  const findings =
    lines
      .map(parseTextFinding)
      .filter(
        (x): x is Finding => x !== null
      );

  if (!findings.length) {
    return {
      summary: cleanText(response, 1200),
      findings: [],
    };
  }

  return {
    summary: "",
    findings,
  };
}

/* =========================================================
   MATCH FINDING TO WSH CHECK
   ========================================================= */

function scoreCheck(
  finding: Finding,
  check: SafetyCheck
): number {
  let score = 0;

  const category =
    finding.category.toLowerCase();

  const checkCategory =
    check.category.toLowerCase();

  if (
    category === checkCategory
  ) {
    score += 10;
  }

  const combined =
    `${finding.title} ${finding.observation}`
      .toLowerCase();

  const keywords =
    cleanText(check.keywords, 500)
      .toLowerCase()
      .split(/[,\s;|]+/)
      .filter((x) => x.length >= 3);

  for (const keyword of keywords) {
    if (combined.includes(keyword)) {
      score += 2;
    }
  }

  return score;
}

function matchSafetyCheck(
  finding: Finding,
  checks: SafetyCheck[]
): SafetyCheck | null {
  const categoryChecks =
    checks.filter(
      (check) =>
        check.category.toLowerCase() ===
        finding.category.toLowerCase()
    );

  if (!categoryChecks.length) {
    return null;
  }

  let best: SafetyCheck | null = null;
  let bestScore = 0;

  for (const check of categoryChecks) {
    const score =
      scoreCheck(finding, check);

    if (score > bestScore) {
      bestScore = score;
      best = check;
    }
  }

  /*
   * Category match alone is enough to associate a
   * known safety check, but never invent one.
   */

  return best || categoryChecks[0];
}

/* =========================================================
   CLEAN / NORMALIZE FINDINGS
   ========================================================= */

function cleanFinding(
  raw: any,
  checks: SafetyCheck[]
): Finding | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const observation =
    cleanText(
      raw.observation ??
      raw.description ??
      raw.finding ??
      raw.text ??
      "",
      1200
    );

  if (!observation) {
    return null;
  }

  const category =
    normalizeCategory(
      raw.category ??
      raw.type ??
      raw.title ??
      observation
    );

  let status =
    normalizeStatus(
      raw.status ??
      raw.result ??
      raw.compliance
    );

  /*
   * If the model did not provide a useful status,
   * infer one from the observation.
   */

  if (
    !raw.status &&
    !raw.result &&
    !raw.compliance
  ) {
    status =
      inferStatusFromObservation(
        observation
      );
  }

  let risk =
    normalizeRisk(
      raw.risk_level ??
      raw.risk ??
      raw.riskLevel,
      status
    );

  /*
   * Correct obviously contradictory combinations.
   */

  if (
    status === "PASS" &&
    risk === "HIGH"
  ) {
    risk = "LOW";
  }

  if (
    status === "FAIL" &&
    risk === "LOW"
  ) {
    risk = "MEDIUM";
  }

  let confidence =
    clampConfidence(
      raw.confidence ??
      raw.confidence_score ??
      raw.score
    );

  /*
   * Never manufacture 100% confidence.
   */

  if (
    raw.confidence === undefined &&
    raw.confidence_score === undefined &&
    raw.score === undefined
  ) {
    confidence = 0.6;
  }

  const title =
    cleanText(
      raw.title ??
      raw.name ??
      `${category} observation`,
      300
    );

  const finding: Finding = {
    category,
    title:
      title || "Safety observation",
    observation,
    status,
    risk_level: risk,
    confidence,
    check_id: null,
    source_title: null,
    source_url: null,
  };

  const matched =
    matchSafetyCheck(
      finding,
      checks
    );

  if (matched) {
    finding.check_id =
      matched.id;

    finding.source_title =
      matched.source_title;

    finding.source_url =
      matched.source_url;
  }

  /*
   * Do not fabricate a WSH check for "Other".
   */

  return finding;
}

/* =========================================================
   REMOVE DUPLICATES
   ========================================================= */

function deduplicateFindings(
  findings: Finding[]
): Finding[] {
  const seen =
    new Set<string>();

  const result: Finding[] = [];

  for (const finding of findings) {
    const key =
      `${finding.category}|${finding.title}|${finding.observation}`
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(finding);
  }

  return result.slice(0, 12);
}

/* =========================================================
   OVERALL RESULT
   ========================================================= */

function calculateOverallResult(
  findings: Finding[]
): "PASS" | "ATTENTION" | "CHECK_REQUIRED" {
  if (!findings.length) {
    return "CHECK_REQUIRED";
  }

  if (
    findings.some(
      (f) => f.status === "FAIL"
    )
  ) {
    return "ATTENTION";
  }

  if (
    findings.some(
      (f) =>
        f.status ===
        "CHECK_REQUIRED"
    )
  ) {
    return "CHECK_REQUIRED";
  }

  return "PASS";
}

function buildSummary(
  findings: Finding[]
): string {
  if (!findings.length) {
    return "No structured safety findings could be established from the photograph.";
  }

  const fail =
    findings.filter(
      (f) => f.status === "FAIL"
    ).length;

  const check =
    findings.filter(
      (f) =>
        f.status ===
        "CHECK_REQUIRED"
    ).length;

  const pass =
    findings.filter(
      (f) => f.status === "PASS"
    ).length;

  if (fail > 0) {
    return `${fail} visible safety finding(s) require corrective attention. ${check} finding(s) require verification and ${pass} visible condition(s) appear satisfactory.`;
  }

  if (check > 0) {
    return `${pass} visible condition(s) appear satisfactory. ${check} finding(s) require physical/site verification.`;
  }

  return `${pass} visible safety condition(s) appear satisfactory based on the photograph.`;
}

/* =========================================================
   D1: CREATE INSPECTION
   ========================================================= */

async function createInspection(
  db: D1Database,
  location: string,
  inspector: string
): Promise<{
  id: string;
  inspectionNo: string;
}> {
  const id =
    makeId("inspection");

  const inspectionNo =
    inspectionNumber();

  const createdAt =
    new Date().toISOString();

  await db
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
      id,
      inspectionNo,
      location || null,
      inspector || null,
      createdAt,
      "CHECK_REQUIRED"
    )
    .run();

  return {
    id,
    inspectionNo,
  };
}

/* =========================================================
   D1: SAVE PHOTO
   ========================================================= */

async function saveInspectionPhoto(
  db: D1Database,
  inspectionId: string,
  objectKey: string,
  fileName: string,
  contentType: string
): Promise<string> {
  const photoId =
    makeId("photo");

  const createdAt =
    new Date().toISOString();

  /*
   * IMPORTANT:
   *
   * inspection_photos.object_key is NOT NULL.
   *
   * Therefore this function NEVER inserts null.
   *
   * We do not alter the existing R2 storage implementation.
   * We simply make sure the database receives the same object
   * key supplied by the existing upload flow.
   */

  const safeObjectKey =
    cleanText(objectKey, 1000);

  if (!safeObjectKey) {
    throw new Error(
      "No R2 object key was supplied for the inspection photo."
    );
  }

  await db
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
      safeObjectKey,
      fileName || "inspection-photo.jpg",
      contentType || "image/jpeg",
      createdAt
    )
    .run();

  return photoId;
}

/* =========================================================
   D1: SAVE FINDINGS
   ========================================================= */

async function saveFindings(
  db: D1Database,
  inspectionId: string,
  photoId: string,
  findings: Finding[]
): Promise<void> {
  if (!findings.length) {
    return;
  }

  const statements =
    findings.map((finding) => {
      const id =
        makeId("finding");

      return db
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
          id,
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
          new Date().toISOString()
        );
    });

  await db.batch(statements);
}

/* =========================================================
   D1: UPDATE OVERALL RESULT
   ========================================================= */

async function updateInspectionResult(
  db: D1Database,
  inspectionId: string,
  overallResult:
    | "PASS"
    | "ATTENTION"
    | "CHECK_REQUIRED"
): Promise<void> {
  await db
    .prepare(
      `
      UPDATE inspections
      SET overall_result = ?
      WHERE id = ?
      `
    )
    .bind(
      overallResult,
      inspectionId
    )
    .run();
}

/* =========================================================
   R2 OBJECT KEY HANDLING
   ========================================================= */

function getObjectKeyFromRequest(
  body: AnalyzeRequest
): string {
  /*
   * Preserve the existing R2 upload flow.
   *
   * The frontend may already provide:
   *   objectKey
   *
   * We do not upload or transform the image here.
   */

  return cleanText(
    body.objectKey,
    1000
  );
}

/* =========================================================
   ANALYSE PHOTO
   ========================================================= */

async function analysePhoto(
  request: Request,
  env: Env
): Promise<Response> {
  let body: AnalyzeRequest;

  try {
    body =
      (await request.json()) as AnalyzeRequest;
  } catch {
    return json(
      {
        ok: false,
        error:
          "Invalid JSON request body.",
      },
      400
    );
  }

  try {
    const image =
      body.image ??
      body.imageBase64;

    const imageDataUrl =
      normalizeImageInput(
        image,
        body.mimeType
      );

    const location =
      cleanText(body.location, 300);

    const inspector =
      cleanText(body.inspector, 300);

    /*
     * Existing R2 flow:
     *
     * The frontend/upload process should provide
     * objectKey. We don't change how the image is stored.
     */

  

    /*
     * Load the authoritative WSH checks.
     */

    const checks =
      await loadSafetyChecks(
        env.SAFETY_DB
      );

    /*
     * Run vision AI once.
     *
     * Keeping this to one call helps reduce
     * Worker CPU/memory consumption.
     */

    const aiText =
      await runVisionAI(
        env,
        imageDataUrl,
        checks
      );

    /*
     * Parse JSON or natural language.
     */

    const parsed =
      parseAIResponse(aiText);

    const rawFindings =
      Array.isArray(parsed.findings)
        ? parsed.findings
        : [];

    const cleanedFindings =
      rawFindings
        .map((item) =>
          cleanFinding(
            item,
            checks
          )
        )
        .filter(
          (item): item is Finding =>
            item !== null
        );

    const findings =
      deduplicateFindings(
        cleanedFindings
      );

    const overall =
      calculateOverallResult(
        findings
      );

    const summary =
      parsed.summary ||
      buildSummary(findings);

    /*
     * Create D1 inspection.
     */

    const inspection =
      await createInspection(
        env.SAFETY_DB,
        location,
        inspector
      );

    /*
     * Save photo record.
     *
     * No changes to R2 storage itself.
     */

    const fileName =
      body.objectKey
        ? body.objectKey.split("/").pop() ||
          "inspection-photo.jpg"
        : "inspection-photo.jpg";

    const photoId =
      await saveInspectionPhoto(
        env.SAFETY_DB,
        inspection.id,
        objectKey,
        fileName,
        body.mimeType ||
          "image/jpeg"
      );

    /*
     * Save findings.
     */

    await saveFindings(
      env.SAFETY_DB,
      inspection.id,
      photoId,
      findings
    );

    /*
     * Update inspection overall result.
     */

    await updateInspectionResult(
      env.SAFETY_DB,
      inspection.id,
      overall
    );

    return json({
      ok: true,

      inspection: {
        id: inspection.id,
        inspection_no:
          inspection.inspectionNo,
        location,
        inspector,
        overall_result: overall,
        summary,
      },

      photo: {
        id: photoId,
        object_key: objectKey,
      },

      findings,

      ai: {
        model: MODEL,
        parsed_as:
          extractJsonObject(aiText)
            ? "json"
            : "text",
      },
    });
  } catch (error) {
    console.error(
      "analysePhoto error:",
      error
    );

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return json(
      {
        ok: false,
        error:
          `Workers AI analysis failed. ${message}`,
      },
      500
    );
  }
}

/* =========================================================
   GET INSPECTION
   ========================================================= */

async function getInspection(
  db: D1Database,
  inspectionId: string
): Promise<Response> {
  const inspection =
    await db
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
    await db
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
      .bind(inspectionId)
      .all();

  const findings =
    await db
      .prepare(
        `
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
          f.created_at,
          sc.check_question,
          sc.guidance
        FROM findings f
        LEFT JOIN safety_checks sc
          ON sc.id = f.check_id
        WHERE f.inspection_id = ?
        ORDER BY f.created_at ASC
        `
      )
      .bind(inspectionId)
      .all();

  return json({
    ok: true,
    inspection,
    photos: photos.results || [],
    findings: findings.results || [],
  });
}

/* =========================================================
   RECENT INSPECTIONS
   ========================================================= */

async function recentInspections(
  db: D1Database
): Promise<Response> {
  const inspections =
    await db
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
        LIMIT 20
        `
      )
      .all();

  const counts =
    await db
      .prepare(
        `
        SELECT
          COUNT(*) AS inspections,
          SUM(
            CASE
              WHEN overall_result = 'ATTENTION'
              THEN 1
              ELSE 0
            END
          ) AS attention,
          SUM(
            CASE
              WHEN overall_result = 'CHECK_REQUIRED'
              THEN 1
              ELSE 0
            END
          ) AS check_required
        FROM inspections
        `
      )
      .first();

  return json({
    ok: true,

    counts: {
      inspections:
        Number(
          (counts as any)?.inspections || 0
        ),
      attention:
        Number(
          (counts as any)?.attention || 0
        ),
      check_required:
        Number(
          (counts as any)?.check_required || 0
        ),
    },

    inspections:
      inspections.results || [],
  });
}

/* =========================================================
   SAFETY CHECKS API
   ========================================================= */

async function getSafetyChecks(
  db: D1Database
): Promise<Response> {
  const checks =
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
      .all();

  return json({
    ok: true,
    checks:
      checks.results || [],
  });
}

/* =========================================================
   HEALTH CHECK
   ========================================================= */

async function health(
  env: Env
): Promise<Response> {
  let dbOk = false;

  try {
    await env.SAFETY_DB
      .prepare("SELECT 1 AS ok")
      .first();

    dbOk = true;
  } catch (error) {
    console.error(
      "D1 health check failed:",
      error
    );
  }

  return json({
    ok: dbOk,
    worker: "depot-safety",
    ai: MODEL,
    database: dbOk,
    r2: "configured",
    time:
      new Date().toISOString(),
  });
}

/* =========================================================
   ROUTER
   ========================================================= */

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url =
      new URL(request.url);

    const pathname =
      url.pathname;

    /*
     * CORS
     */

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods":
            "GET,POST,OPTIONS",
          "access-control-allow-headers":
            "Content-Type",
          "access-control-max-age": "86400",
        },
      });
    }

    /*
     * API routes
     */

    try {
      if (
        pathname === "/api/health" &&
        request.method === "GET"
      ) {
        return addCors(
          await health(env)
        );
      }

      if (
        pathname === "/api/analyze" &&
        request.method === "POST"
      ) {
        return addCors(
          await analysePhoto(
            request,
            env
          )
        );
      }

      if (
        pathname === "/api/analysis" &&
        request.method === "POST"
      ) {
        return addCors(
          await analysePhoto(
            request,
            env
          )
        );
      }

      if (
        pathname === "/api/inspections" &&
        request.method === "GET"
      ) {
        return addCors(
          await recentInspections(
            env.SAFETY_DB
          )
        );
      }

      if (
        pathname.startsWith(
          "/api/inspections/"
        ) &&
        request.method === "GET"
      ) {
        const id =
          decodeURIComponent(
            pathname.slice(
              "/api/inspections/".length
            )
          );

        return addCors(
          await getInspection(
            env.SAFETY_DB,
            id
          )
        );
      }

      if (
        pathname === "/api/safety-checks" &&
        request.method === "GET"
      ) {
        return addCors(
          await getSafetyChecks(
            env.SAFETY_DB
          )
        );
      }

      /*
       * Optional API route used by the frontend.
       */

      if (
        pathname === "/api/findings" &&
        request.method === "GET"
      ) {
        const limitRaw =
          Number(
            url.searchParams.get(
              "limit"
            ) || "50"
          );

        const limit =
          Math.min(
            Math.max(
              Number.isFinite(
                limitRaw
              )
                ? limitRaw
                : 50,
              1
            ),
            100
          );

        const result =
          await env.SAFETY_DB
            .prepare(
              `
              SELECT
                f.*,
                sc.check_question,
                sc.guidance
              FROM findings f
              LEFT JOIN safety_checks sc
                ON sc.id = f.check_id
              ORDER BY f.created_at DESC
              LIMIT ?
              `
            )
            .bind(limit)
            .all();

        return addCors(
          json({
            ok: true,
            findings:
              result.results || [],
          })
        );
      }

      /*
       * API 404
       */

      if (
        pathname.startsWith("/api/")
      ) {
        return addCors(
          json(
            {
              ok: false,
              error:
                "API endpoint not found.",
            },
            404
          )
        );
      }

      /*
       * Static assets.
       *
       * This keeps the existing [assets] configuration.
       */

      const assets =
        (env as any).ASSETS;

      if (
        assets &&
        typeof assets.fetch ===
          "function"
      ) {
        return assets.fetch(
          request
        );
      }

      return new Response(
        "Safety Inspection AI Worker is running.",
        {
          status: 200,
          headers: {
            "content-type":
              "text/plain; charset=utf-8",
          },
        }
      );
    } catch (error) {
      console.error(
        "Worker request error:",
        error
      );

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      return addCors(
        json(
          {
            ok: false,
            error: message,
          },
          500
        )
      );
    }
  },
} satisfies ExportedHandler<Env>;

/* =========================================================
   CORS
   ========================================================= */

function addCors(
  response: Response
): Response {
  const headers =
    new Headers(
      response.headers
    );

  headers.set(
    "access-control-allow-origin",
    "*"
  );

  headers.set(
    "access-control-allow-methods",
    "GET,POST,OPTIONS"
  );

  headers.set(
    "access-control-allow-headers",
    "Content-Type"
  );

  return new Response(
    response.body,
    {
      status: response.status,
      statusText:
        response.statusText,
      headers,
    }
  );
}
