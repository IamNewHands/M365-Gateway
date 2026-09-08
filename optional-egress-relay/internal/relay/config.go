package relay

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const upstreamBase = "wss://substrate.office.com/m365Copilot/Chathub"

type Config struct {
	ListenAddr       string
	HMACSecret       []byte
	AllowedOrigins   map[string]struct{}
	AllowedCIDRs     []*net.IPNet
	MaxConnections   int
	MaxFrameBytes    int64
	HandshakeTimeout time.Duration
	IdleTimeout      time.Duration
	MaxLifetime      time.Duration
	ClockSkew        time.Duration
	NonceCapacity    int
}

func ConfigFromEnv() (Config, error) {
	cfg := Config{
		ListenAddr:       envString("RELAY_LISTEN_ADDR", "127.0.0.1:8090"),
		HMACSecret:       []byte(os.Getenv("RELAY_HMAC_SECRET")),
		MaxConnections:   64,
		MaxFrameBytes:    8 << 20,
		HandshakeTimeout: 15 * time.Second,
		IdleTimeout:      90 * time.Second,
		MaxLifetime:      15 * time.Minute,
		ClockSkew:        30 * time.Second,
		NonceCapacity:    10000,
	}
	var err error
	if cfg.AllowedOrigins, err = parseOrigins(os.Getenv("RELAY_ALLOWED_ORIGINS")); err != nil {
		return Config{}, err
	}
	if cfg.AllowedCIDRs, err = parseCIDRs(os.Getenv("RELAY_ALLOWED_CIDRS")); err != nil {
		return Config{}, err
	}
	if cfg.MaxConnections, err = envInt("RELAY_MAX_CONNECTIONS", cfg.MaxConnections, 1, 4096); err != nil {
		return Config{}, err
	}
	if cfg.MaxFrameBytes, err = envInt64("RELAY_MAX_FRAME_BYTES", cfg.MaxFrameBytes, 1024, 64<<20); err != nil {
		return Config{}, err
	}
	if cfg.HandshakeTimeout, err = envDuration("RELAY_HANDSHAKE_TIMEOUT", cfg.HandshakeTimeout, time.Second, time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.IdleTimeout, err = envDuration("RELAY_IDLE_TIMEOUT", cfg.IdleTimeout, 10*time.Second, 10*time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.MaxLifetime, err = envDuration("RELAY_MAX_LIFETIME", cfg.MaxLifetime, time.Minute, time.Hour); err != nil {
		return Config{}, err
	}
	if cfg.ClockSkew, err = envDuration("RELAY_CLOCK_SKEW", cfg.ClockSkew, 5*time.Second, 5*time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.NonceCapacity, err = envInt("RELAY_NONCE_CAPACITY", cfg.NonceCapacity, 100, 1_000_000); err != nil {
		return Config{}, err
	}
	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) validate() error {
	if len(c.HMACSecret) < 32 {
		return fmt.Errorf("RELAY_HMAC_SECRET must contain at least 32 bytes")
	}
	if len(c.AllowedOrigins) == 0 {
		return fmt.Errorf("RELAY_ALLOWED_ORIGINS is required")
	}
	if c.MaxConnections < 1 || c.MaxFrameBytes < 1024 || c.HandshakeTimeout <= 0 || c.IdleTimeout <= 0 || c.MaxLifetime <= 0 || c.ClockSkew <= 0 || c.NonceCapacity < 1 {
		return fmt.Errorf("invalid relay limits")
	}
	return nil
}

func parseOrigins(raw string) (map[string]struct{}, error) {
	out := make(map[string]struct{})
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		u, err := url.Parse(item)
		if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
			return nil, fmt.Errorf("invalid allowed origin")
		}
		if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")) {
			return nil, fmt.Errorf("allowed origins must use HTTPS")
		}
		out[u.Scheme+"://"+u.Host] = struct{}{}
	}
	return out, nil
}

func parseCIDRs(raw string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		_, block, err := net.ParseCIDR(item)
		if err != nil {
			return nil, fmt.Errorf("invalid allowed CIDR")
		}
		out = append(out, block)
	}
	return out, nil
}

func envString(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback, min, max int) (int, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("invalid %s", name)
	}
	return n, nil
}

func envInt64(name string, fallback, min, max int64) (int64, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("invalid %s", name)
	}
	return n, nil
}

func envDuration(name string, fallback, min, max time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(value)
	if err != nil || d < min || d > max {
		return 0, fmt.Errorf("invalid %s", name)
	}
	return d, nil
}
