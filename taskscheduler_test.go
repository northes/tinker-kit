package main

import (
	"context"
	"testing"
	"time"
)

func TestTaskSchedulerResizesWithoutCancelingActiveWork(t *testing.T) {
	scheduler := newTaskScheduler(1)
	if err := scheduler.Acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	second := make(chan struct{})
	go func() {
		if err := scheduler.Acquire(context.Background()); err == nil {
			close(second)
		}
	}()
	select {
	case <-second:
		t.Fatal("second task acquired a slot above the configured limit")
	case <-time.After(30 * time.Millisecond):
	}
	scheduler.SetLimit(2)
	select {
	case <-second:
	case <-time.After(time.Second):
		t.Fatal("raising the limit did not release queued work")
	}
	scheduler.SetLimit(1)
	third := make(chan struct{})
	go func() {
		if err := scheduler.Acquire(context.Background()); err == nil {
			close(third)
		}
	}()
	scheduler.Release()
	select {
	case <-third:
		t.Fatal("lowering the limit admitted work while active count was still at the limit")
	case <-time.After(30 * time.Millisecond):
	}
	scheduler.Release()
	select {
	case <-third:
	case <-time.After(time.Second):
		t.Fatal("queued task did not acquire after active work drained")
	}
	scheduler.Release()
}

func TestTaskSchedulerClampsLimit(t *testing.T) {
	scheduler := newTaskScheduler(99)
	scheduler.mu.Lock()
	got := scheduler.limit
	scheduler.mu.Unlock()
	if got != 16 {
		t.Fatalf("limit = %d, want 16", got)
	}
	scheduler.SetLimit(0)
	scheduler.mu.Lock()
	got = scheduler.limit
	scheduler.mu.Unlock()
	if got != 1 {
		t.Fatalf("limit = %d, want 1", got)
	}
}

func TestTaskSchedulerRaisesLimitForQueuedTasksImmediately(t *testing.T) {
	scheduler := newTaskScheduler(2)
	for range 2 {
		if err := scheduler.Acquire(context.Background()); err != nil {
			t.Fatal(err)
		}
	}

	acquired := make(chan struct{}, 2)
	for range 2 {
		go func() {
			if err := scheduler.Acquire(context.Background()); err == nil {
				acquired <- struct{}{}
			}
		}()
	}

	scheduler.SetLimit(4)
	for range 2 {
		select {
		case <-acquired:
		case <-time.After(time.Second):
			t.Fatal("raising the limit did not immediately admit queued tasks")
		}
	}
	for range 4 {
		scheduler.Release()
	}
}
