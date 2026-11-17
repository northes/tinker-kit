//go:build !darwin

package main

import "unsafe"

func applyWindowEffect(unsafe.Pointer, bool, bool) {}

func systemPrefersDark() bool { return true }
