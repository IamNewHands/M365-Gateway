package relay

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestHealthAndOriginBoundary(t *testing.T) {
	handler, err := NewHandler(testConfig(), nil)
	if err != nil {
		t.Fatal(err)
	}
	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest("GET", "/healthz", nil))
	if health.Code != http.StatusOK || !strings.Contains(health.Body.String(), `"status":"ok"`) {
		t.Fatalf("health response: %d %s", health.Code, health.Body.String())
	}
	rejected := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/v1/chathub/"+testIdentity, nil)
	r.Header.Set("Origin", "https://evil.example")
	handler.ServeHTTP(rejected, r)
	if rejected.Code != http.StatusForbidden {
		t.Fatalf("origin status = %d", rejected.Code)
	}
}

func TestWebSocketBridgeAndSecretFreeLogs(t *testing.T) {
	upstreamSeen := make(chan error, 1)
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/m365Copilot/Chathub/"+testIdentity {
			upstreamSeen <- fmt.Errorf("wrong upstream path")
			return
		}
		if r.URL.Query().Get("access_token") != "highly-sensitive-test-token" {
			upstreamSeen <- fmt.Errorf("token missing upstream")
			return
		}
		upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			upstreamSeen <- err
			return
		}
		defer conn.Close()
		messageType, payload, err := conn.ReadMessage()
		if err == nil {
			err = conn.WriteMessage(messageType, payload)
		}
		upstreamSeen <- err
	}))
	defer upstreamServer.Close()

	var logs bytes.Buffer
	cfg := testConfig()
	s := testService(cfg, slog.New(slog.NewJSONHandler(&logs, nil)))
	s.upstreamBase = "ws" + strings.TrimPrefix(upstreamServer.URL, "http") + "/m365Copilot/Chathub"
	relayServer := httptest.NewServer(testMux(s))
	defer relayServer.Close()

	query := "chatsessionid=a&clientrequestid=a&X-SessionId=b&ConversationId=c&source=%22officeweb%22&product=Office"
	path := "/v1/chathub/" + testIdentity
	headers := signedHeaders(cfg.HMACSecret, path, "https://api.example", "highly-sensitive-test-token", query, "abcdefghijklmnopqrstuvwxyz012345")
	conn, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(relayServer.URL, "http")+path, headers)
	if err != nil {
		if response != nil {
			body, _ := io.ReadAll(response.Body)
			t.Fatalf("relay dial: %v: %s", err, body)
		}
		t.Fatal(err)
	}
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("round-trip")); err != nil {
		t.Fatal(err)
	}
	messageType, payload, err := conn.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if messageType != websocket.BinaryMessage || string(payload) != "round-trip" {
		t.Fatalf("unexpected relay payload: type=%d body=%q", messageType, payload)
	}
	if err := <-upstreamSeen; err != nil {
		t.Fatal(err)
	}
	if strings.Contains(logs.String(), "highly-sensitive-test-token") || strings.Contains(logs.String(), query) || strings.Contains(logs.String(), "access_token") {
		t.Fatalf("sensitive material reached logs: %s", logs.String())
	}
}

func testConfig() Config {
	return Config{
		ListenAddr: "127.0.0.1:0", HMACSecret: []byte("0123456789abcdef0123456789abcdef"),
		AllowedOrigins: map[string]struct{}{"https://api.example": {}}, MaxConnections: 4,
		MaxFrameBytes: 1 << 20, HandshakeTimeout: 2 * time.Second, IdleTimeout: 5 * time.Second,
		MaxLifetime: time.Minute, ClockSkew: 30 * time.Second, NonceCapacity: 100,
	}
}

func testService(cfg Config, logger *slog.Logger) *service {
	active := &sync.WaitGroup{}
	return &service{
		cfg: cfg, ctx: context.Background(), logger: logger, slots: make(chan struct{}, cfg.MaxConnections), upstreamBase: upstreamBase,
		dialer: &websocket.Dialer{HandshakeTimeout: cfg.HandshakeTimeout},
		auth:   &authenticator{secret: cfg.HMACSecret, skew: cfg.ClockSkew, nonces: newNonceCache(2*cfg.ClockSkew, cfg.NonceCapacity), now: time.Now},
		active: active,
	}
}

func testMux(s *service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /v1/chathub/{identity}", s.relay)
	return mux
}

func signedHeaders(secret []byte, path, origin, token, query, nonce string) http.Header {
	timestampText := strconv.FormatInt(time.Now().Unix(), 10)
	digest := requestDigest(token, query)
	digestText := hex.EncodeToString(digest[:])
	h := http.Header{}
	h.Set("Origin", origin)
	h.Set(headerAccessToken, token)
	h.Set(headerTargetQuery, query)
	h.Set(headerTimestamp, timestampText)
	h.Set(headerNonce, nonce)
	h.Set(headerDigest, digestText)
	h.Set(headerSignature, signRequest(secret, timestampText, nonce, http.MethodGet, path, origin, digestText))
	return h
}
