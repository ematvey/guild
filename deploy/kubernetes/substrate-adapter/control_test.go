package main

import (
	"context"
	"testing"

	ate "go.ate.dev/substrate/api/ateapi/v1"
	"google.golang.org/grpc"
)

type lifecycleControl struct {
	ate.ControlClient
	actor        *ate.Actor
	suspendCalls int
}

func (c *lifecycleControl) GetActor(context.Context, *ate.GetActorRequest, ...grpc.CallOption) (*ate.Actor, error) {
	return c.actor, nil
}

func (c *lifecycleControl) SuspendActor(context.Context, *ate.SuspendActorRequest, ...grpc.CallOption) (*ate.SuspendActorResponse, error) {
	c.suspendCalls++
	return &ate.SuspendActorResponse{}, nil
}

func TestIdleActorSuspension(t *testing.T) {
	for _, tc := range []struct {
		state ate.ActorState
		retry bool
		calls int
	}{
		{state: ate.ActorState_ACTOR_STATE_UNSPECIFIED},
		{state: ate.ActorState_ACTOR_STATE_RESUMING, retry: true},
		{state: ate.ActorState_ACTOR_STATE_RUNNING, calls: 1},
		{state: ate.ActorState_ACTOR_STATE_SUSPENDING, calls: 1},
		{state: ate.ActorState_ACTOR_STATE_SUSPENDED},
		{state: ate.ActorState_ACTOR_STATE_CRASHED},
		{state: ate.ActorState_ACTOR_STATE_DELETING},
		{state: ate.ActorState_ACTOR_STATE_REVERTING, retry: true},
	} {
		t.Run(tc.state.String(), func(t *testing.T) {
			api := &lifecycleControl{actor: &ate.Actor{Status: &ate.ActorStatus{State: tc.state}}}
			c := controller{ate: api}
			retry, err := c.suspendIdleActor(context.Background(), "example-actor")
			if err != nil || retry != tc.retry || api.suspendCalls != tc.calls {
				t.Fatalf("retry=%t, suspend calls=%d, err=%v; want retry=%t and calls=%d", retry, api.suspendCalls, err, tc.retry, tc.calls)
			}
		})
	}
}

func TestAttachFinishesInterruptedSuspension(t *testing.T) {
	api := &lifecycleControl{actor: &ate.Actor{
		Metadata: &ate.ResourceMetadata{Name: "example-actor"},
		Status:   &ate.ActorStatus{State: ate.ActorState_ACTOR_STATE_SUSPENDING},
	}}
	if err := (controller{ate: api}).recoverActor(context.Background(), api.actor); err != nil || api.suspendCalls != 1 {
		t.Fatalf("suspend calls=%d, err=%v; want one successful suspend", api.suspendCalls, err)
	}
}

func TestSandboxImageReferences(t *testing.T) {
	digest := "@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for _, image := range []string{
		"localhost:5000/guild-sandbox" + digest,
		"registry.example.org/team/guild-sandbox" + digest,
	} {
		if !imageRef.MatchString(image) {
			t.Errorf("rejected digest-pinned image %q", image)
		}
	}
	for _, image := range []string{
		"registry.example.org/team/guild-sandbox:latest",
		"registry.example.org/team/guild-sandbox@sha256:short",
	} {
		if imageRef.MatchString(image) {
			t.Errorf("accepted image without a valid digest %q", image)
		}
	}
}

func TestWorkspaceClassIsScopedToDeployment(t *testing.T) {
	path := "agents/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002"
	dev := controller{workspaceDriver: legacyWorkspaceDriver, workerSelector: "sandbox"}
	prod := controller{workspaceDriver: "workspace.csi.guild.prod", workerSelector: "workspace.csi.guild.prod"}
	if dev.workspaceClass(path) != resourceName(path) {
		t.Fatal("existing dev StorageClasses must keep their names")
	}
	if prod.workspaceClass(path) == dev.workspaceClass(path) ||
		prod.workspaceClass(path) == (controller{workspaceDriver: "workspace.csi.guild.stage"}).workspaceClass(path) {
		t.Fatal("one workspace key produced the same StorageClass in different deployments")
	}
	template := &ate.ActorTemplate{
		WorkerSelector: &ate.Selector{MatchLabels: map[string]string{"guild.dev/workload": prod.workerSelector}},
		Volumes: []*ate.Volume{{Name: "workspace", External: &ate.ExternalVolumeSource{
			Template: &ate.ExternalVolumeTemplate{StorageClassName: prod.workspaceClass(path)},
		}}},
	}
	if !prod.usesWorkspace(template, prod.workspaceClass(path)) || dev.usesWorkspace(template, dev.workspaceClass(path)) {
		t.Fatal("Actor reuse must match its workspace class and deployment worker selector")
	}
	template.WorkerSelector.MatchLabels["guild.dev/workload"] = dev.workerSelector
	if prod.usesWorkspace(template, prod.workspaceClass(path)) {
		t.Fatal("Actor reuse must not accept a worker selector from a different deployment")
	}
}
