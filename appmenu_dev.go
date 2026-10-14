//go:build !production

package main

import "github.com/wailsapp/wails/v3/pkg/application"

const devToolsEnabled = true

func addDevToolsMenuItem(menu *application.Menu, open func()) {
	item := application.NewRole(application.OpenDevTools).OnClick(func(_ *application.Context) {
		open()
	})
	menu.Append(application.NewMenuFromItems(item))
}
