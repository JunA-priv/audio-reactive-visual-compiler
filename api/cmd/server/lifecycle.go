package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os/signal"
	"syscall"
	"time"
)

func newSignalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
}

func handlerWithRootContext(root context.Context, handler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCtx, cancel := context.WithCancel(r.Context())
		stop := context.AfterFunc(root, cancel)
		defer func() {
			stop()
			cancel()
		}()
		handler.ServeHTTP(w, r.WithContext(requestCtx))
	})
}

func serveUntilShutdown(ctx context.Context, server *http.Server, listener net.Listener, timeout time.Duration) error {
	serveResult := make(chan error, 1)
	go func() { serveResult <- server.Serve(listener) }()

	select {
	case err := <-serveResult:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		closeErr := server.Close()
		serveErr := <-serveResult
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
		return errors.Join(err, closeErr, serveErr)
	}
	serveErr := <-serveResult
	if errors.Is(serveErr, http.ErrServerClosed) {
		return nil
	}
	return serveErr
}
