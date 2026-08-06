export type CaptainDecision = { approved?: boolean } | undefined;

export function shouldSubmitReview(decision: CaptainDecision): boolean {
  return decision?.approved === true;
}

export function reviewCommand(prNumber: number, repo: string, clean: boolean): string[] {
  return clean
    ? ["pr", "comment", String(prNumber), "--repo", repo]
    : ["pr", "review", String(prNumber), "--repo", repo, "--request-changes"];
}
