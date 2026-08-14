function parseLegacyAIResponse(
  raw: string
): Array<{
  category: string;
  title: string;
  observation: string;
  status: Status;
  risk: Risk;
  confidence: number;
  checkId: string;
}> {
  const results: Array<{
    category: string;
    title: string;
    observation: string;
    status: Status;
    risk: Risk;
    confidence: number;
    checkId: string;
  }> = [];

  const blocks =
    raw.split(
      /(?=\*\*Category:\*\*)/i
    );

  for (
    const block of blocks
  ) {
    if (
      !block
        .trim()
    ) {
      continue;
    }

    const categoryMatch =
      block.match(
        /\*\*Category:\*\*\s*(.+?)(?=\n|$)/i
      );

    if (
      !categoryMatch
    ) {
      continue;
    }

    const titleMatch =
      block.match(
        /\*\*Title:\*\*\s*(.+?)(?=\n|$)/i
      );

    const observationMatch =
      block.match(
        /\*\*Observation:\*\*\s*(.+?)(?=\n|$)/i
      );

    const statusMatch =
      block.match(
        /\*\*Status:\*\*\s*(PASS|FAIL|CHECK_REQUIRED)/i
      );

    const riskMatch =
      block.match(
        /\*\*Risk:\*\*\s*(LOW|MEDIUM|HIGH)/i
      );

    const confidenceMatch =
      block.match(
        /\*\*Confidence:\*\*\s*([0-9.]+)/i
      );

    const checkIdMatch =
      block.match(
        /\*\*Check ID:\*\*\s*([^\s\n]+)/i
      );

    const category =
      normalizeCategory(
        categoryMatch[1]
      );

    const title =
      cleanMarkdown(
        titleMatch?.[1] ||
          `${category} observation`
      );

    const observation =
      cleanMarkdown(
        observationMatch?.[1] ||
          ""
      );

    if (
      !observation
    ) {
      continue;
    }

    if (
      isNegativeVisibilityFinding(
        category,
        title,
        observation
      )
    ) {
      continue;
    }

    const status =
      normalizeStatus(
        statusMatch?.[1] ||
          "",
        observation
      );

    results.push({
      category,

      title,

      observation,

      status,

      risk:
        normalizeRisk(
          riskMatch?.[1] ||
            "",
          status
        ),

      confidence:
        parseConfidence(
          confidenceMatch?.[1] ||
            ""
        ),

      checkId:
        cleanMarkdown(
          checkIdMatch?.[1] ||
            ""
        ),
    });
  }

  return results;
}
