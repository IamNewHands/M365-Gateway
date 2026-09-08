package relay

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	headerTimestamp   = "X-Relay-Timestamp"
	headerNonce       = "X-Relay-Nonce"
	headerDigest      = "X-Relay-Content-Sha256"
	headerSignature   = "X-Relay-Signature"
	headerAccessToken = "X-M365-Access-Token"
	headerTargetQuery = "X-M365-Target-Query"
)

var noncePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22,128}$`)

var (
	errUnauthorized = errors.New("unauthorized")
	errReplay       = errors.New("replayed request")
)

type authenticator struct {
	secret []byte
	skew   time.Duration
	nonces *nonceCache
	now    func() time.Time
}

func (a *authenticator) verify(r *http.Request, expectedPath string) error {
	for _, name := range []string{headerTimestamp, headerNonce, headerDigest, headerSignature, headerAccessToken, headerTargetQuery, "Origin"} {
		if len(r.Header.Values(name)) != 1 {
			return errUnauthorized
		}
	}
	timestampText := strings.TrimSpace(r.Header.Get(headerTimestamp))
	nonce := strings.TrimSpace(r.Header.Get(headerNonce))
	digestText := strings.ToLower(strings.TrimSpace(r.Header.Get(headerDigest)))
	signatureText := strings.TrimSpace(r.Header.Get(headerSignature))
	token := r.Header.Get(headerAccessToken)
	targetQuery := r.Header.Get(headerTargetQuery)
	if timestampText == "" || !noncePattern.MatchString(nonce) || len(digestText) != 64 || signatureText == "" || token == "" {
		return errUnauthorized
	}
	timestamp, err := strconv.ParseInt(timestampText, 10, 64)
	if err != nil {
		return errUnauthorized
	}
	now := a.now()
	delta := now.Sub(time.Unix(timestamp, 0))
	if delta < -a.skew || delta > a.skew {
		return errUnauthorized
	}
	expectedDigest := requestDigest(token, targetQuery)
	providedDigest, err := hex.DecodeString(digestText)
	if err != nil || !hmac.Equal(providedDigest, expectedDigest[:]) {
		return errUnauthorized
	}
	providedSignature, err := base64.RawURLEncoding.DecodeString(signatureText)
	if err != nil {
		return errUnauthorized
	}
	canonical := canonicalRequest(timestampText, nonce, r.Method, expectedPath, r.Header.Get("Origin"), digestText)
	mac := hmac.New(sha256.New, a.secret)
	_, _ = mac.Write([]byte(canonical))
	if !hmac.Equal(providedSignature, mac.Sum(nil)) {
		return errUnauthorized
	}
	if !a.nonces.use(nonce, now) {
		return errReplay
	}
	return nil
}

func requestDigest(token, targetQuery string) [32]byte {
	hash := sha256.New()
	_, _ = hash.Write([]byte("token:"))
	_, _ = hash.Write([]byte(strconv.Itoa(len(token))))
	_, _ = hash.Write([]byte(":"))
	_, _ = hash.Write([]byte(token))
	_, _ = hash.Write([]byte("\nquery:"))
	_, _ = hash.Write([]byte(strconv.Itoa(len(targetQuery))))
	_, _ = hash.Write([]byte(":"))
	_, _ = hash.Write([]byte(targetQuery))
	var result [sha256.Size]byte
	copy(result[:], hash.Sum(nil))
	return result
}

func canonicalRequest(timestamp, nonce, method, path, origin, digest string) string {
	return strings.Join([]string{"M365-RELAY-V1", timestamp, nonce, method, path, origin, digest}, "\n")
}

func signRequest(secret []byte, timestamp, nonce, method, path, origin, digest string) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(canonicalRequest(timestamp, nonce, method, path, origin, digest)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
