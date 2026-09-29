package main

import (
	"context"
	"sync"
)

// taskScheduler 限制用户发起的后台任务数量。调整上限只影响后续排队任务，不会中断正在运行的任务。
type taskScheduler struct {
	mu      sync.Mutex
	active  int
	limit   int
	changed chan struct{}
}

func newTaskScheduler(limit int) *taskScheduler {
	return &taskScheduler{limit: clampTaskLimit(limit), changed: make(chan struct{})}
}

func clampTaskLimit(value int) int {
	if value < 1 {
		return 1
	}
	if value > 16 {
		return 16
	}
	return value
}

func (s *taskScheduler) SetLimit(limit int) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.limit = clampTaskLimit(limit)
	close(s.changed)
	s.changed = make(chan struct{})
	s.mu.Unlock()
}

func (s *taskScheduler) Acquire(ctx context.Context) error {
	if s == nil {
		return nil
	}
	for {
		s.mu.Lock()
		if s.active < s.limit {
			s.active++
			s.mu.Unlock()
			return nil
		}
		changed := s.changed
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-changed:
		}
	}
}

func (s *taskScheduler) Release() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.active > 0 {
		s.active--
	}
	close(s.changed)
	s.changed = make(chan struct{})
	s.mu.Unlock()
}
