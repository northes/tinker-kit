//go:build darwin

package main

/*
#cgo CFLAGS: -mmacosx-version-min=10.13 -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -mmacosx-version-min=10.13

#import <Cocoa/Cocoa.h>

extern void tinkerkitMouseNavigationSwipeCallback(int direction, int phase);

static id tinkerkitMouseNavigationMonitor = nil;

static void tinkerkitInstallMouseNavigationMonitorOnMain(void) {
	if (tinkerkitMouseNavigationMonitor != nil) {
		return;
	}

	tinkerkitMouseNavigationMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskAny
		handler:^NSEvent *(NSEvent *event) {
			if ([event type] != NSEventTypeSwipe) {
				return event;
			}
			CGFloat deltaX = [event deltaX];
			int direction = deltaX < 0 ? 1 : (deltaX > 0 ? 2 : 0);
			tinkerkitMouseNavigationSwipeCallback(direction, (int)[event phase]);
			return nil;
		}];
}

static void tinkerkitInstallMouseNavigationMonitor(void) {
	if ([NSThread isMainThread]) {
		tinkerkitInstallMouseNavigationMonitorOnMain();
		return;
	}
	dispatch_sync(dispatch_get_main_queue(), ^{
		tinkerkitInstallMouseNavigationMonitorOnMain();
	});
}

static void tinkerkitRemoveMouseNavigationMonitor(void) {
	if (tinkerkitMouseNavigationMonitor == nil) {
		return;
	}
	[NSEvent removeMonitor:tinkerkitMouseNavigationMonitor];
	tinkerkitMouseNavigationMonitor = nil;
}
*/
import "C"

import "sync"

var mouseNavigationMu sync.RWMutex
var mouseNavigationSwipeHandler func(int, int)

func installMouseNavigationMonitor() {
	C.tinkerkitInstallMouseNavigationMonitor()
}

func installMouseNavigationSwipeMonitor(handler func(int, int)) {
	mouseNavigationMu.Lock()
	mouseNavigationSwipeHandler = handler
	mouseNavigationMu.Unlock()
}

func removeMouseNavigationMonitor() {
	C.tinkerkitRemoveMouseNavigationMonitor()
	mouseNavigationMu.Lock()
	mouseNavigationSwipeHandler = nil
	mouseNavigationMu.Unlock()
}

//export tinkerkitMouseNavigationSwipeCallback
func tinkerkitMouseNavigationSwipeCallback(direction C.int, phase C.int) {
	mouseNavigationMu.RLock()
	handler := mouseNavigationSwipeHandler
	mouseNavigationMu.RUnlock()
	if handler != nil {
		go handler(int(direction), int(phase))
	}
}
