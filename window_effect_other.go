//go:build !darwin

package main

import "unsafe"

func applyWindowEffect(unsafe.Pointer, bool, bool, int) {}

func systemPrefersDark() bool { return true }
