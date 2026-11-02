//go:build !windows

package sandbox

import (
	"os"
	"path/filepath"
	"testing"
)

// A cold first launch can take seconds; a slow healthy interpreter must not be
// reported as missing until a later re-detect happens to find it warm.
func TestProbeExecutableAcceptsSlowColdStart(t *testing.T) {
	t.Parallel()
	script := filepath.Join(t.TempDir(), "slow-bash")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 3.2\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !probeExecutable(script) {
		t.Fatalf("slow but healthy executable was rejected within %s", executableProbeTimeout)
	}
}

func TestProbeExecutableRejectsFailingExecutable(t *testing.T) {
	t.Parallel()
	script := filepath.Join(t.TempDir(), "broken-bash")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if probeExecutable(script) {
		t.Fatal("failing executable was accepted")
	}
}
