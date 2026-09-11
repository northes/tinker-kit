package main

import (
	"os/exec"
	"runtime"
	"strings"
)

// SystemInfo 描述运行 TinkerKit 的操作系统环境。
type SystemInfo struct {
	OS      string `json:"os"`
	Version string `json:"version"`
	Arch    string `json:"arch"`
}

type SystemInfoService struct{}

func NewSystemInfoService() *SystemInfoService { return &SystemInfoService{} }

func (s *SystemInfoService) ServiceName() string { return "SystemInfoService" }

func (s *SystemInfoService) GetSystemInfo() SystemInfo {
	version := ""
	if runtime.GOOS == "darwin" {
		version = macOSVersion()
	}
	return SystemInfo{
		OS:      runtime.GOOS,
		Version: version,
		Arch:    runtime.GOARCH,
	}
}

func macOSVersion() string {
	output, err := exec.Command("sw_vers", "-productVersion").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}
