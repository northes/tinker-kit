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
				// Wails 创建时未指定 material，默认 appearance-based 自带很实的底色，桌面基本透不出来。
				// underWindowBackground 是为“透出窗口后面内容”设计的，再压一下它自带的不透明度。
				[effect setMaterial:NSVisualEffectMaterialUnderWindowBackground];
				[effect setAlphaValue:0.6];
				[effect setState:NSVisualEffectStateActive];
			} else {
				[effect setAlphaValue:1.0];
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
