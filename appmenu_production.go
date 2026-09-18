//go:build production && !devtools

package main

import "github.com/wailsapp/wails/v3/pkg/application"

func addDevToolsMenuItem(*application.Menu) {}
