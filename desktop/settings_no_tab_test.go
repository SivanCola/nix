package main

import (
	"context"
	"os"
	"strings"
	"testing"

	"deepzora/internal/config"
)

// A running app can legitimately have no tabs (see session_lifecycle.go), so a
// settings write must persist instead of failing on a missing rebuild target.
func TestSettingsWritePersistsWithoutActiveTab(t *testing.T) {
	isolateDesktopUserDirs(t)

	app := NewApp()
	app.ctx = context.Background()
	if err := app.applyConfigChange(func(c *config.Config) error {
		return c.SetDesktopAppearance("dark", "aurora")
	}); err != nil {
		t.Fatalf("applyConfigChange without a tab: %v", err)
	}
	body, err := os.ReadFile(config.UserConfigPath())
	if err != nil {
		t.Fatalf("read saved config: %v", err)
	}
	if !strings.Contains(string(body), "aurora") {
		t.Fatalf("settings write was not persisted:\n%s", body)
	}
	if err := app.ReloadSettings(); err != nil {
		t.Fatalf("ReloadSettings without a tab: %v", err)
	}
}
