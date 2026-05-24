package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRuntimeConfigPathFixedToWorkingDirectory(t *testing.T) {
	dir := t.TempDir()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(previous); err != nil {
			t.Fatalf("restore working directory: %v", err)
		}
	})

	for _, path := range []string{"", "config.toml", "./config.toml", filepath.Join(dir, "config.toml")} {
		got, err := runtimeConfigPath(path)
		if err != nil {
			t.Fatalf("expected %q to be accepted: %v", path, err)
		}
		if got != "config.toml" {
			t.Fatalf("expected canonical config.toml for %q, got %q", path, got)
		}
	}
	for _, path := range []string{"config.local.toml", filepath.Join(t.TempDir(), "config.toml"), filepath.Join("..", "config.toml")} {
		if _, err := runtimeConfigPath(path); err == nil {
			t.Fatalf("expected %q to be rejected", path)
		}
	}
}
