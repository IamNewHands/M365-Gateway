package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"m365-egress-relay/internal/relay"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	cfg, err := relay.ConfigFromEnv()
	if err != nil {
		logger.Error("configuration rejected", "code", "invalid_config")
		os.Exit(2)
	}

	handler, err := relay.NewHandlerWithContext(ctx, cfg, logger)
	if err != nil {
		logger.Error("relay initialization failed", "code", "invalid_config")
		os.Exit(2)
	}

	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    32 * 1024,
	}
	logger.Info("relay starting", "listen", cfg.ListenAddr)
	serveError := make(chan error, 1)
	go func() { serveError <- server.ListenAndServe() }()
	select {
	case err := <-serveError:
		if err != nil && err != http.ErrServerClosed {
			logger.Error("relay stopped", "code", "listen_failed")
			os.Exit(1)
		}
		return
	case <-ctx.Done():
		logger.Info("relay shutdown requested")
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownContext); err != nil {
		logger.Warn("relay shutdown incomplete", "code", "shutdown_timeout")
		_ = server.Close()
	}
	if err := handler.Wait(shutdownContext); err != nil {
		logger.Warn("active relay drain incomplete", "code", "drain_timeout")
	}
}
