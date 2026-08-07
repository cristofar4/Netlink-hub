package client

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/netlink/agent/pkg/identity"
)

func newIdentity(t *testing.T) *identity.Identity {
	t.Helper()
	ident, err := identity.NewStore(t.TempDir()).Create("Test PC")
	if err != nil {
		t.Fatalf("creating identity: %v", err)
	}
	return ident
}

func TestSigningInputBindsRequestToItsContents(t *testing.T) {
	base := SigningInput("POST", "/agent/heartbeat", "2026-08-07T12:00:00Z", "n1", []byte(`{"a":1}`))

	cases := map[string][]byte{
		"method":    SigningInput("GET", "/agent/heartbeat", "2026-08-07T12:00:00Z", "n1", []byte(`{"a":1}`)),
		"path":      SigningInput("POST", "/agent/enroll", "2026-08-07T12:00:00Z", "n1", []byte(`{"a":1}`)),
		"timestamp": SigningInput("POST", "/agent/heartbeat", "2026-08-07T12:00:01Z", "n1", []byte(`{"a":1}`)),
		"nonce":     SigningInput("POST", "/agent/heartbeat", "2026-08-07T12:00:00Z", "n2", []byte(`{"a":1}`)),
		"body":      SigningInput("POST", "/agent/heartbeat", "2026-08-07T12:00:00Z", "n1", []byte(`{"a":2}`)),
	}

	for field, variant := range cases {
		if string(variant) == string(base) {
			t.Errorf("changing the %s did not change the signing input", field)
		}
	}
}

func TestSigningInputIsCaseInsensitiveOnMethod(t *testing.T) {
	a := SigningInput("post", "/x", "t", "n", nil)
	b := SigningInput("POST", "/x", "t", "n", nil)
	if string(a) != string(b) {
		t.Error("method case changed the signing input")
	}
}

func TestHeartbeatIsSignedAndVerifiable(t *testing.T) {
	ident := newIdentity(t)

	var (
		gotSignature string
		gotInstall   string
		gotPublicKey string
		gotTimestamp string
		gotNonce     string
		gotBody      []byte
		gotPath      string
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotSignature = r.Header.Get("X-NetLink-Signature")
		gotInstall = r.Header.Get("X-NetLink-Installation")
		gotPublicKey = r.Header.Get("X-NetLink-Public-Key")
		gotTimestamp = r.Header.Get("X-NetLink-Timestamp")
		gotNonce = r.Header.Get("X-NetLink-Nonce")
		gotBody, _ = io.ReadAll(r.Body)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(HeartbeatResponse{Acknowledged: true})
	}))
	defer server.Close()

	c := New(Options{BaseURL: server.URL + "/api", Identity: ident, AppVersion: "0.1.0"})

	resp, err := c.Heartbeat(context.Background(), HeartbeatRequest{
		DeviceID: "device-1",
		Status:   "online",
		SentAt:   time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if !resp.Acknowledged {
		t.Error("response was not decoded")
	}

	if gotPath != "/api/agent/heartbeat" {
		t.Errorf("path = %q", gotPath)
	}
	if gotInstall != ident.InstallationID {
		t.Errorf("installation header = %q, want %q", gotInstall, ident.InstallationID)
	}
	if gotPublicKey != ident.PublicKey {
		t.Errorf("public key header = %q", gotPublicKey)
	}

	// The server can verify the signature using only the public key.
	sig, err := base64.RawURLEncoding.DecodeString(gotSignature)
	if err != nil {
		t.Fatalf("signature is not base64url: %v", err)
	}
	expected := SigningInput("POST", "/agent/heartbeat", gotTimestamp, gotNonce, gotBody)
	if !identity.Verify(ident.PublicKey, expected, sig) {
		t.Error("the request signature did not verify against the device public key")
	}
}

func TestSignatureDoesNotVerifyForATamperedBody(t *testing.T) {
	ident := newIdentity(t)

	var gotSignature, gotTimestamp, gotNonce string
	var gotBody []byte

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSignature = r.Header.Get("X-NetLink-Signature")
		gotTimestamp = r.Header.Get("X-NetLink-Timestamp")
		gotNonce = r.Header.Get("X-NetLink-Nonce")
		gotBody, _ = io.ReadAll(r.Body)
		_ = json.NewEncoder(w).Encode(HeartbeatResponse{Acknowledged: true})
	}))
	defer server.Close()

	c := New(Options{BaseURL: server.URL, Identity: ident})
	if _, err := c.Heartbeat(context.Background(), HeartbeatRequest{Status: "online"}); err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}

	sig, _ := base64.RawURLEncoding.DecodeString(gotSignature)
	tampered := append([]byte(nil), gotBody...)
	tampered = []byte(strings.Replace(string(tampered), `"online"`, `"offline"`, 1))

	if identity.Verify(ident.PublicKey, SigningInput("POST", "/agent/heartbeat", gotTimestamp, gotNonce, tampered), sig) {
		t.Error("a tampered body still verified")
	}
}

func TestEveryRequestUsesAFreshNonce(t *testing.T) {
	ident := newIdentity(t)
	seen := map[string]bool{}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nonce := r.Header.Get("X-NetLink-Nonce")
		if seen[nonce] {
			t.Errorf("nonce %q was reused", nonce)
		}
		seen[nonce] = true
		_ = json.NewEncoder(w).Encode(HeartbeatResponse{Acknowledged: true})
	}))
	defer server.Close()

	c := New(Options{BaseURL: server.URL, Identity: ident})
	for i := 0; i < 25; i++ {
		if _, err := c.Heartbeat(context.Background(), HeartbeatRequest{Status: "online"}); err != nil {
			t.Fatalf("Heartbeat %d: %v", i, err)
		}
	}
	if len(seen) != 25 {
		t.Errorf("saw %d distinct nonces across 25 requests", len(seen))
	}
}

func TestEnrollNeverSendsThePrivateKey(t *testing.T) {
	ident := newIdentity(t)
	privB64 := base64.RawURLEncoding.EncodeToString(ident.PrivateKey())

	var body string
	var headers http.Header

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		headers = r.Header.Clone()
		_ = json.NewEncoder(w).Encode(EnrollResponse{DeviceID: "device-1", SpaceID: "space-1"})
	}))
	defer server.Close()

	c := New(Options{BaseURL: server.URL, Identity: ident})
	resp, err := c.Enroll(context.Background(), EnrollRequest{
		InstallationID:     ident.InstallationID,
		PublicKey:          ident.PublicKey,
		PublicKeyAlgorithm: "ed25519",
		Name:               "Home PC",
		Platform:           "windows",
		Kind:               "agent",
		EnrollmentToken:    "short-lived-token",
	})
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}

	if strings.Contains(body, privB64) {
		t.Fatal("the enrollment body contained the private key")
	}
	for name, values := range headers {
		for _, value := range values {
			if strings.Contains(value, privB64) {
				t.Fatalf("header %s contained the private key", name)
			}
		}
	}
	if !strings.Contains(body, ident.PublicKey) {
		t.Error("the enrollment body did not contain the public key")
	}

	if resp.DeviceID != "device-1" || c.DeviceID() != "device-1" {
		t.Errorf("device id not recorded: %q / %q", resp.DeviceID, c.DeviceID())
	}
}

func TestServerErrorIsReported(t *testing.T) {
	ident := newIdentity(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"device revoked"}`))
	}))
	defer server.Close()

	c := New(Options{BaseURL: server.URL, Identity: ident})
	_, err := c.Heartbeat(context.Background(), HeartbeatRequest{Status: "online"})
	if err == nil {
		t.Fatal("a 403 was treated as success")
	}
	if !strings.Contains(err.Error(), "403") {
		t.Errorf("error does not mention the status: %v", err)
	}
}

func TestHealthCheck(t *testing.T) {
	ident := newIdentity(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health/live" {
			t.Errorf("health probed %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	c := New(Options{BaseURL: server.URL, Identity: ident})
	if err := c.Health(context.Background()); err != nil {
		t.Fatalf("Health: %v", err)
	}
}

func TestHealthReportsUnreachableControlPlane(t *testing.T) {
	ident := newIdentity(t)
	// A port nothing is listening on.
	c := New(Options{BaseURL: "http://127.0.0.1:1", Identity: ident, Timeout: time.Second})
	if err := c.Health(context.Background()); err == nil {
		t.Fatal("Health reported success against a dead endpoint")
	}
}

func TestContextCancellationIsHonoured(t *testing.T) {
	ident := newIdentity(t)

	// The handler blocks until the test releases it. Relying on the server-side
	// request context instead would deadlock Server.Close, which waits for
	// outstanding handlers regardless of whether the client has gone away.
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	defer server.Close()
	defer close(release)

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	c := New(Options{BaseURL: server.URL, Identity: ident})
	if _, err := c.Heartbeat(ctx, HeartbeatRequest{Status: "online"}); err == nil {
		t.Fatal("a cancelled request reported success")
	}
}

func TestHeartbeatCarriesNoUserContent(t *testing.T) {
	// The heartbeat contract is state, not content. If a field that could carry
	// file names, window titles or browsing data is added, this fails.
	raw, err := json.Marshal(HeartbeatRequest{Status: "online"})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}

	allowed := map[string]bool{
		"deviceId": true, "status": true, "localIpAddress": true, "macAddress": true,
		"wakeOnLanReady": true, "isWakeHelper": true, "appVersion": true, "sentAt": true,
	}
	for field := range decoded {
		if !allowed[field] {
			t.Errorf("heartbeat carries an unexpected field %q", field)
		}
	}
}
