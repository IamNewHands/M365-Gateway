package relay

import (
	"context"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

func bridgeWebSockets(parent context.Context, client, upstream *websocket.Conn, cfg Config) {
	ctx, cancel := context.WithTimeout(parent, cfg.MaxLifetime)
	defer cancel()
	client.SetReadLimit(cfg.MaxFrameBytes)
	upstream.SetReadLimit(cfg.MaxFrameBytes)

	errors := make(chan error, 2)
	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			deadline := time.Now().Add(time.Second)
			_ = client.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "relay closing"), deadline)
			_ = upstream.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "relay closing"), deadline)
			_ = client.Close()
			_ = upstream.Close()
		})
	}
	pump := func(dst, src *websocket.Conn) {
		for {
			_ = src.SetReadDeadline(time.Now().Add(cfg.IdleTimeout))
			messageType, payload, err := src.ReadMessage()
			if err != nil {
				errors <- err
				return
			}
			_ = dst.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := dst.WriteMessage(messageType, payload); err != nil {
				errors <- err
				return
			}
		}
	}
	go pump(upstream, client)
	go pump(client, upstream)
	select {
	case <-ctx.Done():
	case <-errors:
	}
	closeBoth()
	select {
	case <-errors:
	case <-time.After(time.Second):
	}
}
