import { deduplicateSessionsByProvider, getAllProviders } from "../src/providers/index.js";
import { queryLocalSessions, type SessionQueryMatch } from "../src/session-query.js";
import type { SessionInfo } from "../src/types.js";

type QueryMode = "strict" | "any" | "brief";

interface EvalCase {
  query: string;
  intent: string;
  relevanceNote: string;
  isRelevant: (text: string) => boolean;
}

interface ModeSummary {
  mode: QueryMode;
  count: number;
  judgedRelevant: number;
  top1Relevant: boolean;
  top3Relevant: number;
  qualityCounts: Record<string, number>;
  topResults: Array<{
    slug: string;
    project: string;
    quality?: string;
    matchedTerms: string[];
    unmatchedTerms: string[];
    judgedRelevant: boolean;
    title: string;
  }>;
}

const EVAL_CASES: EvalCase[] = [
  {
    query: "PR review CI merge",
    intent: "Find PR/review workflows, ideally with CI or merge context.",
    relevanceNote: "PR/pull request plus review, or a GitHub PR URL.",
    isRelevant: (text) =>
      /pull\/\d+|pull request|\bpr\b/.test(text) && /review|reviewer|ci|merge/.test(text),
  },
  {
    query: "latest main branch feature",
    intent: "Recover sessions about switching/pulling latest main for feature work.",
    relevanceNote: "latest/main/branch/feature context, not arbitrary 'main' mentions.",
    isRelevant: (text) => /latest/.test(text) && /(main|branch|feature)/.test(text),
  },
  {
    query: "skill devspaces canonical",
    intent: "Find skill work that involved Devspaces or canonical skill migration.",
    relevanceNote: "skill plus devspaces/dev space/canonical/ROS CLI skill.",
    isRelevant: (text) =>
      /skill/.test(text) && /(devspaces|dev space|canonical|ros-?cli)/.test(text),
  },
  {
    query: "progressive loading metrics ready",
    intent: "Find Vibe Replay progressive session-data loading / metrics-ready UI work.",
    relevanceNote:
      "progressive/enrichment/session data/readiness/metrics-ready UI, not generic loading or ready.",
    isRelevant: (text) =>
      /(vibe-replay|dashboard|session data|data readiness|metrics ready|enrichment|progressive)/.test(
        text,
      ) && /(loading|metrics|ready|toast)/.test(text),
  },
  {
    query: "toast style",
    intent: "Find UI polish around toast styling.",
    relevanceNote: "toast styling/design/placement.",
    isRelevant: (text) => /toast/.test(text) && /(style|design|placement|loading)/.test(text),
  },
  {
    query: "codex parser compaction",
    intent: "Find Codex parser/replay parity work involving compaction.",
    relevanceNote: "Codex plus parser/compaction/patch/replay parity.",
    isRelevant: (text) =>
      /codex/.test(text) && /(parser|compaction|patch|replay parity)/.test(text),
  },
  {
    query: "local session search retro",
    intent: "Find the local session search / retrospective feature work.",
    relevanceNote: "local session/session search/vibe-replay sessions/session-query/retro.",
    isRelevant: (text) =>
      /(local session|session search|vibe-replay sessions|session-query|retro)/.test(text),
  },
  {
    query: "auth login callback",
    intent: "Find auth/login callback debugging sessions.",
    relevanceNote: "auth/login/oauth/callback.",
    isRelevant: (text) => /(auth|oauth)/.test(text) && /(login|callback|status)/.test(text),
  },
  {
    query: "model pricing cursor",
    intent: "Find model pricing / Cursor model metadata sessions.",
    relevanceNote: "model/pricing/cursor together enough to indicate the topic.",
    isRelevant: (text) => /model/.test(text) && /(pricing|cursor)/.test(text),
  },
  {
    query: "sourcegraph skill search",
    intent: "Find Sourcegraph or skill-search research.",
    relevanceNote: "sourcegraph, or skill plus search.",
    isRelevant: (text) => /sourcegraph/.test(text) || (/skill/.test(text) && /search/.test(text)),
  },
  {
    query: "tuo-lei github identity",
    intent: "Find local GitHub identity / account preference sessions.",
    relevanceNote: "tuo-lei plus GitHub/account/identity.",
    isRelevant: (text) => /tuo-lei/.test(text) && /(github|account|identity)/.test(text),
  },
  {
    query: "browser screenshot review",
    intent: "Find browser/screenshot review tasks.",
    relevanceNote: "browser or screenshot plus review/screenshot.",
    isRelevant: (text) => /(browser|screenshot)/.test(text) && /(review|screenshot)/.test(text),
  },
  {
    query: "D1 drizzle migration auth",
    intent: "Find D1/Drizzle migration/auth database work.",
    relevanceNote: "D1/drizzle/migration plus auth/db context.",
    isRelevant: (text) =>
      /(d1|drizzle|migration)/.test(text) && /(auth|db|database|schema)/.test(text),
  },
  {
    query: "Cursor SDK agent transcript",
    intent: "Find Cursor SDK agent transcript work.",
    relevanceNote: "Cursor SDK/SDK plus agent/transcript.",
    isRelevant: (text) => /(cursor sdk|sdk)/.test(text) && /(agent|transcript)/.test(text),
  },
  {
    query: "ROS CLI QPS bursty usage",
    intent: "Find ROS CLI capacity / bursty QPS investigation.",
    relevanceNote: "ROS CLI plus QPS/bursty/usage/server capacity.",
    isRelevant: (text) => /ros cli/.test(text) && /(qps|bursty|usage|server|capacity)/.test(text),
  },
  {
    query: "gdrive confluence slack skills",
    intent: "Find skill catalog work around GDrive/Confluence/Slack skills.",
    relevanceNote: "Any of gdrive/confluence/slack plus skill.",
    isRelevant: (text) => /(gdrive|google drive|confluence|slack)/.test(text) && /skill/.test(text),
  },
  {
    query: "mobile landing main PR",
    intent: "Find Mobile Landing in Main PR review context.",
    relevanceNote: "mobile landing or mobile+main+PR/review.",
    isRelevant: (text) =>
      /mobile/.test(text) && /(landing|main)/.test(text) && /(\bpr\b|review|pull\/\d+)/.test(text),
  },
  {
    query: "e2e generated html",
    intent: "Find generated HTML / E2E test work.",
    relevanceNote: "e2e or generated HTML/HTML output.",
    isRelevant: (text) => /e2e/.test(text) || /generated html/.test(text),
  },
  {
    query: "cache enrichment priority",
    intent: "Find session-source cache/enrichment priority work.",
    relevanceNote: "cache plus enrichment/priority/sources.",
    isRelevant: (text) => /cache/.test(text) && /(enrichment|priority|sources|session)/.test(text),
  },
  {
    query: "nonexistent zebra pineapple",
    intent: "Negative control.",
    relevanceNote: "Should return nothing.",
    isRelevant: () => false,
  },
];

async function main(): Promise<void> {
  const sessions = mergeSameSessions(
    deduplicateSessionsByProvider(
      (
        await Promise.all(
          getAllProviders().map(async (provider) => {
            try {
              return await provider.discover();
            } catch {
              return [];
            }
          }),
        )
      ).flat(),
    ),
  );

  const rows = [];
  for (const evalCase of EVAL_CASES) {
    const strict = summarizeMode(
      "strict",
      evalCase,
      await queryLocalSessions(sessions, { query: evalCase.query, limit: 5 }),
    );
    const any = summarizeMode(
      "any",
      evalCase,
      await queryLocalSessions(sessions, { query: evalCase.query, any: true, limit: 5 }),
    );
    const brief = summarizeMode(
      "brief",
      evalCase,
      await queryLocalSessions(sessions, {
        query: evalCase.query,
        any: true,
        brief: true,
        dedupe: true,
        limit: 5,
      }),
    );
    rows.push({ evalCase, strict, any, brief });
  }

  printReport(sessions.length, rows);
}

function summarizeMode(
  mode: QueryMode,
  evalCase: EvalCase,
  matches: SessionQueryMatch[],
): ModeSummary {
  const topResults = matches.map((match) => {
    const text = normalizedResultText(match);
    return {
      slug: match.slug,
      project: match.project,
      quality: match.matchQuality,
      matchedTerms: match.matchedTerms || [],
      unmatchedTerms: match.unmatchedTerms || [],
      judgedRelevant: evalCase.isRelevant(text),
      title: previewTitle(match),
    };
  });

  return {
    mode,
    count: matches.length,
    judgedRelevant: topResults.filter((result) => result.judgedRelevant).length,
    top1Relevant: Boolean(topResults[0]?.judgedRelevant),
    top3Relevant: topResults.slice(0, 3).filter((result) => result.judgedRelevant).length,
    qualityCounts: topResults.reduce<Record<string, number>>((counts, result) => {
      const quality = result.quality || "none";
      counts[quality] = (counts[quality] || 0) + 1;
      return counts;
    }, {}),
    topResults,
  };
}

function printReport(
  sessionCount: number,
  rows: Array<{
    evalCase: EvalCase;
    strict: ModeSummary;
    any: ModeSummary;
    brief: ModeSummary;
  }>,
): void {
  console.log(`# Session Query Eval\n`);
  console.log(`Sessions discovered: ${sessionCount}`);
  console.log(`Eval cases: ${rows.length}`);
  console.log(`Top K per mode: 5\n`);

  console.log(`## Aggregate\n`);
  console.log(
    `| Mode | Queries With Results | Top1 Relevant | Judged Relevant / Returned | Precision@5 | Negative Returned |`,
  );
  console.log(`| --- | ---: | ---: | ---: | ---: | ---: |`);
  for (const mode of ["strict", "any", "brief"] as const) {
    const summary = aggregate(rows, mode);
    console.log(
      `| ${mode} | ${summary.queriesWithResults}/${summary.nonNegativeQueries} | ${summary.top1Relevant}/${summary.nonNegativeQueries} | ${summary.judgedRelevant}/${summary.returned} | ${formatPct(summary.precision)} | ${summary.negativeReturned} |`,
    );
  }

  console.log(`\n## Case Results\n`);
  for (const row of rows) {
    console.log(`### ${row.evalCase.query}`);
    console.log(`Intent: ${row.evalCase.intent}`);
    console.log(`Judge: ${row.evalCase.relevanceNote}\n`);
    for (const mode of ["strict", "any", "brief"] as const) {
      const result = row[mode];
      console.log(
        `- ${mode}: count=${result.count}, judgedRelevant=${result.judgedRelevant}/${result.count}, top3Relevant=${result.top3Relevant}/3, quality=${JSON.stringify(result.qualityCounts)}`,
      );
      for (const [index, top] of result.topResults.slice(0, 3).entries()) {
        const quality = top.quality ? ` ${top.quality}` : "";
        const matched = top.matchedTerms.length ? ` matched=${top.matchedTerms.join(",")}` : "";
        const unmatched = top.unmatchedTerms.length
          ? ` unmatched=${top.unmatchedTerms.join(",")}`
          : "";
        console.log(
          `  ${index + 1}. ${top.judgedRelevant ? "Y" : "N"} ${top.slug}${quality}${matched}${unmatched} - ${top.title}`,
        );
      }
    }
    console.log();
  }

  const weakOnly = rows
    .filter((row) => row.brief.count > 0)
    .filter((row) => (row.brief.qualityCounts.weak || 0) === row.brief.count);
  console.log(`## Brief Weak-Only Cases\n`);
  for (const row of weakOnly) {
    const top = row.brief.topResults[0];
    console.log(
      `- ${row.evalCase.query}: top=${top?.slug || "none"} matched=${top?.matchedTerms.join(",") || ""} unmatched=${top?.unmatchedTerms.join(",") || ""}`,
    );
  }
}

function aggregate(
  rows: Array<{
    evalCase: EvalCase;
    strict: ModeSummary;
    any: ModeSummary;
    brief: ModeSummary;
  }>,
  mode: "strict" | "any" | "brief",
): {
  nonNegativeQueries: number;
  queriesWithResults: number;
  top1Relevant: number;
  judgedRelevant: number;
  returned: number;
  precision: number | undefined;
  negativeReturned: number;
} {
  const nonNegative = rows.filter((row) => row.evalCase.intent !== "Negative control.");
  const judgedRelevant = nonNegative.reduce((sum, row) => sum + row[mode].judgedRelevant, 0);
  const returned = nonNegative.reduce((sum, row) => sum + row[mode].count, 0);
  return {
    nonNegativeQueries: nonNegative.length,
    queriesWithResults: nonNegative.filter((row) => row[mode].count > 0).length,
    top1Relevant: nonNegative.filter((row) => row[mode].top1Relevant).length,
    judgedRelevant,
    returned,
    precision: returned > 0 ? judgedRelevant / returned : undefined,
    negativeReturned:
      rows.find((row) => row.evalCase.intent === "Negative control.")?.[mode].count || 0,
  };
}

function mergeSameSessions(sessions: SessionInfo[]): SessionInfo[] {
  const groups = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const key = `${session.project}::${session.slug}`;
    groups.set(key, [...(groups.get(key) || []), session]);
  }

  return [...groups.values()].map((group) => {
    group.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return group[0];
  });
}

function normalizedResultText(match: SessionQueryMatch): string {
  return [match.title, match.firstPrompt, match.project, match.gitBranch]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function previewTitle(match: SessionQueryMatch): string {
  return (match.title || match.firstPrompt || match.slug).replace(/\s+/g, " ").slice(0, 100);
}

function formatPct(value: number | undefined): string {
  return value === undefined ? "-" : `${Math.round(value * 1000) / 10}%`;
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
