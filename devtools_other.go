//go:build !darwin || production || server

package main

import "github.com/wailsapp/wails/v3/pkg/application"

func configureLocalInspector(*application.WebviewWindow) {}
