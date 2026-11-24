package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	ate "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	atespace        = "guild-experiment"
	workspaceDriver = "workspace.csi.guild.dev"
	uuid            = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)

var (
	agentPath   = regexp.MustCompile("^agents/(" + uuid + ")/(" + uuid + ")$")
	chatPath    = regexp.MustCompile("^chats/(" + uuid + ")/([0-9]+)$")
	sessionPath = regexp.MustCompile("^workspaces/(" + uuid + ")/([A-Za-z0-9_-]{1,64})$")
	actorName   = regexp.MustCompile("^guild-[0-9a-f]{32}$")
)

type sandboxTarget struct{ Key, Subpath string }

func (target sandboxTarget) valid() bool {
	if match := agentPath.FindStringSubmatch(target.Subpath); match != nil {
		return target.Key == "agent:"+match[1]+":"+match[2]
	}
	if match := chatPath.FindStringSubmatch(target.Subpath); match != nil {
		return target.Key == "chat:"+match[1]+":"+match[2]
	}
	if match := sessionPath.FindStringSubmatch(target.Subpath); match != nil {
		return target.Key == "ws:"+match[1]+":"+match[2]
	}
	return false
}

func resourceName(value string) string {
	digest := sha256.Sum256([]byte(value))
	return fmt.Sprintf("guild-%x", digest[:16])
}

func ref(name string) *ate.ObjectRef {
	return &ate.ObjectRef{Atespace: atespace, Name: name}
}

type controller struct {
	ate              ate.ControlClient
	kube             *http.Client
	image            string
	snapshotLocation string
}

func roots(path string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("invalid CA bundle")
	}
	return pool, nil
}

func kubeClient() (*http.Client, error) {
	pool, err := roots("/run/kube/ca.crt")
	if err != nil {
		return nil, err
	}
	return &http.Client{
		Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}},
		Timeout:   15 * time.Second,
	}, nil
}

type storageClass struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Metadata   struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Provisioner   string            `json:"provisioner"`
	Parameters    map[string]string `json:"parameters"`
	ReclaimPolicy string            `json:"reclaimPolicy"`
}

func (c controller) ensureStorage(ctx context.Context, name, path string) error {
	token, err := os.ReadFile("/run/kube/token")
	if err != nil {
		return err
	}
	const url = "https://kubernetes.default.svc/apis/storage.k8s.io/v1/storageclasses"
	class := storageClass{APIVersion: "storage.k8s.io/v1", Kind: "StorageClass", Provisioner: workspaceDriver,
		Parameters: map[string]string{"workspaceKey": path}, ReclaimPolicy: "Retain"}
	class.Metadata.Name = name
	body, err := json.Marshal(class)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	res, err := c.kube.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	switch res.StatusCode {
	case http.StatusCreated:
		return nil
	case http.StatusConflict:
		existing, err := http.NewRequestWithContext(ctx, "GET", url+"/"+name, nil)
		if err != nil {
			return err
		}
		existing.Header.Set("Authorization", req.Header.Get("Authorization"))
		current, err := c.kube.Do(existing)
		if err != nil {
			return err
		}
		defer current.Body.Close()
		var stored storageClass
		if current.StatusCode == 200 && json.NewDecoder(current.Body).Decode(&stored) == nil &&
			stored.Provisioner == workspaceDriver && stored.Parameters["workspaceKey"] == path {
			return nil
		}
		return errors.New("existing StorageClass differs from the Guild workspace mapping")
	default:
		return fmt.Errorf("create StorageClass: HTTP %d", res.StatusCode)
	}
}

func (c controller) ensure(ctx context.Context, name, path string) error {
	legacyTemplate := resourceName(path + "\n" + c.image)
	templateSpec := path + "\n" + c.image + "\npackage-home"
	if c.snapshotLocation != "" {
		templateSpec += "\n" + c.snapshotLocation
	}
	template := resourceName(templateSpec)
	existing, err := c.ate.GetActor(ctx, &ate.GetActorRequest{Actor: ref(name)})
	if err == nil {
		if existing.GetActorTemplate().GetName() != template && existing.GetActorTemplate().GetName() != legacyTemplate {
			return errors.New("existing Actor uses a different workspace template")
		}
		if err := c.ensureEgress(ctx, name); err != nil {
			return err
		}
		if existing.GetStatus().GetState() == ate.ActorState_ACTOR_STATE_CRASHED {
			_, err = c.ate.RevertActor(ctx, &ate.RevertActorRequest{Actor: ref(name)})
		}
		return err
	}
	if status.Code(err) != codes.NotFound {
		return err
	}

	class := resourceName(path)
	if err := c.ensureStorage(ctx, class, path); err != nil {
		return err
	}
	_, err = c.ate.CreateActorTemplate(ctx, &ate.CreateActorTemplateRequest{ActorTemplate: &ate.ActorTemplate{
		Metadata:       &ate.ResourceMetadata{Atespace: atespace, Name: template},
		WorkerSelector: &ate.Selector{MatchLabels: map[string]string{"guild.dev/workload": "sandbox"}},
		Containers: []*ate.Container{{
			Name: "sandbox", Image: c.image, Command: []string{"/usr/local/bin/node", "/opt/guild/actor.js"},
			Env: []*ate.EnvVar{
				{Name: "HOME", Value: "/home/node"},
				{Name: "PATH", Value: "/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
				{Name: "npm_config_prefix", Value: "/home/node/.local"},
				{Name: "npm_config_update_notifier", Value: "false"},
				{Name: "PIP_BREAK_SYSTEM_PACKAGES", Value: "1"},
			},
			SecurityContext: &ate.SecurityContext{Capabilities: &ate.Capabilities{Drop: []string{"ALL"}}},
			VolumeMounts:    []*ate.VolumeMount{{Name: "workspace", MountPath: "/workspace"}},
			WakeupProbe:     &ate.WakeupProbe{HttpGet: &ate.HttpGetAction{Path: "/readyz", Port: 8080}},
		}},
		Volumes: []*ate.Volume{{Name: "workspace", External: &ate.ExternalVolumeSource{Template: &ate.ExternalVolumeTemplate{
			StorageClassName: class, CapacityBytes: 1 << 30,
		}}}},
		Resources:      &ate.ResourceRequirements{Limits: &ate.Resources{CpuMillicores: 500, MemoryBytes: 512 << 20}},
		SnapshotConfig: &ate.SnapshotConfig{StorageLocation: c.snapshotLocation, PreferredFidelity: ate.SnapshotFidelity_SNAPSHOT_FIDELITY_MEMORY},
	}})
	if err != nil && status.Code(err) != codes.AlreadyExists {
		return err
	}
	_, err = c.ate.CreateActor(ctx, &ate.CreateActorRequest{Actor: &ate.Actor{
		Metadata: &ate.ResourceMetadata{Atespace: atespace, Name: name}, ActorTemplate: ref(template),
	}})
	if err != nil && status.Code(err) != codes.AlreadyExists {
		return err
	}
	return c.ensureEgress(ctx, name)
}

func (c controller) ensureEgress(ctx context.Context, name string) error {
	// The existing Guild registry allowlist, expressed as TLS-only DNS rules.
	_, err := c.ate.CreateActorEgressPolicy(ctx, &ate.CreateActorEgressPolicyRequest{
		Actor: ref(name),
		EgressPolicy: &ate.EgressPolicy{
			Metadata: &ate.ResourceMetadata{Atespace: atespace, Name: "default"},
			Rules: []*ate.EgressRule{{TlsPassthrough: &ate.TlsPassthroughRule{
				Hostnames: []string{
					"registry.npmjs.org", "yarnpkg.com", "*.yarnpkg.com",
					"pypi.org", "files.pythonhosted.org",
					"crates.io", "static.crates.io", "index.crates.io",
					"proxy.golang.org", "sum.golang.org",
				},
				Ports: &ate.Ports{Numbers: []int32{443}},
			}}},
		},
	})
	if status.Code(err) == codes.AlreadyExists {
		return nil
	}
	return err
}
