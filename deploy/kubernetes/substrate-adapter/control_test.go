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
