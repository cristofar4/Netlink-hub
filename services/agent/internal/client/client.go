// Package client talks to the NetLink control plane.
//
// Every request the agent makes is signed with the device's private key, so the
// control plane can tell an enrolled agent from anyone who has merely learned a
// device id. The signature covers the method, path, timestamp and body digest,
// which is what stops a captured request from being replayed against a
// different endpoint.
package client

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/netlink/agent/pkg/identity"
)

// ErrRejected means the control plane refused this device outright — revoked,
// or presenting an identity it does not recognise. Retrying will not help.
var ErrRejected = errors.New("netlink: the control plane rejected this device")

// Client is a thin HTTP client bound to one device identity.
type Client struct {
	baseURL  string
	ident    *identity.Identity
	http     *http.Client
	appVer   string
	deviceID string
}

// Options configure a Client.
type Options struct {
	BaseURL    string
	Identity   *identity.Identity
	AppVersion string
	// DeviceID is assigned by the control plane at enrollment. Empty until then.
	DeviceID string
	Timeout  time.Duration
}

func New(opts Options) *Client {
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return &Client{
		baseURL:  strings.TrimRight(opts.BaseURL, "/"),
		ident:    opts.Identity,
		appVer:   opts.AppVersion,
		deviceID: opts.DeviceID,
		http:     &http.Client{Timeout: timeout},
	}
}

// SetDeviceID records the id the control plane assigned at enrollment.
func (c *Client) SetDeviceID(id string) { c.deviceID = id }

// DeviceID reports the control-plane id, if enrollment has happened.
func (c *Client) DeviceID() string { return c.deviceID }

// SigningInput is the canonical string signed for an authenticated request.
//
// Built in a fixed order for the same reason command envelopes are: a
// signature over a representation whose byte layout can shift is not a
// signature. Including the path and the body digest is what binds a signature
// to one specific request.
func SigningInput(method, path, timestamp, nonce string, body []byte) []byte {
	digest := sha256.Sum256(body)
	var b strings.Builder
	b.WriteString("netlink.agent.v1\n")
	b.WriteString(strings.ToUpper(method))
	b.WriteString("\n")
	b.WriteString(path)
	b.WriteString("\n")
	b.WriteString(timestamp)
	b.WriteString("\n")
	b.WriteString(nonce)
	b.WriteString("\n")
	b.WriteString(base64.RawURLEncoding.EncodeToString(digest[:]))
	return []byte(b.String())
}

// HeartbeatRequest is what the agent reports on each beat.
//
// It carries state, not content: whether the machine is up, what its local
// address is, whether it can act as a Wake Helper. No file names, no window
// titles, no user activity.
type HeartbeatRequest struct {
	DeviceID       string    `json:"deviceId"`
	Status         string    `json:"status"`
	LocalIP        string    `json:"localIpAddress,omitempty"`
	MACAddress     string    `json:"macAddress,omitempty"`
	WakeOnLanReady bool      `json:"wakeOnLanReady"`
	IsWakeHelper   bool      `json:"isWakeHelper"`
	AppVersion     string    `json:"appVersion,omitempty"`
	SentAt         time.Time `json:"sentAt"`
}

// HeartbeatResponse carries anything the control plane wants to hand back —
// pending commands, or an instruction to re-enroll after a revocation.
type HeartbeatResponse struct {
	Acknowledged             bool              `json:"acknowledged"`
	Revoked                  bool              `json:"revoked"`
	Message                  string            `json:"message,omitempty"`
	HeartbeatIntervalSeconds int               `json:"heartbeatIntervalSeconds"`
	PendingCommands          []json.RawMessage `json:"pendingCommands"`
}

// Heartbeat sends one authenticated beat.
func (c *Client) Heartbeat(ctx context.Context, req HeartbeatRequest) (*HeartbeatResponse, error) {
	var out HeartbeatResponse
	if err := c.postSigned(ctx, "/agent/heartbeat", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// EnrollRequest presents this installation's public identity. The private key
// is never part of it.
type EnrollRequest struct {
	InstallationID     string `json:"installationId"`
	PublicKey          string `json:"publicKey"`
	PublicKeyAlgorithm string `json:"publicKeyAlgorithm"`
	Name               string `json:"name"`
	Platform           string `json:"platform"`
	Kind               string `json:"kind"`
	OSVersion          string `json:"osVersion,omitempty"`
	AppVersion         string `json:"appVersion,omitempty"`
	// EnrollmentToken is a short-lived token the desktop app hands to the
	// service so the service never needs the owner's password.
	EnrollmentToken string `json:"enrollmentToken"`
}

// EnrollResponse is the control plane's assignment for this device.
type EnrollResponse struct {
	DeviceID                 string `json:"deviceId"`
	SpaceID                  string `json:"spaceId"`
	SpaceName                string `json:"spaceName"`
	HeartbeatIntervalSeconds int    `json:"heartbeatIntervalSeconds"`
}

// ResourceReport tells the control plane what this computer could offer.
//
// Reporting is not sharing: everything arrives disabled and stays that way
// until the owner turns it on.
type ResourceReport struct {
	DeviceID  string             `json:"deviceId"`
	Resources []ReportedResource `json:"resources"`
}

// ReportedResource is one folder or printer this machine could expose.
type ReportedResource struct {
	Kind     string         `json:"kind"`
	Name     string         `json:"name"`
	Target   string         `json:"target"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// ReportResources sends the current inventory.
func (c *Client) ReportResources(ctx context.Context, report ResourceReport) error {
	return c.postSigned(ctx, "/agent/resources", report, nil)
}

// Enroll registers this installation.
func (c *Client) Enroll(ctx context.Context, req EnrollRequest) (*EnrollResponse, error) {
	var out EnrollResponse
	if err := c.postSigned(ctx, "/agent/enroll", req, &out); err != nil {
		return nil, err
	}
	c.deviceID = out.DeviceID
	return &out, nil
}

// Health checks that the control plane is reachable. Unauthenticated on purpose
// — it is how the agent distinguishes "server is down" from "we are not
// enrolled", which are very different things to show a user.
func (c *Client) Health(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/health/live", nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("netlink: control plane unreachable: %w", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("netlink: control plane returned %s", resp.Status)
	}
	return nil
}

func (c *Client) postSigned(ctx context.Context, path string, payload, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("netlink: encoding request: %w", err)
	}

	timestamp := time.Now().UTC().Format(time.RFC3339Nano)
	nonce, err := randomNonce()
	if err != nil {
		return err
	}

	signature, err := c.ident.Sign(SigningInput(http.MethodPost, path, timestamp, nonce, body))
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-NetLink-Installation", c.ident.InstallationID)
	req.Header.Set("X-NetLink-Public-Key", c.ident.PublicKey)
	req.Header.Set("X-NetLink-Timestamp", timestamp)
	req.Header.Set("X-NetLink-Nonce", nonce)
	req.Header.Set("X-NetLink-Signature", base64.RawURLEncoding.EncodeToString(signature))
	if c.deviceID != "" {
		req.Header.Set("X-NetLink-Device", c.deviceID)
	}
	if c.appVer != "" {
		req.Header.Set("User-Agent", "NetLinkAgent/"+c.appVer)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("netlink: request to %s failed: %w", path, err)
	}
	defer resp.Body.Close()

	// Bounded read: a control plane that starts streaming must not be able to
	// exhaust the agent's memory.
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("netlink: reading response from %s: %w", path, err)
	}

	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		// The control plane is telling us this identity is no longer welcome.
		// That is different from a transient failure and the caller has to be
		// able to tell them apart.
		return fmt.Errorf("%w: %s", ErrRejected, truncate(string(raw), 200))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("netlink: %s returned %s: %s", path, resp.Status, truncate(string(raw), 200))
	}

	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("netlink: decoding response from %s: %w", path, err)
		}
	}
	return nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
