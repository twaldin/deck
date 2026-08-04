export type CaptainDecision = { approved?: boolean } | undefined;

export function shouldSubmitReview(decision: CaptainDecision): boolean {
  return decision?.approved === true;
}

export function reviewCommand(prNumber: number, repo: string, approve: boolean): string[] {
  return ["pr", "review", String(prNumber), "--repo", repo, approve ? "--approve" : "--request-changes"];
}
