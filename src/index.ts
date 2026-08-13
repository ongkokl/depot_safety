interface Env {
  AI: Ai;
  SAFETY_DB: D1Database;
  PHOTOS: R2Bucket;
  VECTORIZE?: VectorizeIndex;
}

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  };
}

async function analyzeImage(env: Env, imageDataUrl: string) {
  const system = `
You are an AI assistant for Singapore workplace safety inspections.
Your job is to identify visible safety-related situations, not to declare legal compliance.
Use only what can reasonably be observed in the image.

Return ONLY valid JSON:
{
  "scene_summary": "short description",
  "categories": ["Vehicular Safety", "Housekeeping", "PPE", "Work at Height", "Lifting", "Other"],
  "observations": [
    {
      "category": "one category",
      "title": "short finding title",
      "observation": "what is visibly observed",
      "risk_level": "HIGH|MEDIUM|LOW",
      "confidence": 0.0,
      "status": "FAIL|CHECK_REQUIRED|PASS"
    }
  ]
}

Rules:
- Do not invent objects or conditions.
- If the image is insufficient to determine compliance, use CHECK_REQUIRED.
- PASS means only that the visible condition appears acceptable; it is not a legal compliance determination.
- Prioritise vehicle/pedestrian interaction, housekeeping, PPE, work at height, lifting and obvious physical hazards.
- confidence must be between 0 and 1.
`;

  const response: any = await env.AI.run(VISION_MODEL, {
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: "Analyse this workplace photo for safety inspection purposes."
      }
    ],
    image: imageDataUrl,
    temperature: 0.1,
    max_tokens: 1400
  });

  const raw = response?.response ?? response?.result ?? "";
  const cleaned = String(raw).replace(/^```json\s*/i, "").replace(/```$/i, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      scene_summary: "The AI returned an unstructured observation.",
      categories: ["Other"],
      observations: [{
        category: "Other",
        title: "AI analysis requires review",
        observation: cleaned.slice(0, 1500),
        risk_level: "MEDIUM",
        confidence: 0.5,
        status: "CHECK_REQUIRED"
      }]
    };
  }
}

async function findRelevantChecks(env: Env, observations: any[]) {
  const categories = [...new Set(
    observations.map(o => String(o.category || "")).filter(Boolean)
  )];

  let checks: any[] = [];
  if (categories.length) {
    const placeholders = categories.map(() => "?").join(",");
    const result = await env.SAFETY_DB.prepare(
      `SELECT * FROM safety_checks WHERE active=1 AND category IN (${placeholders})`
    ).bind(...categories).all();
    checks = result.results || [];
  }

  // Vector search provides semantic matching when the Vectorize binding/index exists.
  if (env.VECTORIZE && observations.length) {
    try {
      const queryText = observations.map(o =>
        `${o.category}: ${o.title}. ${o.observation}`
      ).join("\n");
      const embedding: any = await env.AI.run(EMBEDDING_MODEL, {
        text: [queryText],
        pooling: "cls"
      });
      const vector = embedding?.data?.[0];
      if (vector) {
        const matches: any = await env.VECTORIZE.query(vector, {
          topK: 8,
          returnMetadata: "all"
        });
        const ids = (matches?.matches || []).map((m: any) => String(m.id));
        if (ids.length) {
          const p = ids.map(() => "?").join(",");
          const semantic = await env.SAFETY_DB.prepare(
            `SELECT * FROM safety_checks WHERE id IN (${p}) AND active=1`
          ).bind(...ids).all();
          checks = [...checks, ...(semantic.results || [])];
        }
      }
    } catch {
      // Vectorize is optional in the MVP; category matching still works.
    }
  }

  const unique = new Map<string, any>();
  for (const c of checks) unique.set(String(c.id), c);
  return [...unique.values()];
}

function enrichFindings(observations: any[], checks: any[]) {
  return observations.map(o => {
    const candidates = checks.filter(c => c.category === o.category);
    const lower = `${o.title} ${o.observation}`.toLowerCase();
    const check = candidates.find(c =>
      String(c.keywords).split(",").some((k: string) => lower.includes(k.trim().toLowerCase()))
    ) || candidates[0];

    return {
      ...o,
      check_id: check?.id ?? null,
      source_title: check?.source_title ?? null,
      source_url: check?.source_url ?? null,
      check_question: check?.check_question ?? null,
      guidance: check?.guidance ?? null
    };
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true, service: "safety-inspection-ai" });
      }

      if (url.pathname === "/api/checks" && request.method === "GET") {
        const { results } = await env.SAFETY_DB.prepare(
          "SELECT * FROM safety_checks WHERE active=1 ORDER BY category, id"
        ).all();
        return json({ checks: results });
      }

      if (url.pathname === "/api/inspections" && request.method === "GET") {
        const { results } = await env.SAFETY_DB.prepare(`
          SELECT i.*, COUNT(f.id) AS finding_count
          FROM inspections i
          LEFT JOIN findings f ON f.inspection_id = i.id
          GROUP BY i.id
          ORDER BY i.created_at DESC
          LIMIT 100
        `).all();
        return json({ inspections: results });
      }

      if (url.pathname === "/api/analyze" && request.method === "POST") {
        const form = await request.formData();
        const file = form.get("photo");
        const location = String(form.get("location") || "Unspecified");
        const inspector = String(form.get("inspector") || "Inspector");

        if (!(file instanceof File)) return json({ error: "Photo is required." }, 400);
        if (!file.type.startsWith("image/")) return json({ error: "Only image files are supported." }, 400);
        if (file.size > 8 * 1024 * 1024) return json({ error: "Maximum photo size is 8 MB." }, 400);

        const inspectionId = id("insp");
        const inspectionNo = `SI-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;
        const photoId = id("photo");
        const objectKey = `${new Date().toISOString().slice(0,10)}/${inspectionId}/${photoId}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

        await env.PHOTOS.put(objectKey, file.stream(), {
          httpMetadata: { contentType: file.type }
        });

        await env.SAFETY_DB.prepare(`
          INSERT INTO inspections (id, inspection_no, location, inspector, created_at, overall_result)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(
          inspectionId, inspectionNo, location, inspector, now(), "CHECK_REQUIRED"
        ).run();

        await env.SAFETY_DB.prepare(`
          INSERT INTO inspection_photos (id, inspection_id, object_key, file_name, content_type, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(photoId, inspectionId, objectKey, file.name, file.type, now()).run();

        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        const imageDataUrl = `data:${file.type};base64,${btoa(binary)}`;

        const ai = await analyzeImage(env, imageDataUrl);
        const checks = await findRelevantChecks(env, ai.observations || []);
        const findings = enrichFindings(ai.observations || [], checks);

        const overall = findings.some(f => f.status === "FAIL" && f.risk_level === "HIGH")
          ? "ATTENTION"
          : findings.some(f => f.status === "FAIL" || f.status === "CHECK_REQUIRED")
            ? "CHECK_REQUIRED"
            : "PASS";

        await env.SAFETY_DB.prepare(
          "UPDATE inspections SET overall_result=? WHERE id=?"
        ).bind(overall, inspectionId).run();

        for (const f of findings) {
          await env.SAFETY_DB.prepare(`
            INSERT INTO findings
            (id, inspection_id, photo_id, category, title, observation, status, risk_level, confidence, check_id, source_title, source_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            id("find"),
            inspectionId,
            photoId,
            f.category || "Other",
            f.title || "Safety observation",
            f.observation || "",
            f.status || "CHECK_REQUIRED",
            f.risk_level || "MEDIUM",
            Number(f.confidence || 0.5),
            f.check_id,
            f.source_title,
            f.source_url,
            now()
          ).run();
        }

        return json({
          inspection_id: inspectionId,
          inspection_no: inspectionNo,
          location,
          inspector,
          overall_result: overall,
          scene_summary: ai.scene_summary,
          findings
        });
      }

      if (url.pathname.startsWith("/api/inspections/") && request.method === "GET") {
        const inspectionId = url.pathname.split("/").pop();
        const inspection = await env.SAFETY_DB.prepare(
          "SELECT * FROM inspections WHERE id=?"
        ).bind(inspectionId).first();

        if (!inspection) return json({ error: "Inspection not found." }, 404);

        const { results: findings } = await env.SAFETY_DB.prepare(
          "SELECT * FROM findings WHERE inspection_id=? ORDER BY created_at"
        ).bind(inspectionId).all();

        return json({ inspection, findings });
      }

      return env.ASSETS.fetch(request);
    } catch (error: any) {
      console.error(error);
      return json({
        error: "Server error",
        detail: String(error?.message || error)
      }, 500);
    }
  }
};
