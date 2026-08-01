/**
 * Landing verification (SOP stage 8): search main for the squash commit
 * "(#N)" - NEVER the merged flag. GitHub merge queue closes PRs before landing is confirmed: queue-merged PRs
 * read state=closed, merged=false (3 confirmed repros).
 */

export interface CommitSubject {
	sha: string;
	subject: string;
}

/**
 * Find the squash commit for PR #prNumber among main's commit subjects.
 * Matches the "(#N)" suffix convention exactly (word-boundary safe: "(#123)"
 * must not match a search for "(#12)").
 */
export function findLandingCommit(commits: CommitSubject[], prNumber: number): CommitSubject | null {
	const marker = `(#${prNumber})`;
	for (const commit of commits) {
		if (commit.subject.includes(marker)) {
			// Guard against "(#1234)" matching marker "(#123" + ")" is exact:
			// includes() on the full "(#N)" string is already boundary-safe
			// because of the closing paren.
			return commit;
		}
	}
	return null;
}
