package relay

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type service struct {
	cfg          Config
	ctx          context.Context
	logger       *slog.Logger
	auth         *authenticator
	slots        chan struct{}
	upstreamBase string
	dialer       *websocket.Dialer
	active       *sync.WaitGroup
}

type Handler struct {
	mux    *http.ServeMux
	active *sync.WaitGroup
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mux.ServeHTTP(w, r)
}

func (h *Handler) Wait(ctx context.Context) error {
	done := make(chan struct{})
	go func() {
		h.active.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func NewHandler(cfg Config, logger *slog.Logger) (*Handler, error) {
	return NewHandlerWithContext(context.Background(), cfg, logger)
}

func NewHandlerWithContext(ctx context.Context, cfg Config, logger *slog.Logger) (*Handler, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(discardWriter{}, nil))
	}
	if ctx == nil {
		ctx = context.Background()
	}
	active := &sync.WaitGroup{}
	s := &service{
		cfg: cfg, ctx: ctx, logger: logger, slots: make(chan struct{}, cfg.MaxConnections), upstreamBase: upstreamBase,
		dialer: &websocket.Dialer{
			HandshakeTimeout: cfg.HandshakeTimeout, ReadBufferSize: 64 * 1024, WriteBufferSize: 16 * 1024,
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		},
		active: active,
	}
	s.auth = &authenticator{secret: cfg.HMACSecret, skew: cfg.ClockSkew, nonces: newNonceCache(2*cfg.ClockSkew, cfg.NonceCapacity), now: time.Now}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /v1/chathub/{identity}", s.relay)
	return &Handler{mux: mux, active: active}, nil
}

func (s *service) health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

func (s *service) relay(w http.ResponseWriter, r *http.Request) {
	s.active.Add(1)
	defer s.active.Done()
	requestID := randomID()
	fail := func(status int, code string) {
		s.logger.Warn("relay request rejected", "request_id", requestID, "code", code)
		http.Error(w, http.StatusText(status), status)
	}
	origin := r.Header.Get("Origin")
	if _, ok := s.cfg.AllowedOrigins[origin]; !ok {
		fail(http.StatusForbidden, "origin_rejected")
		return
	}
	if !s.allowedPeer(r.RemoteAddr) {
		fail(http.StatusForbidden, "source_rejected")
		return
	}
	identity := r.PathValue("identity")
	expectedPath := "/v1/chathub/" + identity
	if err := s.auth.verify(r, expectedPath); err != nil {
		if errors.Is(err, errReplay) {
			fail(http.StatusConflict, "replay_rejected")
		} else {
			fail(http.StatusUnauthorized, "authentication_failed")
		}
		return
	}
	targetURL, err := buildUpstreamURL(s.upstreamBase, identity, r.Header.Get(headerTargetQuery), r.Header.Get(headerAccessToken))
	if err != nil {
		fail(http.StatusBadRequest, "target_rejected")
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		fail(http.StatusServiceUnavailable, "connection_limit")
		return
	}

	upstreamHeaders := http.Header{}
	upstreamHeaders.Set("Origin", "https://m365.cloud.microsoft")
	upstreamHeaders.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:148.0) Gecko/20100101 Firefox/148.0")
	dialContext, cancelDial := context.WithCancel(s.ctx)
	stopClientCancel := context.AfterFunc(r.Context(), cancelDial)
	defer func() {
		stopClientCancel()
		cancelDial()
	}()
	upstream, response, err := s.dialer.DialContext(dialContext, targetURL, upstreamHeaders)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
			_ = response.Body.Close()
		}
		s.logger.Warn("upstream websocket rejected", "request_id", requestID, "code", "upstream_dial_failed", "status", status)
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
		return
	}
	defer upstream.Close()

	upgrader := websocket.Upgrader{
		HandshakeTimeout: s.cfg.HandshakeTimeout,
		ReadBufferSize:   64 * 1024, WriteBufferSize: 16 * 1024,
		CheckOrigin: func(req *http.Request) bool { _, ok := s.cfg.AllowedOrigins[req.Header.Get("Origin")]; return ok },
	}
	client, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Warn("client websocket upgrade failed", "request_id", requestID, "code", "client_upgrade_failed")
		return
	}
	defer client.Close()
	s.logger.Info("relay connection opened", "request_id", requestID)
	bridgeWebSockets(s.ctx, client, upstream, s.cfg)
	s.logger.Info("relay connection closed", "request_id", requestID)
}

func (s *service) allowedPeer(remoteAddr string) bool {
	if len(s.cfg.AllowedCIDRs) == 0 {
		return true
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	for _, block := range s.cfg.AllowedCIDRs {
		if block.Contains(ip) {
			return true
		}
	}
	return false
}

func randomID() string {
	var value [8]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "unavailable"
	}
	return hex.EncodeToString(value[:])
}

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
