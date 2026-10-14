//go:build production

package main

import "github.com/wailsapp/wails/v3/pkg/application"

const devToolsEnabled = false

func addDevToolsMenuItem(*application.Menu, func()) {}
