#!/usr/bin/env bash
set -euo pipefail

REPO="HSwart/Runlist"
ISSUES=(386 387 388 389 390 391)
POLL_INTERVAL=30
ISSUE_TIMEOUT=2700

wait_for_issue_closed() {
  local issue=$1
  local start
  start=$(date +%s)
  echo "=== Issue #$issue ==="
  gh api "repos/${REPO}/issues/${issue}/comments" -f body='ready' >/dev/null

  while true; do
    local now elapsed state pr_num pr_state
    now=$(date +%s)
    elapsed=$((now - start))
    if [ "$elapsed" -gt "$ISSUE_TIMEOUT" ]; then
      echo "TIMEOUT issue #$issue after ${ISSUE_TIMEOUT}s"
      gh issue view "$issue" --repo "$REPO" --json state,title
      gh pr list --repo "$REPO" --state open --json number,headRefName,title
      return 1
    fi

    state=$(gh issue view "$issue" --repo "$REPO" --json state -q .state)
    if [ "$state" = "CLOSED" ]; then
      echo "Issue #$issue closed (${elapsed}s)"
      return 0
    fi

    pr_num=$(gh pr list --repo "$REPO" --state open --search "head:automation/${issue}-" --json number -q '.[0].number // empty')
    if [ -n "$pr_num" ]; then
      pr_state=$(gh pr view "$pr_num" --repo "$REPO" --json isDraft,reviewDecision,statusCheckRollup -q '[.isDraft, .reviewDecision, ([.statusCheckRollup[]? | select(.conclusion != "SUCCESS" and .conclusion != "NEUTRAL" and .conclusion != "SKIPPED" and .conclusion != "")] | length)] | @tsv"')
      echo "$(date -u +%H:%M:%S) #$issue PR #$pr_num ($pr_state)"
    else
      merged_pr=$(gh pr list --repo "$REPO" --state merged --search "head:automation/${issue}-" --json number,mergedAt -q '.[0].number // empty')
      if [ -n "$merged_pr" ]; then
        echo "PR #$merged_pr merged but issue open; closing issue #$issue"
        gh api -X PATCH "repos/${REPO}/issues/${issue}" -f state=closed -f state_reason=completed >/dev/null
        continue
      fi
      echo "$(date -u +%H:%M:%S) #$issue waiting for automation PR..."
    fi
    sleep "$POLL_INTERVAL"
  done
}

for issue in "${ISSUES[@]}"; do
  wait_for_issue_closed "$issue"
done

echo "ALL ISSUES PROCESSED"
gh issue list --repo "$REPO" --state open --json number,title
