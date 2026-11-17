//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

static void tinkerkitApplyWindowEffect(void *nsWindow, int dark, int blur) {
	if (nsWindow == NULL) {
		return;
	}
	void (^apply)(void) = ^{
		NSWindow *window = (NSWindow *)nsWindow;
		NSString *appearance = dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua;
		[window setAppearance:[NSAppearance appearanceNamed:appearance]];
		NSView *content = [window contentView];
		if (content == nil) {
			return;
		}
		// 只切换 Wails 创建窗口时插入的那一层，不另插一个 NSVisualEffectView。
		for (NSView *subview in [content subviews]) {
			if (![subview isKindOfClass:[NSVisualEffectView class]]) {
				continue;
			}
			NSVisualEffectView *effect = (NSVisualEffectView *)subview;
			if (blur) {
				[effect setHidden:NO];
				[effect setState:NSVisualEffectStateActive];
			} else {
				[effect setState:NSVisualEffectStateInactive];
				[effect setHidden:YES];
			}
		}
	};
	if ([NSThread isMainThread]) {
		apply();
	} else {
		dispatch_sync(dispatch_get_main_queue(), apply);
	}
}

static int tinkerkitSystemPrefersDark(void) {
	NSString *style = [[NSUserDefaults standardUserDefaults] stringForKey:@"AppleInterfaceStyle"];
	return [style isEqualToString:@"Dark"] ? 1 : 0;
}
*/
import "C"
import "unsafe"

func applyWindowEffect(native unsafe.Pointer, dark bool, blur bool) {
	if native == nil {
		return
	}
	darkFlag := 0
	if dark {
		darkFlag = 1
	}
	blurFlag := 0
	if blur {
		blurFlag = 1
	}
	C.tinkerkitApplyWindowEffect(native, C.int(darkFlag), C.int(blurFlag))
}

func systemPrefersDark() bool {
	return C.tinkerkitSystemPrefersDark() != 0
}
