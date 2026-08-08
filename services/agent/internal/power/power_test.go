package power

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"

	"github.com/netlink/agent/pkg/command"
	"github.com/netlink/agent/pkg/wol"
)

type recordingSender struct {
	packets   [][]byte
	broadcast string
	port      int
	err       error
}

func (r *recordingSender) Send(packet []byte, broadcast string, port int) error {
	r.packets = append(r.packets, append([]byte(nil), packet...))
	r.broadcast = broadcast
	r.port = port
	return r.err
}

func TestWakeSendsAMagicPacket(t *testing.T) {
	sender := &recordingSender{}
	executor := NewWithSender(sender)

	detail, err := executor.Execute(context.Background(), command.ActionWake, Target{
		MACAddress:  "00:1A:2B:3C:4D:5E",
		BroadcastIP: "192.168.1.255",
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if len(sender.packets) != 1 {
		t.Fatalf("sent %d packets, want 1", len(sender.packets))
	}

	mac, _ := wol.ParseMAC("00:1A:2B:3C:4D:5E")
	want, _ := wol.BuildMagicPacket(mac)
	if string(sender.packets[0]) != string(want) {
		t.Error("the packet sent is not the magic packet for that MAC")
	}
	if sender.broadcast != "192.168.1.255" {
		t.Errorf("broadcast = %q", sender.broadcast)
	}
	if sender.port != wol.DefaultPort {
		t.Errorf("port = %d, want %d", sender.port, wol.DefaultPort)
	}
	if !strings.Contains(detail, "00:1A:2B:3C:4D:5E") {
		t.Errorf("detail does not name the target: %q", detail)
	}
}

func TestWakeFallsBackToGlobalBroadcast(t *testing.T) {
	sender := &recordingSender{}
	executor := NewWithSender(sender)

	if _, err := executor.Execute(context.Background(), command.ActionWake, Target{
		MACAddress: "00:1A:2B:3C:4D:5E",
	}); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if sender.broadcast != "255.255.255.255" {
		t.Errorf("broadcast = %q, want the global broadcast", sender.broadcast)
	}
}

func TestWakeRefusesWithoutARegisteredAddress(t *testing.T) {
	sender := &recordingSender{}
	executor := NewWithSender(sender)

	if _, err := executor.Execute(context.Background(), command.ActionWake, Target{}); err == nil {
		t.Fatal("Execute accepted a wake with no MAC address")
	}
	if len(sender.packets) != 0 {
		t.Error("a packet went out despite there being no address to aim at")
	}
}

func TestWakePropagatesSendFailure(t *testing.T) {
	sendErr := errors.New("network unreachable")
	executor := NewWithSender(&recordingSender{err: sendErr})

	_, err := executor.Execute(context.Background(), command.ActionWake, Target{
		MACAddress: "00:1A:2B:3C:4D:5E",
	})
	if !errors.Is(err, sendErr) {
		t.Fatalf("err = %v, want the sender's error", err)
	}
}

func TestNonWakeActionsAreRefusedOffWindows(t *testing.T) {
	// An honest refusal beats a half-working power action on a platform
	// NetLink does not ship on.
	executor := NewWithSender(&recordingSender{})

	for _, action := range []command.Action{
		command.ActionRestart,
		command.ActionShutdown,
		command.ActionLock,
		command.ActionSleep,
	} {
		_, err := executor.Execute(context.Background(), action, Target{})
		if !errors.Is(err, ErrUnsupportedAction) {
			t.Errorf("%s: err = %v, want ErrUnsupportedAction", action, err)
		}
	}
}

func TestUnknownActionIsRefused(t *testing.T) {
	executor := NewWithSender(&recordingSender{})
	if _, err := executor.Execute(context.Background(), "power.format_disk", Target{}); err == nil {
		t.Fatal("Execute accepted an unknown action")
	}
}

func TestExecutorHandlesEveryDefinedAction(t *testing.T) {
	// Every action in the catalogue must produce either a result or a clear
	// refusal — never a silent no-op that reports success.
	executor := NewWithSender(&recordingSender{})

	for _, action := range command.Actions {
		detail, err := executor.Execute(context.Background(), action, Target{
			MACAddress: "00:1A:2B:3C:4D:5E",
		})
		if err == nil && detail == "" {
			t.Errorf("%s: succeeded with no detail to audit", action)
		}
	}
}

func TestParseMACAcceptsWhatAnAgentReports(t *testing.T) {
	// Go's net.Interface renders hardware addresses lowercase and
	// colon-separated; the wake path has to accept exactly that.
	reported := net.HardwareAddr{0x02, 0xfc, 0x00, 0x00, 0x00, 0x01}.String()

	sender := &recordingSender{}
	if _, err := NewWithSender(sender).Execute(context.Background(), command.ActionWake, Target{
		MACAddress: reported,
	}); err != nil {
		t.Fatalf("Execute with %q: %v", reported, err)
	}
	if len(sender.packets) != 1 {
		t.Error("no packet was sent for an address in Go's own format")
	}
}
