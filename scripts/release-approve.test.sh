#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
root="$(mktemp -d "${TMPDIR:-/tmp}/deepzora-release-approve-test.XXXXXX")"
cleanup() {
	case "$root" in */deepzora-release-approve-test.*) rm -rf -- "$root" ;; *) exit 1 ;; esac
}
trap cleanup EXIT

candidate=v1.2.3-aaaaaaaaaaaa-bbbbbbbbbbbb
export FAKE_GH="$root/state"
mkdir -p "$root/bin"
cat >"$root/bin/gh" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = api
if [ "$2" = -X ]; then
	test "$3" = POST
	test "$4" = "repos/SivanCola/deepzora/actions/runs/7/pending_deployments"
	jq -e '.environment_ids == [42] and .state == "approved"' >/dev/null
	touch "$FAKE_GH/posted"
	exit 0
fi
case "$2" in
user) echo '{"login":"maintainer"}' ;;
*/workflows/release-promote.yml/runs*)
	# Each read consumes one queued response, and the last one repeats.
	first="$(find "$FAKE_GH/runs" -type f | sort | head -n 1)"
	cat "$first"
	[ "$(find "$FAKE_GH/runs" -type f | wc -l)" -eq 1 ] || rm -f "$first"
	;;
*/actions/runs/7/pending_deployments) cat "$FAKE_GH/pending" ;;
*/actions/runs/7/approvals) cat "$FAKE_GH/approvals" ;;
*) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
FAKE
chmod +x "$root/bin/gh"

# Drives the script through a real pseudo-terminal, because it refuses piped input.
cat >"$root/run_in_terminal.py" <<'FAKE'
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
os.write(fd, (sys.argv[1] + "\n").encode())
try:
    while os.read(fd, 4096):
        pass
except OSError:
    pass
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
FAKE

run_json() {
	jq -cn --arg title "$1" --arg status "$2" \
		'{id: 7, display_title: $title, status: $status, html_url: "https://example.test/7", head_sha: "control"}'
}
reset() {
	rm -rf "$FAKE_GH"
	mkdir -p "$FAKE_GH/runs"
	echo "{\"workflow_runs\":[$(run_json "publish $candidate" waiting)]}" >"$FAKE_GH/runs/1"
	echo '[{"environment":{"id":42,"name":"release"},"current_user_can_approve":true}]' >"$FAKE_GH/pending"
	echo '[{"state":"approved","user":{"login":"maintainer"},"environments":[{"id":42}]}]' >"$FAKE_GH/approvals"
}
approve() {
	PATH="$root/bin:$PATH" RELEASE_APPROVE_POLL_SECONDS=0 python3 "$root/run_in_terminal.py" "${1:-$candidate}" "$repo_root/scripts/release-approve.sh" "$candidate" >/dev/null 2>&1
}
refused() {
	if approve "$@"; then
		echo "approval unexpectedly succeeded: $label" >&2
		exit 1
	fi
	if [ -e "$FAKE_GH/posted" ]; then
		echo "approval unexpectedly posted: $label" >&2
		exit 1
	fi
}

reset
approve
test -e "$FAKE_GH/posted"

reset
mv "$FAKE_GH/runs/1" "$FAKE_GH/runs/2"
echo "{\"workflow_runs\":[$(run_json "recover $candidate" in_progress)]}" >"$FAKE_GH/runs/1"
approve
test -e "$FAKE_GH/posted"

label="not at a terminal"
reset
if echo "$candidate" | PATH="$root/bin:$PATH" "$repo_root/scripts/release-approve.sh" "$candidate" >/dev/null 2>&1; then
	echo "approval unexpectedly succeeded: $label" >&2
	exit 1
fi
test ! -e "$FAKE_GH/posted"

label="wrong confirmation"
reset
refused v9.9.9-aaaaaaaaaaaa-bbbbbbbbbbbb

label="no active run"
reset
echo '{"workflow_runs":[]}' >"$FAKE_GH/runs/1"
refused

label="another candidate's run"
reset
echo "{\"workflow_runs\":[$(run_json "publish v9.9.9-aaaaaaaaaaaa-bbbbbbbbbbbb" waiting)]}" >"$FAKE_GH/runs/1"
refused

label="two active runs"
reset
echo "{\"workflow_runs\":[$(run_json "publish $candidate" waiting),$(run_json "recover $candidate" waiting)]}" >"$FAKE_GH/runs/1"
refused

label="other environment"
reset
echo '[{"environment":{"id":42,"name":"staging"},"current_user_can_approve":true}]' >"$FAKE_GH/pending"
refused

label="reviewer without permission"
reset
echo '[{"environment":{"id":42,"name":"release"},"current_user_can_approve":false}]' >"$FAKE_GH/pending"
refused

reset
echo '[]' >"$FAKE_GH/approvals"
if approve; then
	echo "unrecorded approval reported success" >&2
	exit 1
fi

if "$repo_root/scripts/release-approve.sh" 1.2.3 >/dev/null 2>&1; then
	echo "invalid candidate accepted" >&2
	exit 1
fi

echo "release approval tests: PASS"
