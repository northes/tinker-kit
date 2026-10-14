//go:build darwin && !production && !server

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface NSWindow (TinkerKitWebView)
@property (readonly) WKWebView *webView;
@end

static int enableLocalInspector(void *handle) {
	@try {
		NSWindow *window = (__bridge NSWindow *)handle;
		if (window.webView == nil) {
			return 0;
		}
		[window.webView.configuration.preferences setValue:@YES forKey:@"developerExtrasEnabled"];
		return 1;
	} @catch (NSException *exception) {
		NSLog(@"[devtools] 启用本地检查器失败: %@", exception.reason);
		return 0;
	}
}
*/
import "C"

import (
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Wails 的 inspectable 开关只开放远程检查，本地检查器还需要开发者扩展。
func configureLocalInspector(window *application.WebviewWindow) {
	handle := window.NativeWindow()
	application.InvokeSync(func() {
		if C.enableLocalInspector(handle) == 0 {
			log.Print("[devtools] 本地检查器初始化失败")
		} else {
			log.Print("[devtools] 本地检查器已启用")
		}
	})
}
