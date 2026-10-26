export const SECTION_IDS = ['reviewing', 'mentioned', 'awaitingApproval', 'threads', 'authored'];

function countActionable({ reviewing, mentioned, awaitingApproval, threads, authored }) {
  const waiting = new Set([
    ...mentioned.map((item) => item.key),
    ...reviewing.filter((item) => !item.approvedByMe && !item.draft).map((item) => item.key),
    ...awaitingApproval.map((item) => item.key),
    ...threads.map((item) => item.key),
  ]);
  const failed = authored.filter((item) => item.pipeline?.status === 'failed' && !item.pipeline.onlyIgnoredFailures);
  return { waiting: waiting.size, failedCi: failed.length };
}

export function deriveView(dashboard) {
  const sections = Object.fromEntries(SECTION_IDS.map((id) => [id, dashboard.sections?.[id] ?? []]));
  return { sections, counts: countActionable(sections) };
}
