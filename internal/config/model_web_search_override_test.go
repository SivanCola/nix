package config

import (
	"strings"
	"testing"
)

func webSearchOverrideConfig(kind string, connection *bool) *Config {
	return &Config{Providers: []ProviderEntry{{
		Name: "relay", Kind: kind, BaseURL: "https://relay.test/v1", Model: "searcher",
		Models: []string{"searcher", "plain"}, WebSearch: connection,
		ModelOverrides: map[string]ProviderModelOverride{
			"searcher": {WebSearch: boolPointer(true)},
			"plain":    {WebSearch: boolPointer(false)},
		},
	}}}
}

func TestModelWebSearchOverrideReplacesConnectionForThatModel(t *testing.T) {
	cfg := webSearchOverrideConfig("anthropic", boolPointer(true))
	for model, want := range map[string]bool{"searcher": true, "plain": false} {
		entry, ok := cfg.ResolveModel("relay/" + model)
		if !ok {
			t.Fatalf("ResolveModel(%s) failed", model)
		}
		if got := EffectiveWebSearch(entry); got != want {
			t.Fatalf("EffectiveWebSearch(%s) = %t, want %t", model, got, want)
		}
	}
	if got := cfg.Providers[0].WebSearch; got == nil || !*got {
		t.Fatalf("resolving a model changed the connection value: %v", got)
	}
}

func TestModelWebSearchOverrideEnablesUnverifiedCompatibleEndpoint(t *testing.T) {
	cfg := webSearchOverrideConfig("responses", nil)
	entry, ok := cfg.ResolveModel("relay/searcher")
	if !ok || !EffectiveWebSearch(entry) {
		t.Fatalf("explicit model opt-in was not honored: %+v", entry)
	}
}

func TestModelWebSearchOverrideCannotAddToChatCompletions(t *testing.T) {
	cfg := webSearchOverrideConfig("openai", nil)
	entry, ok := cfg.ResolveModel("relay/searcher")
	if !ok {
		t.Fatal("ResolveModel failed")
	}
	if EffectiveWebSearch(entry) {
		t.Fatal("chat completions has no native search wire format")
	}
}

func TestModelWebSearchOverrideSurvivesRenderAndClone(t *testing.T) {
	enabled := ProviderModelOverride{WebSearch: boolPointer(false)}
	if modelOverrideEmpty(enabled) {
		t.Fatal("an explicit false override must not be dropped as empty")
	}
	if got := renderModelOverride(enabled); !strings.Contains(got, "web_search = false") {
		t.Fatalf("rendered override = %s", got)
	}
	in := map[string]ProviderModelOverride{"m": enabled}
	out := cloneModelOverrideMap(in)
	*out["m"].WebSearch = true
	if *in["m"].WebSearch {
		t.Fatal("clone shares the web_search pointer")
	}
}
