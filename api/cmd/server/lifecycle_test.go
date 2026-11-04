package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type inMemoryListener struct {
	connections chan net.Conn
	closed      chan struct{}
	once        sync.Once
}

func newInMemoryListener() *inMemoryListener {
	return &inMemoryListener{connections: make(chan net.Conn), closed: make(chan struct{})}
}

func (l *inMemoryListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.connections:
		return conn, nil
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *inMemoryListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return nil
}

func (l *inMemoryListener) Addr() net.Addr { return inMemoryAddr("in-memory") }

type inMemoryAddr string

func (a inMemoryAddr) Network() string { return "in-memory" }
func (a inMemoryAddr) String() string  { return string(a) }

func TestSignalContextHandlesSIGTERMAndSIGINT(t *testing.T) {
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGINT} {
		ctx, stop := newSignalContext()
		if err := syscall.Kill(syscall.Getpid(), sig); err != nil {
			stop()
			t.Fatalf("send %s: %v", sig, err)
		}
		select {
		case <-ctx.Done():
			stop()
		case <-time.After(time.Second):
			stop()
			t.Fatalf("%s did not cancel the shutdown context", sig)
		}
	}
}

func TestServeUntilShutdownCancelsRequestsAndStopsAccepting(t *testing.T) {
	root, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	requestCanceled := make(chan struct{})
	handler := handlerWithRootContext(root, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(requestCanceled)
		w.WriteHeader(http.StatusNoContent)
	}))
	listener := newInMemoryListener()
	server := &http.Server{Handler: handler}
	serveDone := make(chan error, 1)
	go func() { serveDone <- serveUntilShutdown(root, server, listener, time.Second) }()

	client, serverConn := net.Pipe()
	listener.connections <- serverConn
	writeDone := make(chan error, 1)
	go func() {
		_, err := io.WriteString(client, "GET / HTTP/1.1\r\nHost: local\r\n\r\n")
		writeDone <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		cancel()
		t.Fatal("HTTP request was not accepted")
	}
	responseDone := make(chan error, 1)
	go func() {
		response, err := http.ReadResponse(bufio.NewReader(client), nil)
		if err == nil {
			err = response.Body.Close()
		}
		responseDone <- err
	}()

	cancel()
	select {
	case err := <-serveDone:
		if err != nil {
			t.Fatalf("graceful shutdown failed: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("graceful shutdown exceeded its deadline")
	}
	select {
	case <-requestCanceled:
	case <-time.After(time.Second):
		t.Fatal("root cancellation did not reach the in-flight request")
	}
	if _, err := listener.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("listener remained open after shutdown: %v", err)
	}
	select {
	case err := <-responseDone:
		if err != nil {
			t.Fatalf("request did not receive shutdown response: %v (writer: %s)", err, strings.TrimSpace(readWriteError(writeDone)))
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown response did not complete")
	}
	_ = client.Close()
}

func TestServeUntilShutdownForcesCloseAtDeadline(t *testing.T) {
	root, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	release := make(chan struct{})
	handlerReturned := make(chan struct{})
	handler := handlerWithRootContext(root, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		defer close(handlerReturned)
		close(started)
		<-release
		w.WriteHeader(http.StatusNoContent)
	}))
	listener := newInMemoryListener()
	server := &http.Server{Handler: handler}
	serveDone := make(chan error, 1)
	go func() { serveDone <- serveUntilShutdown(root, server, listener, 20*time.Millisecond) }()

	client, serverConn := net.Pipe()
	listener.connections <- serverConn
	go func() { _, _ = io.WriteString(client, "GET / HTTP/1.1\r\nHost: local\r\n\r\n") }()
	select {
	case <-started:
	case <-time.After(time.Second):
		cancel()
		close(release)
		t.Fatal("HTTP request was not accepted")
	}
	cancel()
	select {
	case err := <-serveDone:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("shutdown error=%v, want deadline exceeded", err)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown did not enforce its deadline")
	}
	if _, err := listener.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("listener remained open after forced close: %v", err)
	}
	_ = client.Close()
	close(release)
	select {
	case <-handlerReturned:
	case <-time.After(time.Second):
		t.Fatal("forced-close handler did not finish after release")
	}
}

func readWriteError(ch <-chan error) string {
	select {
	case err := <-ch:
		if err != nil {
			return err.Error()
		}
		return "no error"
	default:
		return "still writing"
	}
}
