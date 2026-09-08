package relay

import (
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAuthenticatorAcceptsOnceAndRejectsReplay(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	secret := []byte("0123456789abcdef0123456789abcdef")
	a := &authenticator{secret: secret, skew: 30 * time.Second, nonces: newNonceCache(time.Minute, 100), now: func() time.Time { return now }}
	path := "/v1/chathub/11111111-1111-4111-8111-111111111111@22222222-2222-4222-8222-222222222222"
	r := httptest.NewRequest("GET", "https://relay.example"+path, nil)
	r.Header.Set("Origin", "https://api.example")
	r.Header.Set(headerAccessToken, "opaque-access-token")
	r.Header.Set(headerTargetQuery, "chatsessionid=a&clientrequestid=a&X-SessionId=b&ConversationId=c")
	timestamp := "1800000000"
	nonce := "abcdefghijklmnopqrstuvwxyz012345"
	digest := requestDigest(r.Header.Get(headerAccessToken), r.Header.Get(headerTargetQuery))
	digestText := hex.EncodeToString(digest[:])
	r.Header.Set(headerTimestamp, timestamp)
	r.Header.Set(headerNonce, nonce)
	r.Header.Set(headerDigest, digestText)
	r.Header.Set(headerSignature, signRequest(secret, timestamp, nonce, r.Method, path, r.Header.Get("Origin"), digestText))

	if err := a.verify(r, path); err != nil {
		t.Fatalf("first request rejected: %v", err)
	}
	if err := a.verify(r, path); err != errReplay {
		t.Fatalf("replay error = %v, want %v", err, errReplay)
	}
}

func TestAuthenticatorRejectsExpiredAndTamperedRequests(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	secret := []byte("0123456789abcdef0123456789abcdef")
	makeRequest := func(timestamp string) (*authenticator, *httpRequestFixture) {
		a := &authenticator{secret: secret, skew: 30 * time.Second, nonces: newNonceCache(time.Minute, 100), now: func() time.Time { return now }}
		fixture := newSignedRequestFixture(secret, timestamp)
		return a, fixture
	}
	a, expired := makeRequest("1799999900")
	if err := a.verify(expired.request, expired.path); err != errUnauthorized {
		t.Fatalf("expired request error = %v", err)
	}
	a, tampered := makeRequest("1800000000")
	tampered.request.Header.Set(headerTargetQuery, tampered.request.Header.Get(headerTargetQuery)+"&variants=changed")
	if err := a.verify(tampered.request, tampered.path); err != errUnauthorized {
		t.Fatalf("tampered request error = %v", err)
	}
}

type httpRequestFixture struct {
	request *http.Request
	path    string
}

func newSignedRequestFixture(secret []byte, timestamp string) *httpRequestFixture {
	path := "/v1/chathub/11111111-1111-4111-8111-111111111111@22222222-2222-4222-8222-222222222222"
	r := httptest.NewRequest("GET", "https://relay.example"+path, nil)
	r.Header.Set("Origin", "https://api.example")
	r.Header.Set(headerAccessToken, "opaque-access-token")
	r.Header.Set(headerTargetQuery, "chatsessionid=a&clientrequestid=a&X-SessionId=b&ConversationId=c")
	digest := requestDigest(r.Header.Get(headerAccessToken), r.Header.Get(headerTargetQuery))
	digestText := hex.EncodeToString(digest[:])
	nonce := "abcdefghijklmnopqrstuvwxyz012345"
	r.Header.Set(headerTimestamp, timestamp)
	r.Header.Set(headerNonce, nonce)
	r.Header.Set(headerDigest, digestText)
	r.Header.Set(headerSignature, signRequest(secret, timestamp, nonce, r.Method, path, r.Header.Get("Origin"), digestText))
	return &httpRequestFixture{request: r, path: path}
}
