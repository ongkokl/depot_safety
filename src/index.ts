/* Depot Safety AI Worker - Version 2.3
 *
 * Features:
 * - Cloudflare Workers AI vision analysis
 * - D1 inspections / findings
 * - R2 photo storage
 * - Vectorize semantic WSHC retrieval
 * - Protected Vectorize seed endpoint
 * - Detailed WSHC-derived checklist items
 * - Equipment/activity detection
 * - Visual vs physical verification checks
 *
 * Required bindings:
 * AI, SAFETY_DB, PHOTOS, VECTORIZE, ASSETS
 *
 * Required secret:
 * VECTORIZE_SEED_KEY
 */

export interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
  VECTORIZE: VectorizeIndex;
  ASSETS: Fetcher;
  VECTORIZE_SEED_KEY?: string;
}

const MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const VECTOR_DIMENSIONS = 768;
const VECTOR_MATCH_THRESHOLD = 0.45;
const MAX_IMAGE_SIZE = 12 * 1024 * 1024;
const MAX_FINDINGS = 8;
const MAX_CHECKLIST_ITEMS = 12;

type Status = "PASS" | "FAIL" | "CHECK_REQUIRED";
type Risk = "LOW" | "MEDIUM" | "HIGH";
type SourceType = "WSHC_DIRECT" | "WSHC_DERIVED";
type CheckType = "VISUAL" | "PHYSICAL" | "BOTH";

interface SafetyCheck {
  id: string;
  category: string;
  check_question: string;
  guidance: string;
  source_title: string;
  source_url: string;
  keywords: string;
  active?: number;
  source_type?: SourceType;
}

interface ChecklistItem {
  id: string;
  safety_check_id: string;
  equipment_type: string;
  check_item: string;
  check_type: CheckType;
  importance: Risk;
  source_title: string;
  source_url: string;
  source_type: SourceType;
  active?: number;
}

interface Finding {
  category: string;
  title: string;
  observation: string;
  status: Status;
  risk_level: Risk;
  confidence: number;
  check_id: string | null;
  source_title: string | null;
  source_url: string | null;
  source_type: SourceType | null;
  equipment_type: string | null;
  visual_checks: ChecklistItem[];
  physical_checks: ChecklistItem[];
}

interface PhotoInput {
  bytes: ArrayBuffer;
  contentType: string;
  fileName: string;
}

interface ParsedRequest {
  photo: PhotoInput;
  location: string;
  inspector: string;
}

const ALLOWED_TABLES = [
  "inspections",
  "inspection_photos",
  "inspection_items",
  "safety_checks",
  "safety_check_items",
  "corrective_actions",
];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Vectorize-Seed-Key",
    },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function uuid(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

function clean(value: unknown, max = 2000): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\u0000/g, "").trim().substring(0, max);
}

function cleanMarkdown(value: unknown, max = 2000): string {
  return clean(value, max)
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/^#+\s*/g, "")
    .replace(/^[-*•]\s*/g, "")
    .trim();
}

function inspectionNumber(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const random = crypto.randomUUID().replace(/-/g, "").substring(0, 6).toUpperCase();
  return `SI-${y}${m}${day}-${random}`;
}

function normalizeContentType(value: unknown): string {
  const type = String(value || "").toLowerCase().split(";")[0].trim();
  if (type === "image/png") return "image/png";
  if (type === "image/webp") return "image/webp";
  if (type === "image/gif") return "image/gif";
  if (type === "image/heic") return "image/heic";
  if (type === "image/heif") return "image/heif";
  return "image/jpeg";
}

function extension(contentType: string): string {
  switch (contentType) {
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    case "image/heic": return "heic";
    case "image/heif": return "heif";
    default: return "jpg";
  }
}

function safeFileName(value: string): string {
  const result = value.replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 150);
  return result || "inspection-photo.jpg";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function imageDataUrl(bytes: ArrayBuffer, contentType: string): string {
  return `data:${contentType};base64,${arrayBufferToBase64(bytes)}`;
}

async function parseRequest(request: Request): Promise<ParsedRequest> {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const form = await request.formData();
    let file: File | null = null;

    for (const name of ["image", "photo", "file", "photoFile"]) {
      const value = form.get(name);
      if (value instanceof File) {
        file = value;
        break;
      }
    }

    if (!file) {
      for (const [, value] of form.entries()) {
        if (value instanceof File) {
          file = value;
          break;
        }
      }
    }

    if (!file) throw new Error("No image file was uploaded.");

    const bytes = await file.arrayBuffer();
    if (!bytes.byteLength) throw new Error("The uploaded image is empty.");
    if (bytes.byteLength > MAX_IMAGE_SIZE) {
      throw new Error("The uploaded image is larger than 12 MB.");
    }

    return {
      photo: {
        bytes,
        contentType: normalizeContentType(file.type),
        fileName: safeFileName(file.name || "inspection-photo.jpg"),
      },
      location: clean(form.get("location"), 200) || "Unspecified",
      inspector: clean(form.get("inspector"), 200) || "Unspecified",
    };
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    throw new Error("Request body is not valid JSON.");
  }

  let base64 = body?.image || body?.imageBase64 || body?.photo;
  if (typeof base64 !== "string" || !base64.trim()) {
    throw new Error("No image was supplied.");
  }

  base64 = base64.trim();
  let imageType = normalizeContentType(body?.mimeType || body?.contentType || "image/jpeg");

  const match = base64.match(/^data:(image\/[^;]+);base64,(.+)$/s);
  if (match) {
    imageType = normalizeContentType(match[1]);
    base64 = match[2];
  }

  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("Image data is not valid base64.");
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  if (!bytes.byteLength) throw new Error("The image is empty.");
  if (bytes.byteLength > MAX_IMAGE_SIZE) {
    throw new Error("The image is larger than 12 MB.");
  }

  return {
    photo: {
      bytes: bytes.buffer,
      contentType: imageType,
      fileName: safeFileName(body?.fileName || `inspection.${extension(imageType)}`),
    },
    location: clean(body?.location, 200) || "Unspecified",
    inspector: clean(body?.inspector, 200) || "Unspecified",
  };
}

async function getTableColumns(db: D1Database, table: string): Promise<Set<string>> {
  if (!ALLOWED_TABLES.includes(table)) throw new Error(`Invalid table name: ${table}`);
  const result = await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
  return new Set((result.results || []).map(row => row.name));
}

function buildInsert(
  table: string,
  columns: Set<string>,
  values: Record<string, unknown>
): { sql: string; params: unknown[] } {
  if (!ALLOWED_TABLES.includes(table)) throw new Error(`Invalid insert table: ${table}`);

  const selected = Object.entries(values).filter(([column]) => columns.has(column));
  if (!selected.length) throw new Error(`No matching columns found in ${table}.`);

  return {
    sql: `INSERT INTO "${table}" (${selected.map(([c]) => `"${c}"`).join(", ")}) VALUES (${selected.map(() => "?").join(", ")})`,
    params: selected.map(([, value]) => value),
  };
}

async function ensureChecklistTable(env: Env): Promise<void> {
  await env.SAFETY_DB.prepare(`
    CREATE TABLE IF NOT EXISTS safety_check_items (
      id TEXT PRIMARY KEY,
      safety_check_id TEXT NOT NULL,
      equipment_type TEXT NOT NULL DEFAULT 'GENERAL',
      check_item TEXT NOT NULL,
      check_type TEXT NOT NULL DEFAULT 'PHYSICAL',
      importance TEXT NOT NULL DEFAULT 'MEDIUM',
      source_title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'WSHC_DERIVED',
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (safety_check_id) REFERENCES safety_checks(id) ON DELETE CASCADE
    )
  `).run();

  await env.SAFETY_DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_safety_check_items_check
    ON safety_check_items(safety_check_id)
  `).run();

  await env.SAFETY_DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_safety_check_items_equipment
    ON safety_check_items(equipment_type)
  `).run();
}

async function loadSafetyChecks(env: Env): Promise<SafetyCheck[]> {
  const columns = await getTableColumns(env.SAFETY_DB, "safety_checks");
  const required = ["id", "category", "check_question", "guidance", "source_title", "source_url", "keywords"];
  const missing = required.filter(column => !columns.has(column));
  if (missing.length) throw new Error(`safety_checks is missing columns: ${missing.join(", ")}`);

  const sourceTypeSelect = columns.has("source_type") ? ", source_type" : "";
  const result = await env.SAFETY_DB.prepare(`
    SELECT id, category, check_question, guidance, source_title, source_url, keywords${sourceTypeSelect}
    FROM safety_checks
    WHERE active = 1
    ORDER BY category, id
    LIMIT 80
  `).all<SafetyCheck>();

  return result.results || [];
}

function buildPrompt(checks: SafetyCheck[]): string {
  const available = checks.map(check => `
CHECK ID: ${check.id}
CATEGORY: ${check.category}
QUESTION: ${clean(check.check_question, 350)}
GUIDANCE: ${clean(check.guidance, 500)}
KEYWORDS: ${clean(check.keywords, 250)}
SOURCE: ${clean(check.source_title, 250)}
URL: ${clean(check.source_url, 500)}
`).join("\n");

  return `
You are a workplace safety inspection assistant for a Singapore shipping/container depot and container repair yard.

Analyse ONLY what is visibly supported by the photograph.

Do not invent hazards.
Do not assume every safety category applies.
Only assess a category when there is visible evidence relevant to that category.

IMPORTANT:
Do not return negative visibility findings.
Never write:
"No visible..."
"No evidence..."
"Not observed..."
"No visible lifting..."
"No visible electrical..."
etc.

Only return POSITIVE visible observations or a relevant condition that genuinely needs verification.

If the photograph shows a person, equipment, structure, activity or hazard that is relevant to a WSH check, report it.

Identify the most specific equipment/activity when possible:
- LADDER
- MOBILE_ACCESS_PLATFORM
- SCAFFOLD
- FORKLIFT
- REACH_STACKER
- LIFTING_GEAR
- CONTAINER_REPAIR
- WELDING
- GRINDING
- ELECTRICAL_TOOL
- CHEMICAL
- VEHICLE
- GENERAL

Status:
PASS = visible condition appears satisfactory.
FAIL = visible unsafe condition is identified.
CHECK_REQUIRED = relevant condition is visible but photograph is insufficient to confirm safe condition.

Risk:
LOW = satisfactory/minor concern.
MEDIUM = potential safety concern.
HIGH = serious visible safety concern.

Confidence must be between 0 and 1.

Return ONLY JSON.
Do not return Markdown.
Do not add commentary.

Use this exact JSON schema:
{
  "findings": [
    {
      "category": "Work at Height",
      "title": "Elevated access structure requires verification",
      "observation": "A mobile access structure with an elevated platform is visible.",
      "status": "CHECK_REQUIRED",
      "risk": "MEDIUM",
      "confidence": 0.88,
      "check_id": "work-height-001",
      "equipment_type": "MOBILE_ACCESS_PLATFORM"
    }
  ]
}

AVAILABLE WSH CHECKS:
${available}
`.trim();
}

async function runAI(
  env: Env,
  image: ArrayBuffer,
  contentType: string,
  checks: SafetyCheck[]
): Promise<{ raw: string; result: any }> {
  const imageData = imageDataUrl(image, contentType);

  let response: any;
  try {
    response = await env.AI.run(
      MODEL,
      {
        messages: [
          {
            role: "system",
            content: "You are a careful Singapore workplace safety visual inspection assistant. Only report visible evidence. Return valid JSON only.",
          },
          {
            role: "user",
            content: buildPrompt(checks),
          },
        ],
        image: imageData,
        max_tokens: 1400,
        temperature: 0.05,
        top_p: 0.8,
      } as any
    );
  } catch (error) {
    throw new Error(`Workers AI request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const raw =
    typeof response === "string"
      ? response
      : typeof response?.response === "string"
        ? response.response
        : typeof response?.result === "string"
          ? response.result
          : "";

  if (!raw.trim()) {
    throw new Error(`Workers AI returned no text. Response: ${JSON.stringify(response).substring(0, 3000)}`);
  }

  return { raw: raw.trim(), result: response };
}

function extractJson(text: string): any | null {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try the first JSON object in the response.
  }

  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(cleaned.substring(first, last + 1));
    } catch {
      return null;
    }
  }

  return null;
}

function parseConfidence(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0.6;
  let number = Number(String(value).replace("%", ""));
  if (!Number.isFinite(number)) return 0.6;
  if (number > 1) number /= 100;
  return Math.round(Math.max(0, Math.min(1, number)) * 100) / 100;
}

function normalizeStatus(value: unknown, observation: string): Status {
  const text = cleanMarkdown(value).toUpperCase();
  if (text.includes("FAIL")) return "FAIL";
  if (text.includes("PASS")) return "PASS";
  if (text.includes("CHECK")) return "CHECK_REQUIRED";

  const lower = observation.toLowerCase();
  if (["unsafe", "hazard", "spill", "obstructed", "blocked", "missing", "damaged", "exposed", "unguarded"].some(w => lower.includes(w))) {
    return "FAIL";
  }
  return "CHECK_REQUIRED";
}

function normalizeRisk(value: unknown, status: Status): Risk {
  const text = cleanMarkdown(value).toUpperCase();
  if (text.includes("HIGH")) return "HIGH";
  if (text.includes("MEDIUM")) return "MEDIUM";
  if (text.includes("LOW")) return "LOW";
  if (status === "FAIL") return "HIGH";
  if (status === "PASS") return "LOW";
  return "MEDIUM";
}

function normalizeCategory(category: string): string {
  const value = cleanMarkdown(category, 100).replace(/\s+/g, " ").trim();
  const lower = value.toLowerCase();

  if (lower === "ppe" || lower.includes("personal protective")) return "PPE";
  if (lower.includes("housekeeping")) return "Housekeeping";
  if (lower.includes("vehicular") || lower.includes("vehicle") || lower.includes("traffic")) return "Vehicular Safety";
  if (lower.includes("work at height") || lower.includes("working at height")) return "Work at Height";
  if (lower.includes("lifting")) return "Lifting";
  if (lower.includes("electrical")) return "Electrical Safety";
  if (lower.includes("fire")) return "Fire Safety";
  if (lower.includes("storage")) return "Storage and Stacking";
  if (lower.includes("chemical")) return "Chemical Safety";
  if (lower.includes("confined")) return "Confined Space";
  if (lower.includes("forklift") || lower.includes("fork lift")) return "Forklift Safety";
  if (lower.includes("reach stacker")) return "Reach Stacker Safety";
  if (lower.includes("loading") || lower.includes("unloading")) return "Loading and Unloading";
  if (lower.includes("machinery") || lower.includes("machine")) return "Machinery Safety";
  if (lower.includes("manual handling") || lower.includes("ergonomic")) return "Manual Handling";
  if (lower.includes("hot work") || lower.includes("welding") || lower.includes("grinding")) return "Hot Work";
  if (lower.includes("noise")) return "Noise";
  if (lower.includes("risk assessment") || lower === "risk") return "Risk Assessment";
  if (lower.includes("slip") || lower.includes("trip") || lower.includes("fall")) return "Slips, Trips and Falls";

  return value;
}

function inferSafetyCategory(
  category: string,
  title: string,
  observation: string
): string {
  const original = normalizeCategory(category);
  const text = `${category} ${title} ${observation}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  /*
   * Correct generic/object descriptions before WSHC matching.
   * This prevents a generic "metal structure" or "person" finding
   * from being matched to an unrelated safety category.
   */

  if (
    /hard hat|helmet|high[- ]visibility vest|high[- ]visibility clothing|safety footwear|safety shoes|safety glasses|protective gloves|ppe/.test(text)
  ) {
    return "PPE";
  }

  if (
    /ladder|scaffold|scaffolding|platform|guardrail|mid[- ]rail|toe[- ]board|elevated access|work at height|working at height/.test(text)
  ) {
    return "Work at Height";
  }

  if (
    /forklift|fork lift/.test(text)
  ) {
    return "Forklift Safety";
  }

  if (
    /reach stacker|reachstacker/.test(text)
  ) {
    return "Reach Stacker Safety";
  }

  if (
    /spreader|sling|lifting gear|lifting equipment|lifting hook|suspended load|crane/.test(text)
  ) {
    return "Lifting";
  }

  if (
    /welding|weld|grinding|grinder|cutting|hot work|hot-work|torch|spark/.test(text)
  ) {
    return "Hot Work";
  }

  if (
    /electrical cable|electrical cord|plug|socket|exposed wire|electric tool|power tool/.test(text)
  ) {
    return "Electrical Safety";
  }

  if (
    /chemical|solvent|paint|container leak|chemical leak|spill kit/.test(text)
  ) {
    return "Chemical Safety";
  }

  if (
    /oil spill|water spill|wet floor|slippery|trip hazard|obstructed walkway|blocked walkway|debris on floor|hose across walkway|cable across walkway/.test(text)
  ) {
    return "Slips, Trips and Falls";
  }

  if (
    /blocked|obstruction|clutter|waste|rubbish|debris|poor housekeeping/.test(text)
  ) {
    return "Housekeeping";
  }

  if (
    /vehicle|truck|lorry|traffic|pedestrian route|reversing|banksman/.test(text)
  ) {
    return "Vehicular Safety";
  }

  if (
    /container repair|container maintenance|repairing container/.test(text)
  ) {
    return "Machinery Safety";
  }

  return original;
}

function isActualSafetyFinding(
  category: string,
  title: string,
  observation: string,
  status: Status
): boolean {
  const text = `${category} ${title} ${observation}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return false;
  if (isNegativeVisibilityText(text)) return false;

  /* Generic scene/object descriptions are not safety findings. */
  const genericObjectPatterns = [
    /^visible person(?:\s|:)/,
    /^person(?:\s|:)/,
    /^visible metal structure(?:\s|:)/,
    /^metal structure(?:\s|:)/,
    /^visible concrete surface(?:\s|:)/,
    /^concrete surface(?:\s|:)/,
    /^visible road(?:\s|:)/,
    /^road(?:\s|:)/,
    /^visible container(?:\s|:)/,
    /^container(?:\s|:)/,
    /^visible object(?:\s|:)/,
    /^object(?:\s|:)/,
  ];

  const isGenericTitle = genericObjectPatterns.some(re => re.test(text));

  const positiveSafetySignals = [
    "hazard",
    "unsafe",
    "damaged",
    "broken",
    "missing",
    "exposed",
    "unguarded",
    "unsecured",
    "unstable",
    "blocked",
    "obstructed",
    "spill",
    "leak",
    "corrosion",
    "corroded",
    "crack",
    "bent",
    "trip",
    "slip",
    "guardrail",
    "handrail",
    "toe-board",
    "top rung",
    "ladder",
    "platform",
    "scaffold",
    "forklift",
    "reach stacker",
    "lifting",
    "welding",
    "grinding",
    "electrical",
    "chemical",
    "ppe",
    "hard hat",
    "helmet",
    "high-visibility",
    "safety footwear",
    "safety shoes",
    "confined space",
    "fire extinguisher",
    "storage",
    "stack",
    "manual handling",
    "awkward posture",
  ];

  /* A generic object is acceptable only when the description contains
     a genuine safety-relevant signal. */
  if (isGenericTitle) {
    if (!positiveSafetySignals.some(signal => text.includes(signal))) {
      return false;
    }
  }

  /* Generic positive descriptions of a surface/person/object are not findings. */
  const nonFindingPatterns = [
    "smooth and flat",
    "appears to be a loading dock or a work area",
    "has a few marks and stains on it",
    "standing next to",
    "large metal structure",
    "appears to be working or inspecting",
  ];

  if (
    nonFindingPatterns.some(pattern => text.includes(pattern)) &&
    !positiveSafetySignals.some(signal => text.includes(signal))
  ) {
    return false;
  }

  /* A PASS finding is valid only when it is tied to an actual safety
     category such as PPE, housekeeping, traffic segregation, etc. */
  const validCategories = new Set([
    "PPE",
    "Housekeeping",
    "Vehicular Safety",
    "Work at Height",
    "Lifting",
    "Electrical Safety",
    "Fire Safety",
    "Storage and Stacking",
    "Chemical Safety",
    "Confined Space",
    "Forklift Safety",
    "Reach Stacker Safety",
    "Loading and Unloading",
    "Machinery Safety",
    "Manual Handling",
    "Hot Work",
    "Noise",
    "Risk Assessment",
    "Slips, Trips and Falls",
  ]);

  if (!validCategories.has(category)) return false;

  return true;
}

function detectEquipmentType(category: string, title: string, observation: string, aiType?: string): string {
  const text = `${category} ${title} ${observation}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  /*
   * IMPORTANT:
   *
   * Do not blindly trust the AI equipment_type when the text contains
   * a more specific structure. For example, the vision model may return
   * LADDER for a mobile access structure because it sees ladders inside
   * the structure. A phrase such as "ladder and platform" should therefore
   * resolve to MOBILE_ACCESS_PLATFORM.
   */

  if (
    text.includes("mobile access platform") ||
    text.includes("mobile platform") ||
    text.includes("access platform") ||
    text.includes("platform with ladder") ||
    text.includes("ladder and platform") ||
    text.includes("ladder with platform") ||
    text.includes("elevated access structure") ||
    text.includes("access structure with")
  ) {
    return "MOBILE_ACCESS_PLATFORM";
  }

  if (
    text.includes("scaffold") ||
    text.includes("scaffolding")
  ) {
    return "SCAFFOLD";
  }

  if (text.includes("reach stacker") || text.includes("reachstacker")) {
    return "REACH_STACKER";
  }

  if (text.includes("forklift") || text.includes("fork lift")) {
    return "FORKLIFT";
  }

  if (
    text.includes("spreader") ||
    text.includes("sling") ||
    text.includes("lifting gear") ||
    text.includes("lifting equipment") ||
    text.includes("lifting hook")
  ) {
    return "LIFTING_GEAR";
  }

  if (text.includes("ladder")) {
    return "LADDER";
  }

  if (text.includes("welding") || text.includes("weld")) {
    return "WELDING";
  }

  if (text.includes("grinding") || text.includes("grinder")) {
    return "GRINDING";
  }

  if (
    text.includes("electrical tool") ||
    text.includes("power tool") ||
    text.includes("electric tool")
  ) {
    return "ELECTRICAL_TOOL";
  }

  if (
    text.includes("chemical") ||
    text.includes("solvent") ||
    text.includes("paint")
  ) {
    return "CHEMICAL";
  }

  if (
    text.includes("container repair") ||
    text.includes("container maintenance")
  ) {
    return "CONTAINER_REPAIR";
  }

  if (
    text.includes("vehicle") ||
    text.includes("truck") ||
    text.includes("lorry")
  ) {
    return "VEHICLE";
  }

  /*
   * Only use the AI supplied type after checking the actual description.
   */
  const explicit = clean(aiType, 80)
    .toUpperCase()
    .replace(/\s+/g, "_");

  const allowed = new Set([
    "LADDER",
    "MOBILE_ACCESS_PLATFORM",
    "SCAFFOLD",
    "FORKLIFT",
    "REACH_STACKER",
    "LIFTING_GEAR",
    "CONTAINER_REPAIR",
    "WELDING",
    "GRINDING",
    "ELECTRICAL_TOOL",
    "CHEMICAL",
    "VEHICLE",
    "GENERAL",
  ]);

  if (allowed.has(explicit)) return explicit;

  return "GENERAL";
}

function isNegativeVisibilityText(text: string): boolean {
  const value = text.toLowerCase().replace(/\s+/g, " ").trim();

  const patterns = [
    "no visible",
    "not visible",
    "no evidence",
    "not observed",
    "not apparent",
    "no visible lifting",
    "no visible electrical",
    "no visible fire",
    "no visible storage",
    "no visible housekeeping",
    "no visible vehicular",
    "no visible chemical",
    "no visible confined",
    "no visible forklift",
    "no visible reach stacker",
    "no visible machinery",
    "no visible manual handling",
    "no visible hot work",
    "no visible noise",
    "no visible risk assessment",
  ];

  return patterns.some(pattern => value.includes(pattern));
}

function parseLegacyVisualResponse(raw: string): Array<{
  category: string;
  title: string;
  observation: string;
  status: Status;
  risk: Risk;
  confidence: number;
  checkId: string;
  equipmentType: string;
}> {
  const results: Array<{
    category: string;
    title: string;
    observation: string;
    status: Status;
    risk: Risk;
    confidence: number;
    checkId: string;
    equipmentType: string;
  }> = [];

  const blocks = raw
    .replace(/\r/g, "")
    .split(/\n(?=\s*\*\s+\*\*[^*]+\*\*)/);

  for (const block of blocks) {
    const categoryMatch =
      block.match(/\*\*\s*([A-Za-z][^*\n]+?)\s*\*\*/);

    if (!categoryMatch) continue;

    const category = normalizeCategory(categoryMatch[1]);
    if (
      [
        "Title",
        "Observation",
        "Status",
        "Risk",
        "Confidence",
        "Check ID",
        "Category",
      ].includes(category)
    ) {
      continue;
    }

    const lines = block
      .split("\n")
      .map(line => line.replace(/^\s*\*\s*/, "").trim())
      .filter(Boolean);

    const detailLines = lines.filter(line => {
      const lower = line.toLowerCase();
      return (
        !lower.startsWith("**title:**") &&
        !lower.startsWith("**observation:**") &&
        !lower.startsWith("**status:**") &&
        !lower.startsWith("**risk:**") &&
        !lower.startsWith("**confidence:**") &&
        !lower.startsWith("**check id:**") &&
        !/^\*\*[^*]+\*\*$/.test(line)
      );
    });

    const titleMatch = block.match(/\*\*Title:\*\*\s*(.+?)(?:\n|$)/i);
    const observationMatch = block.match(/\*\*Observation:\*\*\s*(.+?)(?:\n|$)/i);
    const statusMatch = block.match(/\*\*Status:\*\*\s*(PASS|FAIL|CHECK_REQUIRED)/i);
    const riskMatch = block.match(/\*\*Risk:\*\*\s*(LOW|MEDIUM|HIGH)/i);
    const confidenceMatch = block.match(/\*\*Confidence:\*\*\s*([0-9.]+)/i);
    const checkIdMatch = block.match(/\*\*Check ID:\*\*\s*([^\s\n]+)/i);

    let observation = cleanMarkdown(observationMatch?.[1] || "", 1200);

    // Some vision responses return a simple bullet list rather than
    // Title/Observation fields. Convert the visible bullets into one observation.
    if (!observation) {
      const visibleBullets = detailLines
        .filter(line => !line.startsWith("**"))
        .filter(line => !isNegativeVisibilityText(line))
        .slice(0, 3);

      if (visibleBullets.length) {
        observation = visibleBullets.join(" ");
      }
    }

    if (!observation || isNegativeVisibilityText(`${category} ${observation}`)) {
      continue;
    }

    const title = cleanMarkdown(
      titleMatch?.[1] ||
      (category === "Work at Height"
        ? "Work-at-height equipment requires verification"
        : `Visible ${category.toLowerCase()} condition`),
      250
    );

    const status = normalizeStatus(statusMatch?.[1] || "", observation);
    const risk = normalizeRisk(riskMatch?.[1] || "", status);

    results.push({
      category,
      title,
      observation,
      status,
      risk,
      confidence: parseConfidence(confidenceMatch?.[1] || ""),
      checkId: cleanMarkdown(checkIdMatch?.[1] || "", 100),
      equipmentType: detectEquipmentType(category, title, observation),
    });

    if (results.length >= MAX_FINDINGS) break;
  }

  return results;
}

function parseStructuredAIResponse(raw: string): Array<{
  category: string;
  title: string;
  observation: string;
  status: Status;
  risk: Risk;
  confidence: number;
  checkId: string;
  equipmentType: string;
}> {
  const json = extractJson(raw);

  if (json) {
    const source = Array.isArray(json) ? json : json.findings;

    if (Array.isArray(source)) {
      const results: Array<{
        category: string;
        title: string;
        observation: string;
        status: Status;
        risk: Risk;
        confidence: number;
        checkId: string;
        equipmentType: string;
      }> = [];

      for (const item of source) {
        if (!item || typeof item !== "object") continue;

        const category = normalizeCategory(cleanMarkdown(item.category || ""));
        const title = cleanMarkdown(item.title || `${category} observation`, 250);
        const observation = cleanMarkdown(item.observation || "", 1200);

        if (!category || !observation) continue;
        if (isNegativeVisibilityText(`${title} ${observation}`)) continue;

        const status = normalizeStatus(item.status, observation);
        const risk = normalizeRisk(item.risk, status);

        results.push({
          category,
          title,
          observation,
          status,
          risk,
          confidence: parseConfidence(item.confidence),
          checkId: cleanMarkdown(item.check_id || "", 100),
          equipmentType: detectEquipmentType(
            category,
            title,
            observation,
            item.equipment_type
          ),
        });

        if (results.length >= MAX_FINDINGS) break;
      }

      if (results.length) return results;
    }
  }

  // Important fallback:
  // Vision models sometimes ignore JSON-only instructions and return
  // Markdown/bullet observations. Do not fail the whole inspection.
  const legacy = parseLegacyVisualResponse(raw);

  if (legacy.length) return legacy;

  throw new Error(
    `Scene analysis returned no usable structured findings: ${raw.substring(0, 5000)}`
  );
}

function findCheck(
  finding: { category: string; title: string; observation: string; checkId: string },
  checks: SafetyCheck[]
): SafetyCheck | null {
  if (finding.checkId) {
    const exact = checks.find(check => check.id === finding.checkId);
    if (exact) return exact;
  }

  const category = normalizeCategory(finding.category);

  const categoryMatches = checks.filter(
    check =>
      normalizeCategory(check.category).toLowerCase() ===
      category.toLowerCase()
  );

  if (categoryMatches.length === 1) return categoryMatches[0];

  if (!categoryMatches.length) {
    /* Do not match an arbitrary WSHC category just because a keyword such as
       "surface", "equipment" or "condition" happens to overlap. */
    return null;
  }

  const combined = `${category} ${finding.title} ${finding.observation}`.toLowerCase();
  let best: SafetyCheck | null = null;
  let bestScore = 0;

  for (const check of categoryMatches) {
    const keywords = clean(check.keywords, 500)
      .toLowerCase()
      .split(/[,;|]+/)
      .map(w => w.trim())
      .filter(w => w.length >= 3);

    let score = 0;
    for (const keyword of keywords) {
      if (combined.includes(keyword)) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      best = check;
    }
  }

  return bestScore > 0 ? best : categoryMatches[0] || null;
}

function checklistEquipmentTypes(equipmentType: string): string[] {
  const type = clean(equipmentType, 80).toUpperCase();

  const map: Record<string, string[]> = {
    MOBILE_ACCESS_PLATFORM: [
      "MOBILE_ACCESS_PLATFORM",
      "LADDER",
      "GENERAL",
    ],
    SCAFFOLD: [
      "SCAFFOLD",
      "MOBILE_ACCESS_PLATFORM",
      "GENERAL",
    ],
    LADDER: [
      "LADDER",
      "GENERAL",
    ],
    FORKLIFT: [
      "FORKLIFT",
      "VEHICLE",
      "GENERAL",
    ],
    REACH_STACKER: [
      "REACH_STACKER",
      "VEHICLE",
      "GENERAL",
    ],
    LIFTING_GEAR: [
      "LIFTING_GEAR",
      "GENERAL",
    ],
    WELDING: [
      "WELDING",
      "HOT_WORK",
      "GENERAL",
    ],
    GRINDING: [
      "GRINDING",
      "HOT_WORK",
      "GENERAL",
    ],
    ELECTRICAL_TOOL: [
      "ELECTRICAL_TOOL",
      "GENERAL",
    ],
    CHEMICAL: [
      "CHEMICAL",
      "GENERAL",
    ],
    CONTAINER_REPAIR: [
      "CONTAINER_REPAIR",
      "GENERAL",
    ],
    VEHICLE: [
      "VEHICLE",
      "GENERAL",
    ],
    GENERAL: [
      "GENERAL",
    ],
  };

  return map[type] || [type, "GENERAL"];
}

async function loadChecklistItems(
  env: Env,
  checkId: string,
  equipmentType: string
): Promise<ChecklistItem[]> {
  await ensureChecklistTable(env);

  const equipmentTypes = checklistEquipmentTypes(equipmentType);
  const placeholders = equipmentTypes.map(() => "?").join(", ");

  const result = await env.SAFETY_DB.prepare(`
    SELECT
      id,
      safety_check_id,
      equipment_type,
      check_item,
      check_type,
      importance,
      source_title,
      source_url,
      source_type,
      active
    FROM safety_check_items
    WHERE safety_check_id = ?
      AND active = 1
      AND equipment_type IN (${placeholders})
    ORDER BY
      CASE equipment_type
        ${equipmentTypes.map((type, index) => `WHEN '${type.replace(/'/g, "''")}' THEN ${index + 1}`).join("\n        ")}
        ELSE 99
      END,
      CASE importance
        WHEN 'HIGH' THEN 1
        WHEN 'MEDIUM' THEN 2
        ELSE 3
      END,
      CASE check_type
        WHEN 'VISUAL' THEN 1
        WHEN 'BOTH' THEN 2
        ELSE 3
      END,
      id
    LIMIT ?
  `)
    .bind(checkId, ...equipmentTypes, MAX_CHECKLIST_ITEMS)
    .all<ChecklistItem>();

  const seen = new Set<string>();

  return (result.results || [])
    .filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .map(item => ({
      ...item,
      check_type: (item.check_type || "PHYSICAL") as CheckType,
      importance: (item.importance || "MEDIUM") as Risk,
      source_type: (item.source_type || "WSHC_DERIVED") as SourceType,
    }));
}

async function searchRelevantWSHCChecks(env: Env, text: string): Promise<any[]> {
  try {
    const embeddingResponse: any = await env.AI.run(
      EMBEDDING_MODEL,
      { text: [text] } as any
    );

    const vector = embeddingResponse?.data?.[0];
    if (!Array.isArray(vector) || vector.length !== VECTOR_DIMENSIONS) return [];

    const result: any = await env.VECTORIZE.query(vector, {
      topK: 6,
      returnMetadata: true,
    } as any);

    return (result?.matches || []).filter(
      (match: any) => Number(match.score || 0) >= VECTOR_MATCH_THRESHOLD
    );
  } catch {
    return [];
  }
}

async function enrichFinding(
  env: Env,
  finding: Finding,
  checks: SafetyCheck[]
): Promise<Finding> {
  const equipmentType = finding.equipment_type || detectEquipmentType(
    finding.category,
    finding.title,
    finding.observation
  );

  const matches = await searchRelevantWSHCChecks(
    env,
    `${finding.category} ${equipmentType} ${finding.title} ${finding.observation}`
  );

  let selectedCheck: SafetyCheck | null = null;

  if (finding.check_id) {
    selectedCheck = checks.find(check => check.id === finding.check_id) || null;
  }

  if (!selectedCheck && matches.length) {
    const targetCategory = normalizeCategory(finding.category).toLowerCase();

    for (const match of matches) {
      const id = clean(match.id || match.metadata?.check_id || "", 100);
      const candidate = checks.find(check => check.id === id);
      if (!candidate) continue;

      const candidateCategory = normalizeCategory(
        clean(match.metadata?.category || candidate.category, 150)
      ).toLowerCase();

      if (candidateCategory !== targetCategory) continue;

      selectedCheck = candidate;
      break;
    }
  }

  if (!selectedCheck) {
    selectedCheck = findCheck(
      {
        category: finding.category,
        title: finding.title,
        observation: finding.observation,
        checkId: "",
      },
      checks
    );
  }

  if (!selectedCheck) {
    return {
      ...finding,
      equipment_type: equipmentType,
      visual_checks: [],
      physical_checks: [],
    };
  }

  const checklist = await loadChecklistItems(
    env,
    selectedCheck.id,
    equipmentType
  );

  return {
    ...finding,
    check_id: selectedCheck.id,
    source_title: selectedCheck.source_title,
    source_url: selectedCheck.source_url,
    source_type: (selectedCheck.source_type || "WSHC_DERIVED") as SourceType,
    equipment_type: equipmentType,
    visual_checks: checklist.filter(item => item.check_type === "VISUAL" || item.check_type === "BOTH"),
    physical_checks: checklist.filter(item => item.check_type === "PHYSICAL" || item.check_type === "BOTH"),
  };
}

async function normalizeFindings(
  parsed: Array<{
    category: string;
    title: string;
    observation: string;
    status: Status;
    risk: Risk;
    confidence: number;
    checkId: string;
    equipmentType: string;
  }>,
  checks: SafetyCheck[],
  env: Env
): Promise<Finding[]> {
  const output: Finding[] = [];
  const seen = new Set<string>();

  for (const item of parsed) {
    const rawCategory = normalizeCategory(item.category || "");
    const title = cleanMarkdown(item.title, 250);
    const observation = cleanMarkdown(item.observation, 1200);

    if (!observation) continue;

    /* Infer a real WSH category from the visible evidence before matching. */
    const category = inferSafetyCategory(
      rawCategory,
      title,
      observation
    );

    let status = item.status;
    let risk = item.risk;

    /* If the model described PPE positively under a generic person finding,
       turn it into a proper PPE PASS finding. */
    if (
      category === "PPE" &&
      /hard hat|helmet|high[- ]visibility vest|high[- ]visibility clothing/.test(
        `${title} ${observation}`.toLowerCase()
      ) &&
      !/missing|without|not wearing|unsafe|damaged/.test(
        `${title} ${observation}`.toLowerCase()
      )
    ) {
      status = "PASS";
      risk = "LOW";
    }

    if (!isActualSafetyFinding(category, title, observation, status)) {
      continue;
    }

    const key = `${category}|${title}|${observation}`
      .toLowerCase()
      .replace(/\s+/g, " ");

    if (seen.has(key)) continue;
    seen.add(key);

    const detectedEquipment = detectEquipmentType(
      category,
      title,
      observation,
      item.equipmentType
    );

    const check = findCheck(
      {
        category,
        title,
        observation,
        checkId: item.checkId,
      },
      checks
    );

    const base: Finding = {
      category,
      title,
      observation,
      status,
      risk_level: risk,
      confidence: Math.round(
        Math.max(0, Math.min(1, item.confidence)) * 100
      ) / 100,
      check_id: check?.id || null,
      source_title: check?.source_title || null,
      source_url: check?.source_url || null,
      source_type: (check?.source_type || null) as SourceType | null,
      equipment_type: detectedEquipment,
      visual_checks: [],
      physical_checks: [],
    };

    const enriched = await enrichFinding(env, base, checks);

    /* Never retain an unrelated WSHC match. */
    if (
      enriched.check_id &&
      normalizeCategory(enriched.category).toLowerCase() !==
        normalizeCategory(
          checks.find(c => c.id === enriched.check_id)?.category || ""
        ).toLowerCase()
    ) {
      continue;
    }

    output.push(enriched);

    if (output.length >= MAX_FINDINGS) break;
  }

  return output;
}

function overall(findings: Finding[]): "PASS" | "ATTENTION" | "CHECK_REQUIRED" {
  if (!findings.length) return "CHECK_REQUIRED";
  if (findings.some(f => f.status === "FAIL")) return "ATTENTION";
  if (findings.some(f => f.status === "CHECK_REQUIRED")) return "CHECK_REQUIRED";
  return "PASS";
}

function buildSummary(findings: Finding[]): string {
  if (!findings.length) {
    return "No relevant visible safety conditions were identified from the photograph.";
  }

  const pass = findings.filter(f => f.status === "PASS").length;
  const fail = findings.filter(f => f.status === "FAIL").length;
  const check = findings.filter(f => f.status === "CHECK_REQUIRED").length;

  if (fail > 0) {
    return `${fail} visible safety finding(s) require corrective attention. ${check} item(s) require verification and ${pass} item(s) passed.`;
  }

  if (check > 0) {
    return `${check} visible safety item(s) require verification. ${pass} item(s) passed.`;
  }

  return `${pass} visible safety item(s) were assessed as PASS.`;
}

async function insertInspection(
  env: Env,
  id: string,
  inspectionNo: string,
  location: string,
  inspector: string,
  createdAt: string
): Promise<void> {
  const columns = await getTableColumns(env.SAFETY_DB, "inspections");

  const insert = buildInsert("inspections", columns, {
    id,
    inspection_no: inspectionNo,
    location: location || null,
    inspector: inspector || null,
    created_at: createdAt,
    overall_result: "CHECK_REQUIRED",
  });

  await env.SAFETY_DB.prepare(insert.sql).bind(...insert.params).run();
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
  const columns = await getTableColumns(env.SAFETY_DB, "inspection_photos");

  if (!columns.has("object_key")) {
    throw new Error("inspection_photos.object_key column does not exist.");
  }

  const insert = buildInsert("inspection_photos", columns, {
    id: photoId,
    inspection_id: inspectionId,
    object_key: objectKey,
    file_name: fileName,
    content_type: contentType,
    created_at: createdAt,
  });

  await env.SAFETY_DB.prepare(insert.sql).bind(...insert.params).run();
}

async function insertInspectionItems(
  env: Env,
  inspectionId: string,
  photoId: string,
  findings: Finding[]
): Promise<void> {
  if (!findings.length) return;

  const columns = await getTableColumns(env.SAFETY_DB, "inspection_items");

  const statements = findings.map(finding => {
    const insert = buildInsert("inspection_items", columns, {
      id: uuid(),
      inspection_id: inspectionId,
      photo_id: photoId,
      category: finding.category,
      title: finding.title,
      observation: finding.observation,
      status: finding.status,
      risk_level: finding.risk_level,
      confidence: finding.confidence,
      check_id: finding.check_id,
      source_title: finding.source_title,
      source_url: finding.source_url,
      source_type: finding.source_type,
      equipment_type: finding.equipment_type,
      created_at: nowISO(),
    });

    return env.SAFETY_DB.prepare(insert.sql).bind(...insert.params);
  });

  await env.SAFETY_DB.batch(statements);
}

async function updateInspection(
  env: Env,
  inspectionId: string,
  result: "PASS" | "ATTENTION" | "CHECK_REQUIRED"
): Promise<void> {
  const columns = await getTableColumns(env.SAFETY_DB, "inspections");
  if (!columns.has("overall_result")) return;

  await env.SAFETY_DB.prepare(`
    UPDATE inspections SET overall_result = ? WHERE id = ?
  `).bind(result, inspectionId).run();
}

async function uploadToR2(
  env: Env,
  objectKey: string,
  photo: PhotoInput,
  metadata: { inspectionId: string; photoId: string; inspectionNo: string }
): Promise<void> {
  await env.PHOTOS.put(objectKey, photo.bytes, {
    httpMetadata: {
      contentType: photo.contentType,
      contentDisposition: `inline; filename="${photo.fileName}"`,
    },
    customMetadata: {
      inspectionId: metadata.inspectionId,
      photoId: metadata.photoId,
      inspectionNo: metadata.inspectionNo,
    },
  });
}

async function analyze(request: Request, env: Env): Promise<Response> {
  let stage = "starting";
  let inspectionId = "";
  let photoId = "";
  let objectKey = "";
  let r2Uploaded = false;

  try {
    const input = await parseRequest(request);
    const photo = input.photo;

    stage = "create IDs";
    inspectionId = uuid();
    photoId = uuid();
    const inspectionNo = inspectionNumber();
    const createdAt = nowISO();

    objectKey = `inspections/${inspectionId}/${photoId}.${extension(photo.contentType)}`;

    stage = "D1 create inspection";
    await insertInspection(env, inspectionId, inspectionNo, input.location, input.inspector, createdAt);

    stage = "R2 upload";
    await uploadToR2(env, objectKey, photo, { inspectionId, photoId, inspectionNo });
    r2Uploaded = true;

    stage = "D1 save inspection photo";
    await insertPhoto(env, photoId, inspectionId, objectKey, photo.fileName, photo.contentType, createdAt);

    stage = "D1 load safety checks";
    const checks = await loadSafetyChecks(env);

    stage = "Workers AI scene analysis";
    const ai = await runAI(env, photo.bytes, photo.contentType, checks);

    stage = "parse AI JSON";
    const parsed = parseStructuredAIResponse(ai.raw);

    stage = "Vectorize + WSHC checklist enrichment";
    const findings = await normalizeFindings(parsed, checks, env);

    stage = "D1 save inspection items";
    await insertInspectionItems(env, inspectionId, photoId, findings);

    const result = overall(findings);

    stage = "D1 update inspection";
    await updateInspection(env, inspectionId, result);

    return jsonResponse({
      ok: true,
      inspection: {
        id: inspectionId,
        inspection_no: inspectionNo,
        location: input.location,
        inspector: input.inspector,
        overall_result: result,
        created_at: createdAt,
      },
      photo: {
        id: photoId,
        object_key: objectKey,
        file_name: photo.fileName,
        content_type: photo.contentType,
      },
      ai: {
        model: MODEL,
        embedding_model: EMBEDDING_MODEL,
        vectorize_index: "safety-checks",
        vector_match_threshold: VECTOR_MATCH_THRESHOLD,
        response_length: ai.raw.length,
        response_preview: ai.raw.substring(0, 3000),
      },
      summary: buildSummary(findings),
      findings,
      counts: {
        total: findings.length,
        pass: findings.filter(f => f.status === "PASS").length,
        fail: findings.filter(f => f.status === "FAIL").length,
        check_required: findings.filter(f => f.status === "CHECK_REQUIRED").length,
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    if (r2Uploaded && objectKey) {
      try { await env.PHOTOS.delete(objectKey); } catch {}
    }

    if (inspectionId) {
      try { await updateInspection(env, inspectionId, "CHECK_REQUIRED"); } catch {}
    }

    return jsonResponse({
      ok: false,
      error: "AI analysis failed.",
      stage,
      detail,
      inspectionId: inspectionId || null,
      photoId: photoId || null,
      objectKey: objectKey || null,
    }, 500);
  }
}

async function getInspection(env: Env, id: string): Promise<Response> {
  try {
    const inspection = await env.SAFETY_DB.prepare(`
      SELECT * FROM inspections WHERE id = ? LIMIT 1
    `).bind(id).first();

    if (!inspection) return jsonResponse({ ok: false, error: "Inspection not found." }, 404);

    const photos = await env.SAFETY_DB.prepare(`
      SELECT * FROM inspection_photos
      WHERE inspection_id = ?
      ORDER BY created_at
    `).bind(id).all();

    const items = await env.SAFETY_DB.prepare(`
      SELECT ii.*, sc.check_question, sc.guidance, sc.source_type
      FROM inspection_items ii
      LEFT JOIN safety_checks sc ON sc.id = ii.check_id
      WHERE ii.inspection_id = ?
      ORDER BY ii.created_at
    `).bind(id).all();

    await ensureChecklistTable(env);

    const checklist: Record<string, ChecklistItem[]> = {};
    for (const item of (items.results || []) as any[]) {
      if (!item.check_id) continue;
      const equipmentType = detectEquipmentType(
        item.category || "",
        item.title || "",
        item.observation || ""
      );
      checklist[item.id] = await loadChecklistItems(env, item.check_id, equipmentType);
    }

    return jsonResponse({
      ok: true,
      inspection,
      photos: photos.results || [],
      findings: items.results || [],
      checklists: checklist,
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function recentInspections(env: Env): Promise<Response> {
  try {
    const result = await env.SAFETY_DB.prepare(`
      SELECT * FROM inspections ORDER BY created_at DESC LIMIT 30
    `).all();

    return jsonResponse({ ok: true, inspections: result.results || [] });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function safetyChecks(env: Env): Promise<Response> {
  try {
    const checks = await loadSafetyChecks(env);
    return jsonResponse({ ok: true, count: checks.length, checks });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function getChecklist(env: Env, request: Request): Promise<Response> {
  try {
    await ensureChecklistTable(env);
    const url = new URL(request.url);
    const checkId = clean(url.searchParams.get("check_id") || "", 100);
    const equipmentType = clean(url.searchParams.get("equipment_type") || "GENERAL", 100);

    if (!checkId) return jsonResponse({ ok: false, error: "Missing check_id." }, 400);

    const items = await loadChecklistItems(env, checkId, equipmentType);
    return jsonResponse({
      ok: true,
      check_id: checkId,
      equipment_type: equipmentType,
      count: items.length,
      visual_checks: items.filter(i => i.check_type === "VISUAL" || i.check_type === "BOTH"),
      physical_checks: items.filter(i => i.check_type === "PHYSICAL" || i.check_type === "BOTH"),
    });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

async function getPhoto(env: Env, objectKey: string): Promise<Response> {
  try {
    const object = await env.PHOTOS.get(objectKey);
    if (!object) return textResponse("Photo not found.", 404);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Cache-Control", "private, max-age=3600");

    return new Response(object.body, { status: 200, headers });
  } catch (error) {
    return textResponse(error instanceof Error ? error.message : String(error), 500);
  }
}

async function health(env: Env): Promise<Response> {
  let database = false;
  let safetyChecks = false;
  let r2 = false;
  let vectorize = false;
  let checklist = false;

  try {
    await env.SAFETY_DB.prepare("SELECT 1 AS ok").first();
    database = true;
  } catch {}

  try {
    await loadSafetyChecks(env);
    safetyChecks = true;
  } catch {}

  try { r2 = !!env.PHOTOS; } catch {}
  try { vectorize = !!env.VECTORIZE; } catch {}

  try {
    await ensureChecklistTable(env);
    checklist = true;
  } catch {}

  return jsonResponse({
    ok: database && safetyChecks && r2 && vectorize && checklist,
    worker: "depot-safety",
    model: MODEL,
    embedding_model: EMBEDDING_MODEL,
    database,
    safety_checks: safetyChecks,
    r2,
    vectorize,
    vectorize_index: "safety-checks",
    vectorize_dimensions: VECTOR_DIMENSIONS,
    vector_match_threshold: VECTOR_MATCH_THRESHOLD,
    checklist,
    timestamp: nowISO(),
  });
}

function requireSeedKey(request: Request, env: Env): void {
  const configured = clean(env.VECTORIZE_SEED_KEY, 500);
  if (!configured) {
    throw new Error("VECTORIZE_SEED_KEY is not configured. Create this Worker secret before running the seed operation.");
  }

  const supplied =
    request.headers.get("X-Vectorize-Seed-Key") ||
    request.headers.get("X-Vectorize-Seed-Key".toLowerCase()) ||
    "";

  if (supplied !== configured) {
    throw new Error("Invalid Vectorize seed key.");
  }
}

async function seedVectorize(request: Request, env: Env): Promise<Response> {
  try {
    requireSeedKey(request, env);

    const checks = await loadSafetyChecks(env);
    if (!checks.length) return jsonResponse({ ok: false, error: "No active safety checks found." }, 400);

    const inputs = checks.map(check =>
      `${check.category}. ${check.check_question}. ${check.guidance}. Keywords: ${check.keywords}`
    );

    const embeddingResponse: any = await env.AI.run(
      EMBEDDING_MODEL,
      { text: inputs } as any
    );

    const vectors = embeddingResponse?.data;
    if (!Array.isArray(vectors) || vectors.length !== checks.length) {
      throw new Error("Embedding model returned an unexpected number of vectors.");
    }

    const payload = checks.map((check, index) => ({
      id: check.id,
      values: vectors[index],
      metadata: {
        check_id: check.id,
        category: check.category,
        source_type: check.source_type || "WSHC_DERIVED",
      },
    }));

    const result: any = await env.VECTORIZE.upsert(payload as any);

    return jsonResponse({
      ok: true,
      message: "Safety checks successfully indexed into Vectorize.",
      index: "safety-checks",
      embedding_model: EMBEDDING_MODEL,
      dimensions: VECTOR_DIMENSIONS,
      indexed: checks.length,
      ids: checks.map(c => c.id),
      mutation: result,
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
}

type SeedTuple = [
  string,
  string,
  string,
  string,
  CheckType,
  Risk,
  string,
  string,
  SourceType
];

/* Detailed checklist seed. These are WSHC-derived operational prompts.
 * Keep the source URL attached to every item so the UI can trace the guidance.
 */
const CHECKLIST_SEED: SeedTuple[] = [
  // PPE
  ["ppe-visual-001","ppe-001","GENERAL","Required head protection appears to be worn correctly.","VISUAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["ppe-visual-002","ppe-001","GENERAL","High-visibility clothing appears to be worn where the work environment requires visibility.","VISUAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["ppe-physical-001","ppe-001","GENERAL","PPE is suitable for the identified task and hazard.","PHYSICAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["ppe-physical-002","ppe-001","GENERAL","PPE is clean, serviceable and correctly fitted.","PHYSICAL","MEDIUM","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],

  // Housekeeping
  ["house-visual-001","house-001","GENERAL","Walking and working areas are visibly free of unnecessary obstruction.","VISUAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["house-visual-002","house-001","GENERAL","No visible oil, water, waste or loose materials create a slip or trip hazard.","VISUAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["house-physical-001","house-001","GENERAL","Waste is segregated and disposed of according to workplace arrangements.","PHYSICAL","MEDIUM","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["house-physical-002","house-002","GENERAL","Emergency access, exits and firefighting equipment are kept clear.","PHYSICAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],

  // Vehicular
  ["veh-visual-001","veh-001","VEHICLE","Vehicle and pedestrian routes appear clearly separated where required.","VISUAL","HIGH","WSHC Vehicular Safety","https://www.tal.sg/wshc/topics/vehicular-safety","WSHC_DIRECT"],
  ["veh-visual-002","veh-002","VEHICLE","Traffic signs, barriers and demarcation appear visible and unobstructed.","VISUAL","HIGH","WSHC Vehicular Safety","https://www.tal.sg/wshc/topics/vehicular-safety","WSHC_DIRECT"],
  ["veh-physical-001","veh-001","VEHICLE","Vehicle movement controls and designated routes are implemented.","PHYSICAL","HIGH","WSHC Vehicular Safety","https://www.tal.sg/wshc/topics/vehicular-safety","WSHC_DIRECT"],
  ["veh-physical-002","veh-003","VEHICLE","Reversing controls, banksman arrangements and visibility controls are verified where applicable.","PHYSICAL","HIGH","WSHC Vehicular Safety","https://www.tal.sg/wshc/topics/vehicular-safety","WSHC_DIRECT"],

  // Lifting
  ["lifting-visual-001","lifting-001","LIFTING_GEAR","Lifting gear, hooks, slings or spreader components show no obvious damage.","VISUAL","HIGH","WSHC Lifting","https://www.tal.sg/wshc/topics/lifting-operations","WSHC_DIRECT"],
  ["lifting-visual-002","lifting-001","LIFTING_GEAR","People are not visibly positioned within an obvious suspended-load danger area.","VISUAL","HIGH","WSHC Lifting","https://www.tal.sg/wshc/topics/lifting-operations","WSHC_DIRECT"],
  ["lifting-physical-001","lifting-001","LIFTING_GEAR","Safe Working Load and equipment suitability are verified before lifting.","PHYSICAL","HIGH","WSHC Lifting","https://www.tal.sg/wshc/topics/lifting-operations","WSHC_DIRECT"],
  ["lifting-physical-002","lifting-001","LIFTING_GEAR","Lifting accessories have valid inspection and certification status.","PHYSICAL","HIGH","WSHC Lifting","https://www.tal.sg/wshc/topics/lifting-operations","WSHC_DIRECT"],

  // Work at Height
  ["wah-visual-001","work-height-001","MOBILE_ACCESS_PLATFORM","Open edges are protected by effective guardrails or barriers.","VISUAL","HIGH","WSHC Preventing Falls from Height","https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights","WSHC_DIRECT"],
  ["wah-visual-002","work-height-001","MOBILE_ACCESS_PLATFORM","Platform and structural members show no obvious cracks, bends or serious corrosion.","VISUAL","HIGH","WSHC Preventing Falls from Height","https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights","WSHC_DERIVED"],
  ["wah-visual-003","work-height-001","LADDER","Ladder appears free from obvious defects and is positioned securely.","VISUAL","HIGH","WSHC Preventing Falls from Height","https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights","WSHC_DERIVED"],
  ["wah-physical-001","work-height-001","MOBILE_ACCESS_PLATFORM","Guardrails, mid-rails and toe-boards are securely fixed.","PHYSICAL","HIGH","WSHC Preventing Falls from Height","https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights","WSHC_DIRECT"],
  ["wah-physical-002","work-height-001","MOBILE_ACCESS_PLATFORM","Wheels or castors are locked and the structure is stable before use.","PHYSICAL","HIGH","WSHC Preventing Falls from Height","https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights","WSHC_DERIVED"],
  ["wah-physical-003","work-height-001","MOBILE_ACCESS_PLATFORM","Inspection or tagging status is verified before use.","PHYSICAL","HIGH","WSHC Preventing Falls from Height","https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights","WSHC_DERIVED"],
  ["wah-physical-004","work-height-001","LADDER","Stable and level ground, safe access and three-point contact requirements are verified.","PHYSICAL","HIGH","WSHC Preventing Falls from Height","https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights","WSHC_DERIVED"],
  ["wah-ladder-visual-001","work-height-001","LADDER","Ladder rungs, stiles and feet show no obvious damage, excessive wear or missing components.","VISUAL","HIGH","WSHC Safe Use of Ladders Checklist","https://www.tal.sg/wshc/topics/work-at-height","WSHC_DERIVED"],
  ["wah-ladder-visual-002","work-height-001","LADDER","Ladder is free from obvious oil, grease, mud or other conditions that could cause slipping.","VISUAL","HIGH","WSHC Safe Use of Ladders Checklist","https://www.tal.sg/wshc/topics/work-at-height","WSHC_DERIVED"],
  ["wah-ladder-visual-003","work-height-001","LADDER","Ladder is positioned to provide safe access and is not visibly placed on an unstable support.","VISUAL","HIGH","WSHC Safe Use of Ladders Checklist","https://www.tal.sg/wshc/topics/work-at-height","WSHC_DERIVED"],
  ["wah-ladder-physical-001","work-height-001","LADDER","Ladder is secured against slipping, sliding or overturning before use.","PHYSICAL","HIGH","WSHC Safe Use of Ladders Checklist","https://www.tal.sg/wshc/topics/work-at-height","WSHC_DERIVED"],
  ["wah-ladder-physical-002","work-height-001","LADDER","Worker maintains three-point contact when climbing or working from the ladder.","PHYSICAL","HIGH","WSHC Safe Use of Ladders Checklist","https://www.tal.sg/wshc/topics/work-at-height","WSHC_DERIVED"],
  ["wah-ladder-physical-003","work-height-001","LADDER","Worker does not stand on the top rung or otherwise use the ladder beyond its safe working limits.","PHYSICAL","HIGH","WSHC Safe Use of Ladders Checklist","https://www.tal.sg/wshc/topics/work-at-height","WSHC_DERIVED"],
  ["wah-ladder-physical-004","work-height-001","LADDER","Ladder is suitable for the task and the worker can maintain a safe handhold and footing.","PHYSICAL","HIGH","WSHC Safe Use of Ladders Checklist","https://www.tal.sg/wshc/topics/work-at-height","WSHC_DERIVED"],

  ["wah-visual-004","work-height-001","SCAFFOLD","Scaffold components, working platforms and guardrails show no obvious damage or missing sections.","VISUAL","HIGH","WSHC Preventing Falls from Height","https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights","WSHC_DIRECT"],
  ["wah-physical-005","work-height-001","SCAFFOLD","Scaffold stability, access, guardrails and inspection/tagging status are verified before use.","PHYSICAL","HIGH","WSHC Preventing Falls from Height","https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights","WSHC_DIRECT"],
  ["wah-physical-006","work-height-001","GENERAL","Safe access and egress, fall prevention and safe work procedures are verified for the work-at-height activity.","PHYSICAL","HIGH","WSHC Preventing Falls from Height","https://www.tal.sg/wshc/topics/work-at-height/preventing-falls-from-heights","WSHC_DIRECT"],

  // Chemical
  ["chem-visual-001","chemical-001","CHEMICAL","Chemical containers appear closed, intact and appropriately labelled.","VISUAL","HIGH","WSHC Preventing Chemical Hazards","https://www.tal.sg/wshc/topics/chemicals/preventing-chemical-hazards","WSHC_DIRECT"],
  ["chem-visual-002","chemical-001","CHEMICAL","No obvious chemical leakage or uncontrolled spill is visible.","VISUAL","HIGH","WSHC Preventing Chemical Hazards","https://www.tal.sg/wshc/topics/chemicals/preventing-chemical-hazards","WSHC_DIRECT"],
  ["chem-physical-001","chemical-001","CHEMICAL","Safety Data Sheet and chemical hazard information are available to workers.","PHYSICAL","HIGH","WSHC Preventing Chemical Hazards","https://www.tal.sg/wshc/topics/chemicals/preventing-chemical-hazards","WSHC_DIRECT"],
  ["chem-physical-002","chemical-001","CHEMICAL","Chemical storage, segregation and emergency controls are verified.","PHYSICAL","HIGH","WSHC Preventing Chemical Hazards","https://www.tal.sg/wshc/topics/chemicals/preventing-chemical-hazards","WSHC_DIRECT"],

  // Confined Space
  ["conf-visual-001","confined-001","GENERAL","Confined-space entry points are identified and access is controlled.","VISUAL","HIGH","WSHC Confined Space resources","https://www.tal.sg/wshc/topics/confined-space","WSHC_DERIVED"],
  ["conf-visual-002","confined-001","GENERAL","Warning signage and barriers are visible where required.","VISUAL","HIGH","WSHC Confined Space resources","https://www.tal.sg/wshc/topics/confined-space","WSHC_DERIVED"],
  ["conf-physical-001","confined-001","GENERAL","Entry permit and risk assessment are verified before entry.","PHYSICAL","HIGH","WSHC Confined Space resources","https://www.tal.sg/wshc/topics/confined-space","WSHC_DERIVED"],
  ["conf-physical-002","confined-001","GENERAL","Atmospheric testing, ventilation, attendant and rescue arrangements are verified where applicable.","PHYSICAL","HIGH","WSHC Confined Space resources","https://www.tal.sg/wshc/topics/confined-space","WSHC_DERIVED"],

  // Electrical
  ["elec-visual-001","electrical-001","ELECTRICAL_TOOL","Electrical cords, plugs and equipment show no obvious damage or exposed conductors.","VISUAL","HIGH","WSHC Electrical Safety","https://www.tal.sg/wshc/topics/electrical-safety/electrical-safety","WSHC_DIRECT"],
  ["elec-visual-002","electrical-001","ELECTRICAL_TOOL","Electrical equipment is kept away from visible wet or damp conditions.","VISUAL","HIGH","WSHC Electrical Safety","https://www.tal.sg/wshc/topics/electrical-safety/electrical-safety","WSHC_DIRECT"],
  ["elec-physical-001","electrical-001","ELECTRICAL_TOOL","Equipment grounding and suitability of the electrical connection are verified.","PHYSICAL","HIGH","WSHC Electrical Safety","https://www.tal.sg/wshc/topics/electrical-safety/electrical-safety","WSHC_DIRECT"],
  ["elec-physical-002","electrical-001","ELECTRICAL_TOOL","LOTO is implemented for applicable maintenance or repair work.","PHYSICAL","HIGH","WSHC Electrical Safety","https://www.tal.sg/wshc/topics/electrical-safety/electrical-safety","WSHC_DIRECT"],

  // Fire
  ["fire-visual-001","fire-001","GENERAL","Fire extinguishers and fire equipment are accessible and not visibly obstructed.","VISUAL","HIGH","WSHC Fire Safety resources","https://www.tal.sg/wshc/-/media/tal/wshc/resources/publications/checklists-and-articles/files/managing-fire-risks-and-hazards-in-buildings.pdf","WSHC_DERIVED"],
  ["fire-visual-002","fire-001","HOT_WORK","Combustible materials are not visibly exposed to sparks or hot-work activity.","VISUAL","HIGH","WSHC Fire Safety resources","https://www.tal.sg/wshc/-/media/tal/wshc/resources/publications/checklists-and-articles/files/managing-fire-risks-and-hazards-in-buildings.pdf","WSHC_DERIVED"],
  ["fire-physical-001","fire-001","GENERAL","Fire extinguisher inspection/status is verified.","PHYSICAL","HIGH","WSHC Fire Safety resources","https://www.tal.sg/wshc/-/media/tal/wshc/resources/publications/checklists-and-articles/files/managing-fire-risks-and-hazards-in-buildings.pdf","WSHC_DERIVED"],
  ["fire-physical-002","fire-001","HOT_WORK","Hot-work permit and fire-watch arrangements are verified where applicable.","PHYSICAL","HIGH","WSHC Fire Safety resources","https://www.tal.sg/wshc/-/media/tal/wshc/resources/publications/checklists-and-articles/files/managing-fire-risks-and-hazards-in-buildings.pdf","WSHC_DERIVED"],

  // Forklift
  ["fork-visual-001","forklift-001","FORKLIFT","Forks, tyres and visible forklift components show no obvious damage.","VISUAL","HIGH","WSHC Operating Forklifts Safely","https://www.tal.sg/wshc/topics/forklift/operating-forklifts-safely","WSHC_DIRECT"],
  ["fork-visual-002","forklift-001","FORKLIFT","Seat belt and visible warning devices appear present.","VISUAL","HIGH","WSHC Operating Forklifts Safely","https://www.tal.sg/wshc/topics/forklift/operating-forklifts-safely","WSHC_DIRECT"],
  ["fork-physical-001","forklift-001","FORKLIFT","Controls, steering, tyres, foot brake, lights, mirror and reverse warning buzzer are checked before operation.","PHYSICAL","HIGH","WSHC Operating Forklifts Safely","https://www.tal.sg/wshc/topics/forklift/operating-forklifts-safely","WSHC_DIRECT"],
  ["fork-physical-002","forklift-001","FORKLIFT","Operator authorisation, training and seat-belt use are verified.","PHYSICAL","HIGH","WSHC Operating Forklifts Safely","https://www.tal.sg/wshc/topics/forklift/operating-forklifts-safely","WSHC_DIRECT"],

  // Hot work
  ["hot-visual-001","hot-work-001","WELDING","Welding, cutting or grinding sparks are contained away from combustible materials.","VISUAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["hot-visual-002","hot-work-001","WELDING","Gas cylinders, hoses and regulators show no obvious damage or unsafe placement.","VISUAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["hot-physical-001","hot-work-001","WELDING","Hot-work permit and fire-watch requirements are verified where applicable.","PHYSICAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["hot-physical-002","hot-work-001","WELDING","Gas cylinders are secured upright and separated/handled according to workplace controls.","PHYSICAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],

  // Loading
  ["load-visual-001","loading-001","VEHICLE","Cargo appears stable and not obviously top-heavy or unsecured.","VISUAL","HIGH","WSHC Loading and Unloading Operations","https://www.tal.sg/wshc/topics/vehicular-safety/loading-and-unloading-operations","WSHC_DIRECT"],
  ["load-visual-002","loading-001","VEHICLE","Loading/unloading area appears designated and free of unnecessary obstruction.","VISUAL","HIGH","WSHC Loading and Unloading Operations","https://www.tal.sg/wshc/topics/vehicular-safety/loading-and-unloading-operations","WSHC_DIRECT"],
  ["load-physical-001","loading-001","VEHICLE","Parking brake, wheel chocks and vehicle stability controls are verified.","PHYSICAL","HIGH","WSHC Loading and Unloading Operations","https://www.tal.sg/wshc/topics/vehicular-safety/loading-and-unloading-operations","WSHC_DIRECT"],
  ["load-physical-002","loading-001","VEHICLE","Cargo securing, lashing/dunnage and safe access/egress are verified.","PHYSICAL","HIGH","WSHC Loading and Unloading Operations","https://www.tal.sg/wshc/topics/vehicular-safety/loading-and-unloading-operations","WSHC_DIRECT"],

  // Machinery
  ["mach-visual-001","machinery-001","GENERAL","Machine guards appear present and moving parts are not visibly exposed.","VISUAL","HIGH","WSHC Preventing Machine Hazards","https://www.tal.sg/wshc/topics/machinery-safety/preventing-machine-hazards","WSHC_DIRECT"],
  ["mach-visual-002","machinery-001","GENERAL","Machine shows no obvious abnormal damage or unsafe condition.","VISUAL","HIGH","WSHC Preventing Machine Hazards","https://www.tal.sg/wshc/topics/machinery-safety/preventing-machine-hazards","WSHC_DIRECT"],
  ["mach-physical-001","machinery-001","GENERAL","Emergency stop and guarding arrangements are verified before use.","PHYSICAL","HIGH","WSHC Preventing Machine Hazards","https://www.tal.sg/wshc/topics/machinery-safety/preventing-machine-hazards","WSHC_DIRECT"],
  ["mach-physical-002","machinery-001","GENERAL","LOTO and preventive maintenance arrangements are verified for applicable maintenance work.","PHYSICAL","HIGH","WSHC Preventing Machine Hazards","https://www.tal.sg/wshc/topics/machinery-safety/preventing-machine-hazards","WSHC_DIRECT"],

  // Manual handling / ergonomics
  ["erg-visual-001","ergonomics-001","GENERAL","Task shows no obvious excessive reaching, twisting or awkward lifting posture.","VISUAL","MEDIUM","WSHC Workplace Ergonomics","https://www.tal.sg/wshc/topics/ergonomics/about-workplace-ergonomics","WSHC_DIRECT"],
  ["erg-visual-002","ergonomics-001","GENERAL","Load appears manageable or mechanical assistance is visibly used where appropriate.","VISUAL","MEDIUM","WSHC Workplace Ergonomics","https://www.tal.sg/wshc/topics/ergonomics/about-workplace-ergonomics","WSHC_DIRECT"],
  ["erg-physical-001","ergonomics-001","GENERAL","Load weight, handling frequency and task demands are assessed.","PHYSICAL","MEDIUM","WSHC Workplace Ergonomics","https://www.tal.sg/wshc/topics/ergonomics/about-workplace-ergonomics","WSHC_DIRECT"],
  ["erg-physical-002","ergonomics-001","GENERAL","Mechanical aids or team lifting are used when the load/task requires them.","PHYSICAL","HIGH","WSHC Workplace Ergonomics","https://www.tal.sg/wshc/topics/ergonomics/about-workplace-ergonomics","WSHC_DIRECT"],

  // Noise
  ["noise-visual-001","noise-001","GENERAL","Visible high-noise equipment/activity is identified for assessment.","VISUAL","MEDIUM","WSHC Noise","https://www.tal.sg/wshc/topics/noise","WSHC_DIRECT"],
  ["noise-physical-001","noise-001","GENERAL","Noise exposure is assessed where workers may be exposed to hazardous noise.","PHYSICAL","HIGH","WSHC Noise","https://www.tal.sg/wshc/topics/noise","WSHC_DIRECT"],
  ["noise-physical-002","noise-001","GENERAL","Hearing protection and hearing conservation controls are implemented where required.","PHYSICAL","HIGH","WSHC Noise","https://www.tal.sg/wshc/topics/noise","WSHC_DIRECT"],

  // Reach stacker
  ["rs-visual-001","reach-stacker-001","REACH_STACKER","Tyres, spreader and visible structural components show no obvious damage.","VISUAL","HIGH","WSHC Vehicular Safety","https://www.tal.sg/wshc/topics/vehicular-safety","WSHC_DIRECT"],
  ["rs-visual-002","reach-stacker-001","REACH_STACKER","Warning lights, alarms and visibility aids appear present.","VISUAL","HIGH","WSHC Vehicular Safety","https://www.tal.sg/wshc/topics/vehicular-safety","WSHC_DERIVED"],
  ["rs-physical-001","reach-stacker-001","REACH_STACKER","Pre-operation inspection, brakes, steering, alarms and controls are verified.","PHYSICAL","HIGH","WSHC Vehicular Safety","https://www.tal.sg/wshc/topics/vehicular-safety","WSHC_DERIVED"],
  ["rs-physical-002","reach-stacker-001","REACH_STACKER","Spreader locking, load limits and operator authorisation are verified.","PHYSICAL","HIGH","WSHC Vehicular Safety","https://www.tal.sg/wshc/topics/vehicular-safety","WSHC_DERIVED"],

  // Risk assessment
  ["risk-visual-001","risk-001","GENERAL","Work activity has visible controls consistent with the identified hazards.","VISUAL","MEDIUM","WSHC Risk Management","https://www.tal.sg/wshc/topics/risk-management","WSHC_DIRECT"],
  ["risk-physical-001","risk-001","GENERAL","Risk assessment covers the activity and significant hazards.","PHYSICAL","HIGH","WSHC Risk Management","https://www.tal.sg/wshc/topics/risk-management","WSHC_DIRECT"],
  ["risk-physical-002","risk-001","GENERAL","Safe work procedures and worker communication are verified.","PHYSICAL","HIGH","WSHC Risk Management","https://www.tal.sg/wshc/topics/risk-management","WSHC_DIRECT"],

  // Slips/trips/falls
  ["stf-visual-001","sliptrip-001","GENERAL","Floor and walking surfaces appear free of visible spill, debris and trip hazards.","VISUAL","HIGH","WSHC Slips, Trips and Falls resources","https://www.tal.sg/wshc/topics/slips-trips-and-falls","WSHC_DIRECT"],
  ["stf-visual-002","sliptrip-001","GENERAL","Cables, hoses and temporary items do not visibly obstruct walkways.","VISUAL","HIGH","WSHC Slips, Trips and Falls resources","https://www.tal.sg/wshc/topics/slips-trips-and-falls","WSHC_DIRECT"],
  ["stf-physical-001","sliptrip-001","GENERAL","Floor condition, drainage and housekeeping controls are verified.","PHYSICAL","HIGH","WSHC Slips, Trips and Falls resources","https://www.tal.sg/wshc/topics/slips-trips-and-falls","WSHC_DIRECT"],

  // Storage
  ["store-visual-001","storage-001","GENERAL","Stored materials appear stable and not visibly leaning or at risk of toppling.","VISUAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["store-visual-002","storage-001","GENERAL","Aisles and access routes are visibly clear.","VISUAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["store-physical-001","storage-001","GENERAL","Storage arrangement, stack height and load limits are verified.","PHYSICAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
  ["store-physical-002","storage-001","GENERAL","Damaged pallets, racks or storage equipment are removed or controlled.","PHYSICAL","HIGH","WSHC Workplace Safety and Health resources","https://www.tal.sg/wshc/resources","WSHC_DERIVED"],
];

async function seedChecklist(request: Request, env: Env): Promise<Response> {
  try {
    requireSeedKey(request, env);
    await ensureChecklistTable(env);

    const safetyColumns = await getTableColumns(env.SAFETY_DB, "safety_checks");

    const existingIds = await env.SAFETY_DB.prepare(
      `SELECT id FROM safety_checks`
    ).all<{ id: string }>();

    const existing = new Set((existingIds.results || []).map(x => x.id));

    const valid = (CHECKLIST_SEED as SeedTuple[]).filter(row => existing.has(row[1]));

    if (!valid.length) {
      return jsonResponse({
        ok: false,
        error: "No checklist seed records matched existing safety_checks IDs.",
      }, 400);
    }

    const statements = valid.map(row =>
      env.SAFETY_DB.prepare(`
        INSERT OR REPLACE INTO safety_check_items
        (id, safety_check_id, equipment_type, check_item, check_type, importance, source_title, source_url, source_type, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).bind(...row)
    );

    await env.SAFETY_DB.batch(statements);

    return jsonResponse({
      ok: true,
      message: "Detailed WSHC checklist items seeded successfully.",
      indexed: valid.length,
      categories: [...new Set(valid.map(row => row[1]))].length,
      table: "safety_check_items",
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/health") return health(env);

  if (request.method === "POST" && (path === "/api/analyze" || path === "/api/analysis")) {
    return analyze(request, env);
  }

  if (request.method === "GET" && path === "/api/inspections") return recentInspections(env);

  if (request.method === "GET" && path.startsWith("/api/inspection/")) {
    const id = decodeURIComponent(path.substring("/api/inspection/".length));
    if (!id) return jsonResponse({ ok: false, error: "Missing inspection ID." }, 400);
    return getInspection(env, id);
  }

  if (request.method === "GET" && path === "/api/safety-checks") return safetyChecks(env);

  if (request.method === "GET" && path === "/api/checklist") return getChecklist(env, request);

  if (request.method === "GET" && path === "/api/photo") {
    const key = url.searchParams.get("key");
    if (!key) return textResponse("Missing photo key.", 400);
    return getPhoto(env, key);
  }

  if (request.method === "POST" && path === "/api/vectorize/seed") {
    return seedVectorize(request, env);
  }

  if (request.method === "POST" && path === "/api/checklist/seed") {
    return seedChecklist(request, env);
  }

  return jsonResponse({
    ok: false,
    error: "API endpoint not found.",
    path,
  }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Vectorize-Seed-Key",
          },
        });
      }

      const url = new URL(request.url);

      if (url.pathname.startsWith("/api/")) {
        return api(request, env, url);
      }

      try {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return asset;
      } catch {}

      return new Response("Depot Safety AI is running.", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch (error) {
      return jsonResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
