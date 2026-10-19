package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// 日志过滤历史独立于操作历史，由配置服务串行管理并持久化。
func (s *ConfigService) LogFilterHistory(action, query string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	path := filepath.Join(filepath.Dir(s.path), "log-filter-history.json")
	history := []string{}
	data, err := os.ReadFile(path)
	if err == nil {
		if err = json.Unmarshal(data, &history); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	switch action {
	case "list":
		return history, nil
	case "clear":
		history = []string{}
	case "add", "delete":
		query = strings.TrimSpace(query)
		next := []string{}
		if action == "add" && query != "" {
			next = append(next, query)
		}
		for _, item := range history {
			if item != query && len(next) < 50 {
				next = append(next, item)
			}
		}
		history = next
	default:
		return nil, userError("errors.service.logSyntaxInvalid")
	}
	data, err = json.Marshal(history)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	if err = os.WriteFile(path, data, 0600); err != nil {
		return nil, err
	}
	return history, nil
}
