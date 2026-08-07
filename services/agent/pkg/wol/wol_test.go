package wol

import (
	"bytes"
	"errors"
	"net"
	"testing"
)

func TestParseMACAcceptsCommonFormats(t *testing.T) {
	want := net.HardwareAddr{0x00, 0x1A, 0x2B, 0x3C, 0x4D, 0x5E}

	for _, input := range []string{
		"00:1A:2B:3C:4D:5E",
		"00-1a-2b-3c-4d-5e",
		"001A2B3C4D5E",
		"00.1a.2b.3c.4d.5e",
		"  00:1A:2B:3C:4D:5E  ",
	} {
		got, err := ParseMAC(input)
		if err != nil {
			t.Errorf("ParseMAC(%q): %v", input, err)
			continue
		}
		if !bytes.Equal(got, want) {
			t.Errorf("ParseMAC(%q) = %v, want %v", input, got, want)
		}
	}
}

func TestParseMACRejectsBadInput(t *testing.T) {
	for _, input := range []string{
		"",
		"00:1A:2B:3C:4D",       // too short
		"00:1A:2B:3C:4D:5E:6F", // too long
		"00:1A:2B:3C:4D:GG",    // non-hex
		"not a mac address",
		"00:1A:2B:3C:4D:5",
	} {
		if _, err := ParseMAC(input); err == nil {
			t.Errorf("ParseMAC(%q) accepted invalid input", input)
		}
	}
}

func TestBuildMagicPacketStructure(t *testing.T) {
	mac := net.HardwareAddr{0x00, 0x1A, 0x2B, 0x3C, 0x4D, 0x5E}

	packet, err := BuildMagicPacket(mac)
	if err != nil {
		t.Fatalf("BuildMagicPacket: %v", err)
	}

	if len(packet) != MagicPacketSize {
		t.Fatalf("packet is %d bytes, want %d", len(packet), MagicPacketSize)
	}

	// Six 0xFF sync bytes.
	for i := 0; i < 6; i++ {
		if packet[i] != 0xFF {
			t.Fatalf("byte %d = %#x, want 0xFF", i, packet[i])
		}
	}

	// Then the MAC, sixteen times.
	for repeat := 0; repeat < 16; repeat++ {
		start := 6 + repeat*6
		if !bytes.Equal(packet[start:start+6], mac) {
			t.Fatalf("repetition %d = % x, want % x", repeat, packet[start:start+6], mac)
		}
	}
}

func TestBuildMagicPacketRejectsWrongLengthMAC(t *testing.T) {
	for _, mac := range []net.HardwareAddr{
		{},
		{0x00, 0x1A, 0x2B},
		{0x00, 0x1A, 0x2B, 0x3C, 0x4D, 0x5E, 0x6F, 0x70},
	} {
		if _, err := BuildMagicPacket(mac); err == nil {
			t.Errorf("BuildMagicPacket accepted a %d-byte MAC", len(mac))
		}
	}
}

func TestBuildMagicPacketIsDeterministic(t *testing.T) {
	mac, _ := ParseMAC("00:1A:2B:3C:4D:5E")
	a, _ := BuildMagicPacket(mac)
	b, _ := BuildMagicPacket(mac)
	if !bytes.Equal(a, b) {
		t.Error("the same MAC produced two different magic packets")
	}
}

type recordingSender struct {
	packet    []byte
	broadcast string
	port      int
	err       error
	calls     int
}

func (r *recordingSender) Send(packet []byte, broadcast string, port int) error {
	r.calls++
	r.packet = append([]byte(nil), packet...)
	r.broadcast = broadcast
	r.port = port
	return r.err
}

func TestWakeSendsTheRightPacket(t *testing.T) {
	sender := &recordingSender{}

	if err := Wake(sender, "00:1A:2B:3C:4D:5E", "192.168.1.255", 9); err != nil {
		t.Fatalf("Wake: %v", err)
	}

	if sender.calls != 1 {
		t.Fatalf("sender called %d times, want 1", sender.calls)
	}
	if sender.broadcast != "192.168.1.255" || sender.port != 9 {
		t.Errorf("sent to %s:%d, want 192.168.1.255:9", sender.broadcast, sender.port)
	}

	mac, _ := ParseMAC("00:1A:2B:3C:4D:5E")
	want, _ := BuildMagicPacket(mac)
	if !bytes.Equal(sender.packet, want) {
		t.Error("Wake sent a packet that is not the magic packet for that MAC")
	}
}

func TestWakeDefaultsBroadcastAndPort(t *testing.T) {
	sender := &recordingSender{}
	if err := Wake(sender, "00:1A:2B:3C:4D:5E", "", 0); err != nil {
		t.Fatalf("Wake: %v", err)
	}
	if sender.broadcast != "255.255.255.255" {
		t.Errorf("broadcast = %q, want 255.255.255.255", sender.broadcast)
	}
	if sender.port != DefaultPort {
		t.Errorf("port = %d, want %d", sender.port, DefaultPort)
	}
}

func TestWakeRefusesInvalidMACWithoutSending(t *testing.T) {
	sender := &recordingSender{}
	if err := Wake(sender, "nonsense", "192.168.1.255", 9); err == nil {
		t.Fatal("Wake accepted an invalid MAC")
	}
	if sender.calls != 0 {
		t.Error("Wake put a packet on the network despite an invalid MAC")
	}
}

func TestWakePropagatesSendError(t *testing.T) {
	sendErr := errors.New("network unreachable")
	sender := &recordingSender{err: sendErr}
	if err := Wake(sender, "00:1A:2B:3C:4D:5E", "192.168.1.255", 9); !errors.Is(err, sendErr) {
		t.Fatalf("err = %v, want the sender's error", err)
	}
}

func TestReadiness(t *testing.T) {
	full := Readiness{
		WakeOnLanEnabled:    true,
		NetworkAdapterFound: true,
		PowerConnected:      true,
		WakeHelperOnline:    true,
		WakeCapableLink:     true,
		TargetMACRegistered: true,
	}

	if !full.Ready() {
		t.Fatal("a fully-satisfied readiness reported not ready")
	}
	if got := full.Blockers(); len(got) != 0 {
		t.Errorf("blockers = %v, want none", got)
	}

	t.Run("each precondition blocks on its own", func(t *testing.T) {
		cases := map[string]func(*Readiness){
			"wake-on-lan disabled": func(r *Readiness) { r.WakeOnLanEnabled = false },
			"no adapter":           func(r *Readiness) { r.NetworkAdapterFound = false },
			"no wake helper":       func(r *Readiness) { r.WakeHelperOnline = false },
			"not wake-capable":     func(r *Readiness) { r.WakeCapableLink = false },
			"no registered MAC":    func(r *Readiness) { r.TargetMACRegistered = false },
		}
		for name, break_ := range cases {
			r := full
			break_(&r)
			if r.Ready() {
				t.Errorf("%s: Ready() = true, want false", name)
			}
			if len(r.Blockers()) != 1 {
				t.Errorf("%s: blockers = %v, want exactly one", name, r.Blockers())
			}
		}
	})

	t.Run("undetectable mains power does not block", func(t *testing.T) {
		// Many desktops cannot report this. Treating unknown as "not ready"
		// would disable wake on hardware where it works.
		r := full
		r.PowerConnected = false
		if !r.Ready() {
			t.Error("undetectable mains power blocked a wake")
		}
	})
}
