#!/usr/bin/env bash
# Approve the release environment for one sealed candidate's waiting publication.
# The required reviewer stays the gate: a maintainer must type the candidate ID
# at a terminal, and success means GitHub recorded the approval on that run.
set -euo pipefail

if [ "$#" -ne 1 ] || [[ ! "$1" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-[0-9a-f]{12}-[0-9a-f]{12}$ ]]; then
	echo "usage: scripts/release-approve.sh CANDIDATE_ID" >&2
	exit 2
fi

candidate_id="$1"
repository="${RELEASE_REPOSITORY:-SivanCola/deepzora}"
poll_seconds="${RELEASE_APPROVE_POLL_SECONDS:-15}"
poll_attempts=40

for command in gh jq; do
	command -v "$command" >/dev/null || { echo "required command is unavailable: $command" >&2; exit 2; }
done
if [ ! -t 0 ]; then
	echo "release approval needs a maintainer at an interactive terminal" >&2
	exit 2
fi

active_runs() {
	gh api "repos/$repository/actions/workflows/release-promote.yml/runs?branch=main&event=workflow_dispatch&per_page=30" |
		jq -c --arg candidate "$candidate_id" '[.workflow_runs[]
			| select(.display_title == "publish \($candidate)" or .display_title == "recover \($candidate)")
			| select(.status != "completed")]'
}

run=""
for ((attempt = 0; attempt < poll_attempts; attempt++)); do
	runs="$(active_runs)"
	case "$(jq length <<<"$runs")" in
	0)
		echo "no active publication for $candidate_id; run release-stable.sh first or inspect the failed run" >&2
		exit 1
		;;
	1) ;;
	*)
		echo "more than one active publication for $candidate_id; refusing to choose" >&2
		exit 1
		;;
	esac
	if [ "$(jq -r '.[0].status' <<<"$runs")" = waiting ]; then
		run="$(jq -c '.[0]' <<<"$runs")"
		break
	fi
	echo "Waiting for candidate verification: $(jq -r '.[0].html_url' <<<"$runs")"
	sleep "$poll_seconds"
done
if [ -z "$run" ]; then
	echo "candidate verification did not reach approval in time; rerun this script" >&2
	exit 1
fi

run_id="$(jq -r .id <<<"$run")"
pending="$(gh api "repos/$repository/actions/runs/$run_id/pending_deployments")"
if ! jq -e 'length == 1 and .[0].environment.name == "release"' <<<"$pending" >/dev/null; then
	echo "run $run_id is not waiting on exactly the release environment" >&2
	exit 1
fi
if ! jq -e '.[0].current_user_can_approve == true' <<<"$pending" >/dev/null; then
	echo "the authenticated GitHub account cannot approve the release environment" >&2
	exit 1
fi
environment_id="$(jq -r '.[0].environment.id' <<<"$pending")"
approver="$(gh api user | jq -r .login)"

echo "Run:       $(jq -r .html_url <<<"$run")"
echo "Operation: $(jq -r '.display_title | split(" ")[0]' <<<"$run")"
echo "Candidate: $candidate_id"
echo "Control:   $(jq -r .head_sha <<<"$run")"
echo "Approver:  $approver"
printf 'Type the candidate ID to approve publication: '
IFS= read -r typed
if [ "$typed" != "$candidate_id" ]; then
	echo "candidate ID did not match; nothing was approved" >&2
	exit 1
fi

jq -cn --argjson environment_id "$environment_id" --arg comment "release-approve.sh: $candidate_id" \
	'{environment_ids: [$environment_id], state: "approved", comment: $comment}' |
	gh api -X POST "repos/$repository/actions/runs/$run_id/pending_deployments" --input - >/dev/null

if ! gh api "repos/$repository/actions/runs/$run_id/approvals" |
	jq -e --arg approver "$approver" --argjson environment_id "$environment_id" \
		'any(.[]; .state == "approved" and .user.login == $approver and any(.environments[]; .id == $environment_id))' >/dev/null; then
	echo "GitHub did not record the approval on run $run_id" >&2
	exit 1
fi
echo "Approved $candidate_id on run $run_id."
