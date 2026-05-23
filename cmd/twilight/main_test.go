package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/prejudice-studio/twilight/internal/config"
	"github.com/prejudice-studio/twilight/internal/store"
)

func TestOpenLegacyJSONStoreIfPopulated(t *testing.T) {
	dir := t.TempDir()
	missing, err := openLegacyJSONStoreIfPopulated(config.Config{StateFile: filepath.Join(dir, "missing.json")})
	if err != nil {
		t.Fatal(err)
	}
	if missing != nil {
		t.Fatal("missing state file should not open a fallback store")
	}

	stateFile := filepath.Join(dir, "state.json")
	st, err := store.Open(stateFile)
	if err != nil {
		t.Fatal(err)
	}
	_, err = st.CreateUser(store.User{Username: "admin", Role: store.RoleAdmin, PasswordHash: "hash"})
	if err != nil {
		t.Fatal(err)
	}
	_ = st.Close()

	legacy, err := openLegacyJSONStoreIfPopulated(config.Config{StateFile: stateFile})
	if err != nil {
		t.Fatal(err)
	}
	if legacy == nil {
		t.Fatal("populated JSON state should be used as fallback")
	}
	defer legacy.Close()
	if legacy.Backend() != store.BackendJSON || legacy.UserCount() != 1 {
		t.Fatalf("unexpected fallback store: backend=%s users=%d", legacy.Backend(), legacy.UserCount())
	}
}

func TestParseLegacyAdminCSV(t *testing.T) {
	data := []byte(`UID,TELEGRAM_ID,USERNAME,EMAIL,ROLE,ACTIVE_STATUS,CREATE_AT,REGISTER_TIME,EXPIRED_AT,EMBYID,PASSWORD
1,42,MoYuanCN,admin@example.com,0,1,1700000000,1700000001,-1,emby-admin,salt$100000$abcdef
2,43,user,user@example.com,1,1,1700000000,1700000001,-1,emby-user,salt$100000$abcdef
`)
	admins, err := parseLegacyAdminCSV(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(admins) != 1 {
		t.Fatalf("expected one admin, got %d", len(admins))
	}
	admin := admins[0]
	if admin.Username != "MoYuanCN" || admin.Role != store.RoleAdmin || !admin.Active || admin.TelegramID != 42 || admin.PasswordHash == "" {
		t.Fatalf("unexpected admin import: %#v", admin)
	}
}

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
