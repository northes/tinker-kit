package main

import "github.com/wailsapp/wails/v3/pkg/application"

// 保存原始文案与菜单项引用，语言切换只更新标题，保留系统角色、快捷键和回调。
func applicationMenuLanguageUpdater(menu *application.Menu) func(Config) {
	translations := map[string]string{
		"File":                  "文件",
		"Close":                 "关闭",
		"Quit":                  "退出",
		"Quit TinkerKit":        "退出 TinkerKit",
		"Edit":                  "编辑",
		"Undo":                  "撤销",
		"Redo":                  "重做",
		"Cut":                   "剪切",
		"Copy":                  "复制",
		"Paste":                 "粘贴",
		"Paste and Match Style": "粘贴并匹配样式",
		"Delete":                "删除",
		"Select All":            "全选",
		"Speech":                "朗读",
		"Start Speaking":        "开始朗读",
		"Stop Speaking":         "停止朗读",
		"View":                  "视图",
		"Force Reload":          "强制重新加载",
		"Open Developer Tools":  "打开开发者工具",
		"Actual Size":           "实际大小",
		"Zoom In":               "放大",
		"Zoom Out":              "缩小",
		"Toggle Full Screen":    "切换全屏",
		"Window":                "窗口",
		"Minimize":              "最小化",
		"Zoom":                  "缩放",
		"Bring All to Front":    "全部置于前台",
		"Help":                  "帮助",
		"Project Homepage":      "项目主页",
	}
	type localizedItem struct {
		item *application.MenuItem
		en   string
		zh   string
	}
	var items []localizedItem
	var collect func(*application.Menu)
	collect = func(current *application.Menu) {
		for index := 0; ; index++ {
			item := current.ItemAt(index)
			if item == nil {
				break
			}
			if label := item.Label(); translations[label] != "" {
				items = append(items, localizedItem{item, label, translations[label]})
			}
			if submenu := item.GetSubmenu(); submenu != nil {
				collect(submenu)
			}
		}
	}
	collect(menu)
	currentLanguage := ""
	return func(cfg Config) {
		if cfg.Language == currentLanguage {
			return
		}
		currentLanguage = cfg.Language
		for _, entry := range items {
			label := entry.zh
			if cfg.Language == "en-US" {
				label = entry.en
			}
			entry.item.SetLabel(label)
		}
		// macOS 顶层菜单使用 NSMenu.title，SetLabel 只更新 NSMenuItem.title。
		// 刷新整棵菜单，让子菜单标题同步使用新的菜单项文案。
		menu.Update()
	}
}
