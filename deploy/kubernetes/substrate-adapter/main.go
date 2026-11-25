package main

import (
	"bufio"
	"context"
	"crypto/subtle"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	ate "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const (
	servingTrust   = "/run/substrate/trust.pem"
	routerEndpoint = "atenet-router.ate-system.svc:8444"
	maxFrame       = 256 << 20
)

var imageRef = regexp.MustCompile("^([a-z0-9]+([.-][a-z0-9]+)*)(:[0-9]+)?(/[a-z0-9]+([._-]+[a-z0-9]+)*)+@sha256:[a-f0-9]{64}$")

type actorUse struct {
	mu          sync.Mutex
	connections int
	idle        *time.Timer
}

type server struct {
	control  controller
	token    string
	idleTime time.Duration
	actors   sync.Map
}

func (s *server) lock(name string) *actorUse {
	entry, _ := s.actors.LoadOrStore(name, &actorUse{})
	use := entry.(*actorUse)
	use.mu.Lock()
	return use
}

func actorContext(ctx context.Context) (context.Context, error) {
	token, err := os.ReadFile("/run/substrate/token")
	if err != nil {
		return nil, err
	}
	return metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+strings.TrimSpace(string(token)), "ate-preview-allowed", "true"), nil
}

func (s *server) scheduleSuspend(use *actorUse, name string) {
	if use.idle != nil {
		use.idle.Stop()
	}
	var timer *time.Timer
	timer = time.AfterFunc(s.idleTime, func() {
		use.mu.Lock()
		defer use.mu.Unlock()
		if use.idle != timer || use.connections != 0 {
			return
		}
		use.idle = nil
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		ctx, err := actorContext(ctx)
		retry := false
		if err == nil {
			retry, err = s.control.suspendIdleActor(ctx, name)
		}
		if err != nil && status.Code(err) != codes.NotFound {
			log.Printf("suspend %s: %v", name, err)
			retry = true
		}
		if retry {
			s.scheduleSuspend(use, name)
		}
	})
	use.idle = timer
}

// The deployment is single-replica and uses Recreate. When the previous
// adapter exits, its relay sockets and idle timers go with it.
func (s *server) restoreIdleTimers(ctx context.Context) error {
	ctx, err := actorContext(ctx)
	if err != nil {
		return err
	}
	options := &ate.ListOptions{}
	for {
		page, err := s.control.ate.ListActors(ctx, &ate.ListActorsRequest{Atespace: s.control.atespace, Options: options})
		if err != nil {
			return err
		}
		for _, actor := range page.GetActors() {
			name := actor.GetMetadata().GetName()
			if !actorName.MatchString(name) || !needsIdleSuspend(actor.GetStatus().GetState()) {
				continue
			}
			template, err := s.control.ate.GetActorTemplate(ctx, &ate.GetActorTemplateRequest{ActorTemplate: actor.GetActorTemplate()})
			if status.Code(err) == codes.NotFound {
				continue
			}
			if err != nil {
				return err
			}
			if !guildManagedActor(template) {
				continue
			}
			use := s.lock(name)
			if use.connections == 0 && use.idle == nil {
				s.scheduleSuspend(use, name)
			}
			use.mu.Unlock()
		}
		options.PageToken = page.GetNextPageToken()
		if options.PageToken == "" {
			return nil
		}
	}
}

func guildManagedActor(template *ate.ActorTemplate) bool {
	for _, container := range template.GetContainers() {
		command := container.GetCommand()
		if len(command) != 2 || command[0] != "/usr/local/bin/node" {
			continue
		}
		if container.GetName() == "sandbox" && command[1] == "/opt/guild/actor.js" && imageRef.MatchString(container.GetImage()) {
			return true
		}
	}
	return false
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if len(r.Header.Get("Authorization")) != len(s.token)+7 ||
		subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.token)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/healthz":
		writeJSON(w, map[string]string{"runtime": "substrate", "image": s.control.image, "network": "atenet"})
	case r.Method == http.MethodPost && r.URL.Path == "/v1/sandboxes":
		var target sandboxTarget
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&target) != nil || !target.valid() {
			http.Error(w, "invalid sandbox target", http.StatusBadRequest)
			return
		}
		name := resourceName(target.Key)
		use := s.lock(name)
		defer use.mu.Unlock()
		ctx, cancel := context.WithTimeout(r.Context(), 100*time.Second)
		defer cancel()
		ctx, err := actorContext(ctx)
		if err == nil {
			err = s.control.ensure(ctx, name, target.Subpath)
		}
		if err != nil {
			log.Printf("ensure %s: %v", name, err)
			http.Error(w, "could not provision sandbox", http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, map[string]string{"name": name})
	case r.Method == http.MethodDelete && r.URL.Path == "/v1/sandboxes":
		key := r.URL.Query().Get("key")
		if key == "" || len(key) > 256 {
			http.Error(w, "invalid sandbox key", http.StatusBadRequest)
			return
		}
		name := resourceName(key)
		use := s.lock(name)
		defer use.mu.Unlock()
		if use.connections != 0 {
			http.Error(w, "sandbox is attached", http.StatusConflict)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 28*time.Second)
		defer cancel()
		ctx, err := actorContext(ctx)
		if err == nil {
			_, err = s.control.ate.DeleteActor(ctx, &ate.DeleteActorRequest{Actor: s.control.ref(name)})
		}
		if err != nil && status.Code(err) != codes.NotFound {
			log.Printf("delete %s: %v", name, err)
			http.Error(w, "could not delete sandbox", http.StatusServiceUnavailable)
			return
		}
		if use.idle != nil {
			use.idle.Stop()
			use.idle = nil
		}
		writeJSON(w, map[string]bool{"ok": true})
	default:
		name, ok := strings.CutPrefix(r.URL.Path, "/v1/sandboxes/")
		if r.Method == http.MethodPost && ok {
			if stopped, stop := strings.CutSuffix(name, "/stop"); stop && actorName.MatchString(stopped) {
				s.stop(w, r, stopped)
				return
			}
		}
		name, pathOK := strings.CutSuffix(name, "/rpc")
		if r.Method != http.MethodGet || !ok || !pathOK || !websocket.IsWebSocketUpgrade(r) {
			http.NotFound(w, r)
			return
		}
		if !actorName.MatchString(name) {
			http.Error(w, "invalid sandbox name", http.StatusBadRequest)
			return
		}
		s.proxy(w, r, name)
	}
}

func writeJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

func (s *server) stop(w http.ResponseWriter, r *http.Request, name string) {
	use := s.lock(name)
	defer use.mu.Unlock()
	if use.connections != 0 {
		http.Error(w, "sandbox is attached", http.StatusConflict)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()
	ctx, err := actorContext(ctx)
	if err == nil {
		err = s.control.suspendIfNeeded(ctx, name)
	}
	switch status.Code(err) {
	case codes.OK:
		if use.idle != nil {
			use.idle.Stop()
			use.idle = nil
		}
		writeJSON(w, map[string]bool{"ok": true})
	case codes.NotFound:
		http.NotFound(w, r)
	default:
		log.Printf("suspend %s: %v", name, err)
		http.Error(w, "could not suspend sandbox", http.StatusServiceUnavailable)
	}
}

func (s *server) proxy(w http.ResponseWriter, r *http.Request, name string) {
	use := s.lock(name)
	ctx, cancel := context.WithTimeout(r.Context(), 27*time.Second)
	var upstream *websocket.Conn
	actorCtx, err := actorContext(ctx)
	if err == nil {
		var actor *ate.Actor
		actor, err = s.control.ate.GetActor(actorCtx, &ate.GetActorRequest{Actor: s.control.ref(name)})
		if err == nil {
			err = s.control.recoverActor(actorCtx, actor)
		}
	}
	if err == nil {
		upstream, err = dialActor(ctx, s.control.atespace, name)
		// CONNECT may have woken the Actor before the RPC handshake failed.
		if err != nil && use.connections == 0 && use.idle == nil {
			s.scheduleSuspend(use, name)
		}
	}
	cancel()
	if err == nil {
		if use.idle != nil {
			use.idle.Stop()
			use.idle = nil
		}
		use.connections++
	}
	use.mu.Unlock()
	if err != nil {
		if status.Code(err) == codes.NotFound {
			http.NotFound(w, r)
			return
		}
		log.Printf("attach %s: %v", name, err)
		http.Error(w, "could not attach sandbox", http.StatusServiceUnavailable)
		return
	}
	defer func() {
		upstream.Close()
		use.mu.Lock()
		defer use.mu.Unlock()
		use.connections--
		if use.connections == 0 {
			s.scheduleSuspend(use, name)
		}
	}()

	downstream, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer downstream.Close()
	upstream.SetReadLimit(maxFrame)
	downstream.SetReadLimit(maxFrame)
	done := make(chan struct{}, 1)
	go func() {
		relay(upstream, downstream)
		_ = downstream.Close()
		_ = upstream.Close()
		done <- struct{}{}
	}()
	relay(downstream, upstream)
	_ = downstream.Close()
	_ = upstream.Close()
	<-done
}

func relay(dest, src *websocket.Conn) {
	for {
		kind, reader, err := src.NextReader()
		if err != nil {
			return
		}
		writer, err := dest.NextWriter(kind)
		if err != nil {
			return
		}
		_, copyErr := io.Copy(writer, reader)
		if writer.Close() != nil || copyErr != nil {
			return
		}
	}
}

type readerConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c readerConn) Read(buf []byte) (int, error) { return c.reader.Read(buf) }

func dialActor(ctx context.Context, atespace, name string) (*websocket.Conn, error) {
	bundle, err := os.ReadFile("/run/substrate/credential.pem")
	if err != nil {
		return nil, err
	}
	cert, err := tls.X509KeyPair(bundle, bundle)
	if err != nil {
		return nil, err
	}
	pool, err := roots(servingTrust)
	if err != nil {
		return nil, err
	}
	dialer := tls.Dialer{Config: &tls.Config{
		Certificates: []tls.Certificate{cert}, RootCAs: pool, ServerName: "atenet-router.ate-system.svc", MinVersion: tls.VersionTLS12,
	}}
	authority := name + ":8080"
	dial := websocket.Dialer{NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		conn, err := dialer.DialContext(ctx, "tcp", routerEndpoint)
		if err != nil {
			return nil, err
		}
		deadline, _ := ctx.Deadline()
		_ = conn.SetDeadline(deadline)
		req, err := http.NewRequestWithContext(ctx, http.MethodConnect, "http://"+authority, nil)
		if err != nil {
			conn.Close()
			return nil, err
		}
		req.Header.Set("ate-target-actor", atespace+"/"+name)
		if err := req.Write(conn); err != nil {
			conn.Close()
			return nil, err
		}
		reader := bufio.NewReader(conn)
		res, err := http.ReadResponse(reader, req)
		if err != nil {
			conn.Close()
			return nil, err
		}
		if res.StatusCode != http.StatusOK {
			conn.Close()
			return nil, fmt.Errorf("Actor router returned %s", res.Status)
		}
		return readerConn{conn, reader}, nil
	}}
	conn, response, err := dial.DialContext(ctx, "ws://"+authority+"/rpc", nil)
	if response != nil && err != nil {
		_ = response.Body.Close()
	}
	return conn, err
}

func main() {
	atespace := strings.TrimSpace(os.Getenv("GUILD_ATESPACE"))
	if atespace == "" {
		log.Fatal("GUILD_ATESPACE is required")
	}
	workspaceDriver := os.Getenv("GUILD_WORKSPACE_CSI_DRIVER")
	workerSelector := os.Getenv("GUILD_WORKSPACE_WORKER_SELECTOR")
	if workspaceDriver == "" || workerSelector == "" {
		log.Fatal("GUILD_WORKSPACE_CSI_DRIVER and GUILD_WORKSPACE_WORKER_SELECTOR are required")
	}
	token := os.Getenv("GUILD_SANDBOX_RUNNER_TOKEN")
	image := os.Getenv("GUILD_ACTOR_IMAGE")
	if len(token) < 16 || !imageRef.MatchString(image) {
		log.Fatal("invalid runner token or sandbox image reference")
	}
	idle := 90 * time.Second
	if raw := os.Getenv("GUILD_ACTOR_IDLE"); raw != "" {
		value, err := time.ParseDuration(raw)
		if err != nil || value <= 0 {
			log.Fatal("invalid GUILD_ACTOR_IDLE")
		}
		idle = value
	}
	pool, err := roots(servingTrust)
	if err != nil {
		log.Fatal(err)
	}
	channel, err := grpc.NewClient("dns:///api.ate-system.svc:443",
		grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
			RootCAs: pool, ServerName: "api.ate-system.svc", MinVersion: tls.VersionTLS12,
		})),
		grpc.WithDefaultServiceConfig(`{"loadBalancingConfig":[{"round_robin":{}}]}`),
	)
	if err != nil {
		log.Fatal(err)
	}
	kube, err := kubeClient()
	if err != nil {
		log.Fatal(err)
	}
	handler := &server{control: controller{
		ate: ate.NewControlClient(channel), kube: kube, image: image, atespace: atespace,
		snapshotLocation: os.Getenv("GUILD_ACTOR_SNAPSHOT_LOCATION"),
		workspaceDriver:  workspaceDriver, workerSelector: workerSelector,
	}, token: token, idleTime: idle}
	go func() {
		for {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			err := handler.restoreIdleTimers(ctx)
			cancel()
			if err == nil {
				return
			}
			log.Printf("restore idle Actor timers: %v", err)
			time.Sleep(5 * time.Second)
		}
	}()
	httpServer := &http.Server{
		Addr: ":8090", Handler: handler, ReadHeaderTimeout: 5 * time.Second,
	}
	if err := httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
