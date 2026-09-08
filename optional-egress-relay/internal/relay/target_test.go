package relay

import (
	"net/url"
	"strings"
	"testing"
)

const testIdentity = "11111111-1111-4111-8111-111111111111@22222222-2222-4222-8222-222222222222"

func TestBuildUpstreamURLUsesOnlyFixedBase(t *testing.T) {
	raw := "chatsessionid=a&clientrequestid=a&X-SessionId=b&ConversationId=c&source=%22officeweb%22&product=Office"
	target, err := buildUpstreamURL(upstreamBase, testIdentity, raw, "secret-token")
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme != "wss" || u.Host != "substrate.office.com" || u.Path != "/m365Copilot/Chathub/"+testIdentity {
		t.Fatalf("unexpected fixed target: scheme=%q host=%q path=%q", u.Scheme, u.Host, u.Path)
	}
	if got := u.Query().Get("access_token"); got != "secret-token" {
		t.Fatal("access token not installed upstream")
	}
}

func TestBuildUpstreamURLRejectsGeneralProxyInputs(t *testing.T) {
	tests := []string{
		"chatsessionid=a&clientrequestid=a&X-SessionId=b&ConversationId=c&target=https://evil.example",
		"chatsessionid=a&clientrequestid=a&X-SessionId=b&ConversationId=c&access_token=leak",
		"chatsessionid=a&clientrequestid=a&X-SessionId=b&ConversationId=c&product=NotOffice",
	}
	for _, raw := range tests {
		if _, err := buildUpstreamURL(upstreamBase, testIdentity, raw, "token"); err == nil {
			t.Fatalf("query should be rejected: %s", strings.Split(raw, "&")[4])
		}
	}
	if _, err := buildUpstreamURL(upstreamBase, "not-an-identity", tests[0], "token"); err == nil {
		t.Fatal("invalid identity should be rejected")
	}
}
