export type CaptainDecision = { approved?: boolean } | undefined;

export function shouldSubmitReview(decision: CaptainDecision): boolean {
  return decision?.approved === true;
}

export function reviewCommand(prNumber: number, repo: string, headSha: string, clean: boolean): string[] {
  if (headSha.trim() === "") throw new Error("review submission needs the reviewed head");
  return [
    "api",
    "--method",
    "POST",
    `repos/${repo}/pulls/${prNumber}/reviews`,
    "-f",
    `event=${clean ? "COMMENT" : "REQUEST_CHANGES"}`,
    "-f",
    `commit_id=${headSha}`,
  ];
}
