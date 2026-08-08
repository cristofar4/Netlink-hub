//go:build !windows && !darwin

package main

import (
	"errors"
	"log/slog"

	"github.com/netlink/agent/internal/agent"
)

// runService runs in the foreground. NetLink ships as a Windows product; this
// path exists so the agent can be built and exercised on a developer machine.
func runService(cfg agent.Config, log *slog.Logger) error {
	return runForeground(cfg, log)
}

func manageService(action string, _ agent.Config) error {
	return errors.New("netlink: service installation is available on Windows only (use `netlink-agent run` here)")
}
