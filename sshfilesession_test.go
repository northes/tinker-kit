package main

import (
	"context"
	"errors"
	"io"
	"os"
	"testing"

	"github.com/pkg/sftp"
)

// 服务端对单个路径的正常拒绝不该丢掉常驻会话；只有通道/连接本身失效才需要重连。
func TestSftpSessionLostOnlyForBrokenTransports(t *testing.T) {
	cases := []struct {
		name string
		err  error
		lost bool
	}{
		{name: "nil", err: nil, lost: false},
		{name: "permission denied", err: os.ErrPermission, lost: false},
		{name: "wrapped permission denied", err: userErrorCause("errors.sshFile.readTextFailed", os.ErrPermission), lost: false},
		{name: "missing path", err: os.ErrNotExist, lost: false},
		{name: "server refused", err: &sftp.StatusError{Code: uint32(sftp.ErrSSHFxFailure)}, lost: false},
		{name: "local decision", err: userError("errors.sshFile.textTooLarge"), lost: false},
		{name: "canceled by user", err: context.Canceled, lost: false},
		{name: "deadline", err: context.DeadlineExceeded, lost: false},
		{name: "channel closed", err: io.EOF, lost: true},
		{name: "wrapped channel closed", err: userErrorCause("errors.sshFile.readTextFailed", io.EOF), lost: true},
		{name: "connection lost", err: sftp.ErrSSHFxConnectionLost, lost: true},
		{name: "no connection", err: &sftp.StatusError{Code: uint32(sftp.ErrSSHFxNoConnection)}, lost: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := sftpSessionLost(test.err); got != test.lost {
				t.Fatalf("sftpSessionLost(%v) = %v, want %v", test.err, got, test.lost)
			}
		})
	}
}

// 只丢会话本身，其它来源的缓存会话不受影响。
func TestDropPersistentSFTPIfLostKeepsHealthySession(t *testing.T) {
	service := &FileService{sessions: map[string]*persistentSFTPSession{}}
	healthy := &persistentSFTPSession{connection: SSHConnection{Name: "source"}}
	service.sessions["source"] = healthy

	service.dropPersistentSFTPIfLost("source", healthy, os.ErrPermission)
	if service.sessions["source"] != healthy || healthy.retired {
		t.Fatal("permission denied must keep the pooled session")
	}

	service.dropPersistentSFTPIfLost("source", healthy, errors.New("connection lost"))
	if service.sessions["source"] != nil || !healthy.retired {
		t.Fatal("broken transport must retire the pooled session")
	}
}
