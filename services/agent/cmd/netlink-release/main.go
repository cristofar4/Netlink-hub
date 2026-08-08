// Command netlink-release signs and inspects update manifests.
//
// This is release tooling, not something that ships to users. It is here rather
// than in a separate repository because the signing input has to stay
// byte-identical to what agents verify, and the surest way to keep two
// implementations identical is not to have two.
//
// The key it uses decides what runs on every NetLink installation. Keep it
// offline, on removable media or in a hardware token, and never in the
// repository or on a build server that anything else can reach.
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/netlink/agent/pkg/release"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "sign":
		err = sign(os.Args[2:])
	case "verify":
		err = verify(os.Args[2:])
	case "keygen":
		err = keygen(os.Args[2:])
	case "-h", "--help", "help":
		usage()
		return
	default:
		usage()
		os.Exit(2)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "netlink-release: %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `netlink-release — sign and check NetLink update manifests

  keygen --out <file>
      Generate a release signing key. Writes the private seed to <file> and
      prints the public key and its id, which go into the agent's trust list.

  sign --manifest <file> --key <file> --out <file>
      Sign a manifest. The signature covers the version, the channel, the
      validity window and every artifact's URL, size and SHA-256 — so neither
      the file nor the version it claims to be can be changed afterwards.

  verify --manifest <file> --key <public key, base64url> [--current <version>]
      Check a signed manifest exactly as an agent would.
`)
}

func keygen(args []string) error {
	flags := flag.NewFlagSet("keygen", flag.ExitOnError)
	out := flags.String("out", "", "where to write the private seed")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *out == "" {
		return errors.New("--out is required")
	}
	if _, err := os.Stat(*out); err == nil {
		// Overwriting a release key silently would orphan every installation
		// that trusts the old one.
		return fmt.Errorf("%s already exists — refusing to overwrite a release key", *out)
	}

	public, private, err := ed25519.GenerateKey(nil)
	if err != nil {
		return err
	}

	seed := base64.RawURLEncoding.EncodeToString(private.Seed())
	if err := os.WriteFile(*out, []byte(seed+"\n"), 0o600); err != nil {
		return err
	}

	publicB64 := base64.RawURLEncoding.EncodeToString(public)
	fmt.Printf("Private seed written to %s (mode 0600)\n", *out)
	fmt.Printf("Public key: %s\n", publicB64)
	fmt.Printf("Key id:     rel-%s\n", publicB64[:12])
	fmt.Println()
	fmt.Println("Put the public key and id in the agent's trusted release keys.")
	fmt.Println("Keep the private seed offline. Anything that can read it can")
	fmt.Println("decide what runs on every NetLink installation.")
	return nil
}

func sign(args []string) error {
	flags := flag.NewFlagSet("sign", flag.ExitOnError)
	manifestPath := flags.String("manifest", "", "manifest to sign")
	keyPath := flags.String("key", "", "private seed, base64url")
	out := flags.String("out", "", "where to write the signed envelope")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *manifestPath == "" || *keyPath == "" || *out == "" {
		return errors.New("--manifest, --key and --out are all required")
	}

	raw, err := os.ReadFile(*manifestPath)
	if err != nil {
		return err
	}
	var manifest release.Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return fmt.Errorf("reading the manifest: %w", err)
	}

	key, err := loadKey(*keyPath)
	if err != nil {
		return err
	}

	// Checked before signing, because a signature over a manifest nobody can
	// use is worse than a refusal: it looks like a successful release.
	if err := check(manifest); err != nil {
		return err
	}

	envelope, err := release.Sign(manifest, key, keyID(key))
	if err != nil {
		return err
	}

	encoded, err := json.MarshalIndent(envelope, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, append(encoded, '\n'), 0o644); err != nil {
		return err
	}

	fmt.Printf("Signed %s %s (%s) with %s\n", manifest.Version, manifest.Channel, *manifestPath, envelope.KeyID)
	fmt.Printf("Valid until %s\n", manifest.ExpiresAt.UTC().Format(time.RFC3339))
	for _, artifact := range manifest.Artifacts {
		fmt.Printf("  %-8s %-14s %s\n", artifact.Component, artifact.Platform, artifact.SHA256[:16]+"…")
	}
	return nil
}

func verify(args []string) error {
	flags := flag.NewFlagSet("verify", flag.ExitOnError)
	manifestPath := flags.String("manifest", "", "signed envelope to check")
	publicKey := flags.String("key", "", "public key, base64url")
	current := flags.String("current", "0.0.0", "the version an agent would be running")
	channel := flags.String("channel", "stable", "channel the agent is on")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *manifestPath == "" || *publicKey == "" {
		return errors.New("--manifest and --key are both required")
	}

	raw, err := os.ReadFile(*manifestPath)
	if err != nil {
		return err
	}
	envelope, err := release.UnmarshalEnvelope(raw)
	if err != nil {
		return err
	}

	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(*publicKey))
	if err != nil || len(decoded) != ed25519.PublicKeySize {
		return errors.New("--key is not a base64url Ed25519 public key")
	}

	verifier := release.NewVerifier(
		*current,
		release.Channel(*channel),
		map[string]ed25519.PublicKey{envelope.KeyID: ed25519.PublicKey(decoded)},
	)

	manifest, err := verifier.Verify(envelope)
	if err != nil {
		return fmt.Errorf("this manifest would be REFUSED: %w", err)
	}

	fmt.Printf("Accepted: %s → %s (%s)\n", *current, manifest.Version, manifest.Channel)
	return nil
}

// check catches the mistakes that produce a signed but unusable release.
func check(m release.Manifest) error {
	if m.Version == "" {
		return errors.New("the manifest has no version")
	}
	if !m.Channel.Valid() {
		return fmt.Errorf("channel %q is not stable or beta", m.Channel)
	}
	if len(m.Artifacts) == 0 {
		return errors.New("the manifest has no artifacts")
	}
	if m.ExpiresAt.IsZero() || !m.ExpiresAt.After(time.Now()) {
		return errors.New("the manifest expires in the past — no agent would accept it")
	}
	for _, artifact := range m.Artifacts {
		if !strings.HasPrefix(artifact.URL, "https://") {
			return fmt.Errorf("artifact %s is not served over https", artifact.Component)
		}
		if len(artifact.SHA256) != 64 {
			return fmt.Errorf("artifact %s has no SHA-256", artifact.Component)
		}
		if artifact.Bytes <= 0 {
			return fmt.Errorf("artifact %s has no size", artifact.Component)
		}
	}
	return nil
}

func loadKey(path string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	seed, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("the key file does not contain a base64url Ed25519 seed")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// keyID derives the id from the key, so a rotated key automatically gets a new
// one and an agent can never verify a new manifest against an old key.
func keyID(key ed25519.PrivateKey) string {
	public := base64.RawURLEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
	return "rel-" + public[:12]
}
