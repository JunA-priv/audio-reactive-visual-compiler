package audioanalysis

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestProcessGroupCancellationKillsDescendantsAndReapsDirectChild(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "child.pid")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", "sleep 30 & echo $! > \"$1\"; wait", "sh", marker)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	done := make(chan error, 1)
	go func() { done <- runInProcessGroup(ctx, cmd) }()

	var childPID int
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		contents, err := os.ReadFile(marker)
		if err == nil {
			childPID, _ = strconv.Atoi(strings.TrimSpace(string(contents)))
			if childPID > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if childPID <= 0 {
		cancel()
		t.Fatal("test child process did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatalf("process runner error = %v, want context.Canceled", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("process group did not terminate within the bound")
	}
	if cmd.ProcessState == nil {
		t.Fatal("direct child process was not waited/reaped")
	}
	if processState, err := linuxProcessState(childPID); err == nil && processState != 'Z' {
		t.Fatalf("descendant is still running after cancellation (state %q)", processState)
	}
}

func linuxProcessState(pid int) (byte, error) {
	contents, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return 0, err
	}
	closeParen := strings.LastIndexByte(string(contents), ')')
	if closeParen < 0 || closeParen+2 >= len(contents) {
		return 0, os.ErrInvalid
	}
	return contents[closeParen+2], nil
}
