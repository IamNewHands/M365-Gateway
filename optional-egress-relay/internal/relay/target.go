package relay

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

var identityPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

var allowedQueryKeys = map[string]struct{}{
	"chatsessionid": {}, "clientrequestid": {}, "X-SessionId": {}, "ConversationId": {},
	"variants": {}, "source": {}, "product": {}, "agentHost": {}, "licenseType": {},
	"agent": {}, "scenario": {},
}

func buildUpstreamURL(base, identity, rawQuery, token string) (string, error) {
	if !identityPattern.MatchString(identity) {
		return "", fmt.Errorf("invalid identity")
	}
	if token == "" || len(token) > 32*1024 || len(rawQuery) > 16*1024 {
		return "", fmt.Errorf("invalid protected headers")
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return "", fmt.Errorf("invalid target query")
	}
	for key, list := range values {
		if _, ok := allowedQueryKeys[key]; !ok || len(list) != 1 || len(list[0]) > 8192 {
			return "", fmt.Errorf("target query rejected")
		}
	}
	for _, required := range []string{"chatsessionid", "clientrequestid", "X-SessionId", "ConversationId"} {
		if len(values[required]) != 1 || strings.TrimSpace(values.Get(required)) == "" {
			return "", fmt.Errorf("missing target query field")
		}
	}
	for key, expected := range map[string]string{
		"source": `"officeweb"`, "product": "Office", "agentHost": "Bizchat.FullScreen",
		"licenseType": "Starter", "agent": "web", "scenario": "OfficeWebIncludedCopilot",
	} {
		if value := values.Get(key); value != "" && value != expected {
			return "", fmt.Errorf("fixed target query field rejected")
		}
	}
	values.Set("access_token", token)
	return strings.TrimRight(base, "/") + "/" + strings.ToLower(identity) + "?" + values.Encode(), nil
}
