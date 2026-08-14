function parseSceneTextFallback(
  raw: string
): SceneAnalysis {

  const text =
    raw
      .replace(
        /\r/g,
        ""
      )
      .trim();

  const items:
    SceneItem[] = [];

  /*
   * Helper to add an item without duplicates.
   */

  function addItem(
    item: string,
    category: string,
    confidence: number,
    details: string
  ) {

    const exists =
      items.some(
        existing =>
          existing.item
            .toLowerCase() ===
          item.toLowerCase()
      );

    if (exists) {
      return;
    }

    items.push({

      item,

      category:
        normalizeCategory(
          category
        ),

      confidence,

      visible_details:
        clean(
          details,
          500
        ),
    });
  }

  /*
   * -------------------------------------------------------
   * PPE
   * -------------------------------------------------------
   */

  if (
    /\bhard hat\b|\bsafety helmet\b|\bhelmet\b/i
      .test(text)
  ) {

    addItem(
      "Hard hat",
      "PPE",
      0.90,
      "A hard hat is visibly worn by the worker."
    );
  }

  if (
    /\bhigh[- ]visibility vest\b|\bhi[- ]vis vest\b|\bhigh visibility\b/i
      .test(text)
  ) {

    addItem(
      "High-visibility vest",
      "PPE",
      0.90,
      "A high-visibility vest is visibly worn by the worker."
    );
  }

  if (
    /\bsafety shoes\b|\bsafety boots\b/i
      .test(text)
  ) {

    addItem(
      "Safety footwear",
      "PPE",
      0.75,
      "Safety footwear is described as visible."
    );
  }

  if (
    /\bgloves\b/i
      .test(text)
  ) {

    addItem(
      "Protective gloves",
      "PPE",
      0.75,
      "Protective gloves are described as visible."
    );
  }

  /*
   * -------------------------------------------------------
   * WORK AT HEIGHT
   * -------------------------------------------------------
   */

  if (
    /\bladder\b/i
      .test(text)
  ) {

    addItem(
      "Ladder",
      "Work at Height",
      0.95,
      "A ladder is visibly present beside the worker."
    );
  }

  if (
    /\bmobile access platform\b|\baccess platform\b|\bworking platform\b/i
      .test(text)
  ) {

    addItem(
      "Access platform",
      "Work at Height",
      0.90,
      "An access or working platform is visibly present."
    );
  }

  if (
    /\bguardrail\b|\bguard rail\b|\bhandrail\b/i
      .test(text)
  ) {

    addItem(
      "Guardrail / handrail",
      "Work at Height",
      0.85,
      "A guardrail or handrail is visibly present."
    );
  }

  /*
   * -------------------------------------------------------
   * REACH STACKER
   * -------------------------------------------------------
   */

  if (
    /\breach stacker\b/i
      .test(text)
  ) {

    addItem(
      "Reach stacker",
      "Reach Stacker Safety",
      0.95,
      "A reach stacker is visibly present."
    );
  }

  /*
   * -------------------------------------------------------
   * FORKLIFT
   * -------------------------------------------------------
   */

  if (
    /\bforklift\b/i
      .test(text)
  ) {

    addItem(
      "Forklift",
      "Forklift Safety",
      0.95,
      "A forklift is visibly present."
    );
  }

  /*
   * -------------------------------------------------------
   * LIFTING
   * -------------------------------------------------------
   */

  if (
    /\blifting equipment\b|\bcrane\b|\bsling\b|\bchain sling\b|\bhook\b|\bshackle\b/i
      .test(text)
  ) {

    addItem(
      "Lifting equipment",
      "Lifting",
      0.85,
      "Lifting equipment is described as visible."
    );
  }

  /*
   * -------------------------------------------------------
   * HOT WORK
   * -------------------------------------------------------
   */

  if (
    /\bwelding\b|\bwelding equipment\b|\bcutting equipment\b|\bhot work\b/i
      .test(text)
  ) {

    addItem(
      "Hot work equipment/activity",
      "Hot Work",
      0.90,
      "Hot work or associated equipment is visibly described."
    );
  }

  /*
   * -------------------------------------------------------
   * GAS CYLINDER
   * -------------------------------------------------------
   */

  if (
    /\bgas cylinder\b|\bgas bottle\b|\bcylinder\b/i
      .test(text)
  ) {

    addItem(
      "Gas cylinder",
      "Chemical Safety",
      0.80,
      "A gas cylinder is described as visible."
    );
  }

  /*
   * -------------------------------------------------------
   * ELECTRICAL
   * -------------------------------------------------------
   */

  if (
    /\belectrical equipment\b|\belectrical cable\b|\belectrical panel\b|\bpower cable\b/i
      .test(text)
  ) {

    addItem(
      "Electrical equipment",
      "Electrical Safety",
      0.80,
      "Electrical equipment is described as visible."
    );
  }

  /*
   * -------------------------------------------------------
   * MACHINERY
   * -------------------------------------------------------
   */

  if (
    /\bmachinery\b|\bmachine\b|\bmechanical equipment\b/i
      .test(text)
  ) {

    addItem(
      "Machinery",
      "Machinery Safety",
      0.75,
      "Machinery is described as visible."
    );
  }

  /*
   * -------------------------------------------------------
   * VEHICLES
   * -------------------------------------------------------
   */

  if (
    /\btruck\b|\bvehicle\b|\blorry\b|\bprime mover\b/i
      .test(text)
  ) {

    addItem(
      "Vehicle",
      "Vehicular Safety",
      0.80,
      "A vehicle is described as visible."
    );
  }

  /*
   * -------------------------------------------------------
   * CONTAINER
   * -------------------------------------------------------
   *
   * A container by itself is not necessarily
   * a safety finding. We therefore don't create
   * a finding here. It is just scene context.
   */

  /*
   * -------------------------------------------------------
   * HOUSEKEEPING
   * -------------------------------------------------------
   */

  if (
    /\bspill\b|\boil spill\b|\bslippery\b|\bclutter\b|\bobstruction\b|\btrip hazard\b/i
      .test(text)
  ) {

    addItem(
      "Potential housekeeping condition",
      "Housekeeping",
      0.75,
      "A potential housekeeping-related condition is described."
    );
  }

  /*
   * -------------------------------------------------------
   * SUMMARY
   * -------------------------------------------------------
   */

  let summary =
    text
      .split("\n")
      .find(
        line =>
          line
            .toLowerCase()
            .includes(
              "the image"
            ) ||
          line
            .toLowerCase()
            .includes(
              "the photo"
            )
      ) ||
      "";

  summary =
    clean(
      summary,
      1000
    );

  /*
   * If no summary was identified,
   * use the first meaningful sentence.
   */

  if (!summary) {

    const firstSentence =
      text.match(
        /^(.{20,500}?)(?:\.|\n)/
      );

    summary =
      clean(
        firstSentence?.[1] ||
          "Safety-relevant objects were identified from the photograph.",
        1000
      );
  }

  return {

    scene_summary:
      summary,

    visible_items:
      items
        .slice(
          0,
          MAX_SCENE_ITEMS
        ),
  };
}
