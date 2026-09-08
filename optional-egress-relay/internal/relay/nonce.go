package relay

import (
	"sync"
	"time"
)

type nonceCache struct {
	mu       sync.Mutex
	entries  map[string]time.Time
	ttl      time.Duration
	capacity int
}

func newNonceCache(ttl time.Duration, capacity int) *nonceCache {
	return &nonceCache{entries: make(map[string]time.Time), ttl: ttl, capacity: capacity}
}

func (c *nonceCache) use(nonce string, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, expires := range c.entries {
		if !expires.After(now) {
			delete(c.entries, key)
		}
	}
	if _, exists := c.entries[nonce]; exists || len(c.entries) >= c.capacity {
		return false
	}
	c.entries[nonce] = now.Add(c.ttl)
	return true
}
