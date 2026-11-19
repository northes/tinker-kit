package main

import "testing"

func TestNormalizeDockerCommand(t *testing.T) {
	if got, err := normalizeDockerCommand(""); err != nil || got != "" {
		t.Fatalf("empty = %q, %v", got, err)
	}
	if got, err := normalizeDockerCommand("/usr/bin/sudo -n /usr/bin/docker"); err != nil || got != "/usr/bin/sudo -n /usr/bin/docker" {
		t.Fatalf("prefix = %q, %v", got, err)
	}
	if _, err := normalizeDockerCommand("-docker"); err == nil {
		t.Fatal("expected reject for leading dash")
	}
	if _, err := normalizeDockerCommand("foo;bar"); err == nil {
		t.Fatal("expected reject for shell meta")
	}
	if _, err := normalizeDockerCommand(`echo "x"`); err == nil {
		t.Fatal("expected reject for quotes")
	}
}

func TestNormalizeImageSourceDockerCommand(t *testing.T) {
	seen := map[string]bool{}
	normalized, err := normalizeImageSource(ImageSource{ID: "ssh:1", Kind: "ssh", SSHProfileID: "p", DockerCommand: "  /usr/bin/sudo -n /usr/bin/docker  "}, seen, nil, map[string]string{"p": "prod"})
	if err != nil || normalized.DockerCommand != "/usr/bin/sudo -n /usr/bin/docker" {
		t.Fatalf("ssh docker command = %q, %v", normalized.DockerCommand, err)
	}
	if _, err := normalizeImageSource(ImageSource{ID: "ssh:2", Kind: "ssh", SSHProfileID: "p", DockerCommand: "docker;rm"}, map[string]bool{}, nil, nil); err == nil {
		t.Fatal("expected invalid docker command to fail save")
	}
	registry, err := normalizeImageSource(ImageSource{ID: "registry:1", Kind: "registry", RegistryURL: "https://registry.example", DockerCommand: "docker"}, map[string]bool{}, nil, nil)
	if err != nil || registry.DockerCommand != "" {
		t.Fatalf("registry docker command should be cleared, got %q, %v", registry.DockerCommand, err)
	}
}

func TestImageSourceDisplayCLI(t *testing.T) {
	cfg := Config{DockerCLIPath: "/bin/docker"}
	if got := imageSourceDisplayCLI(ImageSource{Kind: "local"}, cfg); got != "/bin/docker" {
		t.Fatalf("local cli = %q", got)
	}
	if got := imageSourceDisplayCLI(ImageSource{Kind: "ssh", DockerCommand: "/usr/bin/sudo -n docker"}, cfg); got != "/usr/bin/sudo -n docker" {
		t.Fatalf("ssh prefix = %q", got)
	}
}
