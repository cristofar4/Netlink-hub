// Package wol builds and sends Wake-on-LAN magic packets.
//
// A magic packet is six 0xFF bytes followed by the target MAC repeated sixteen
// times. It is sent as a UDP broadcast on the local network, which is why waking
// a powered-off machine requires a Wake Helper that is already online on the
// same LAN — the cloud cannot reach a machine that is not running.
package wol

import (
	"errors"
	"fmt"
	"net"
	"strings"
)

// MagicPacketSize is 6 sync bytes + 16 * 6 MAC bytes.
const MagicPacketSize = 6 + 16*6

// DefaultPort is the conventional Wake-on-LAN discard port. Port 7 (echo) is
// also used in the wild; both are ignored by a running host and acted on by a
// sleeping NIC.
const DefaultPort = 9

var errBadMAC = errors.New("netlink: MAC address must be six octets, e.g. 00:1A:2B:3C:4D:5E")

// ParseMAC accepts the separators people actually type — colons, hyphens,
// dots or nothing — and rejects anything that is not six octets.
func ParseMAC(value string) (net.HardwareAddr, error) {
	cleaned := strings.Map(func(r rune) rune {
		switch r {
		case ':', '-', '.', ' ':
			return -1
		}
		return r
	}, strings.TrimSpace(value))

	if len(cleaned) != 12 {
		return nil, errBadMAC
	}

	mac := make(net.HardwareAddr, 6)
	for i := 0; i < 6; i++ {
		var b byte
		for j := 0; j < 2; j++ {
			c := cleaned[i*2+j]
			var nibble byte
			switch {
			case c >= '0' && c <= '9':
				nibble = c - '0'
			case c >= 'a' && c <= 'f':
				nibble = c - 'a' + 10
			case c >= 'A' && c <= 'F':
				nibble = c - 'A' + 10
			default:
				return nil, errBadMAC
			}
			b = b<<4 | nibble
		}
		mac[i] = b
	}
	return mac, nil
}

// BuildMagicPacket returns the 102-byte payload for the given MAC.
func BuildMagicPacket(mac net.HardwareAddr) ([]byte, error) {
	if len(mac) != 6 {
		return nil, errBadMAC
	}

	packet := make([]byte, 0, MagicPacketSize)
	for i := 0; i < 6; i++ {
		packet = append(packet, 0xFF)
	}
	for i := 0; i < 16; i++ {
		packet = append(packet, mac...)
	}
	return packet, nil
}

// Sender sends magic packets. Injectable so the wake path can be tested without
// putting traffic on a real network.
type Sender interface {
	Send(packet []byte, broadcast string, port int) error
}

// UDPSender is the real implementation.
type UDPSender struct{}

func (UDPSender) Send(packet []byte, broadcast string, port int) error {
	addr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", broadcast, port))
	if err != nil {
		return fmt.Errorf("netlink: resolving broadcast address: %w", err)
	}
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return fmt.Errorf("netlink: opening wake socket: %w", err)
	}
	defer conn.Close()

	if _, err := conn.Write(packet); err != nil {
		return fmt.Errorf("netlink: sending magic packet: %w", err)
	}
	return nil
}

// Wake builds and sends a magic packet for macAddress.
//
// Sending to a directed broadcast rather than the target's last known IP
// matters: a powered-off machine has no ARP entry, so a unicast packet would
// have nowhere to go.
func Wake(sender Sender, macAddress, broadcast string, port int) error {
	mac, err := ParseMAC(macAddress)
	if err != nil {
		return err
	}
	packet, err := BuildMagicPacket(mac)
	if err != nil {
		return err
	}
	if broadcast == "" {
		broadcast = "255.255.255.255"
	}
	if port <= 0 {
		port = DefaultPort
	}
	return sender.Send(packet, broadcast, port)
}

// Readiness is what the UI shows before it offers a Turn On button.
//
// Every field is a real, separately-checked precondition. The agent fills in
// what it can observe locally; the control plane fills in WakeHelperOnline and
// TargetMACRegistered, because only it knows about the other machine.
type Readiness struct {
	WakeOnLanEnabled    bool `json:"wakeOnLanEnabled"`
	NetworkAdapterFound bool `json:"networkAdapterFound"`
	PowerConnected      bool `json:"powerConnected"`
	WakeHelperOnline    bool `json:"wakeHelperOnline"`
	WakeCapableLink     bool `json:"wakeCapableLink"`
	TargetMACRegistered bool `json:"targetMacRegistered"`
}

// Ready reports whether a wake can be attempted at all.
func (r Readiness) Ready() bool {
	return r.WakeOnLanEnabled &&
		r.NetworkAdapterFound &&
		r.WakeHelperOnline &&
		r.WakeCapableLink &&
		r.TargetMACRegistered
}

// Blockers lists, in user-facing language, what is stopping a wake.
//
// PowerConnected is deliberately not a blocker: on many desktops it cannot be
// detected at all, so treating "unknown" as "not ready" would disable the
// feature on hardware where it works fine.
func (r Readiness) Blockers() []string {
	var blockers []string
	if !r.WakeOnLanEnabled {
		blockers = append(blockers, "Wake-on-LAN is turned off in the BIOS or network adapter settings")
	}
	if !r.NetworkAdapterFound {
		blockers = append(blockers, "No wake-capable network adapter was found")
	}
	if !r.WakeCapableLink {
		blockers = append(blockers, "This computer is not on Ethernet or a supported wake-capable connection")
	}
	if !r.TargetMACRegistered {
		blockers = append(blockers, "This computer's network address has not been registered yet")
	}
	if !r.WakeHelperOnline {
		blockers = append(blockers, "No Wake Helper is online on the same local network")
	}
	return blockers
}
