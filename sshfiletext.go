package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"
)

const remoteTextFileLimit = 2 << 20

type RemoteTextFile struct {
	Content  string `json:"content"`
	Revision string `json:"revision"`
}

func remoteTextPath(value string) (string, error) {
	if strings.TrimSpace(value) == "" || strings.ContainsRune(value, '\x00') {
		return "", userError("errors.sshFile.textPathInvalid")
	}
	value = normalizedRemotePath(value)
	if value == "/" {
		return "", userError("errors.sshFile.textPathInvalid")
	}
	return value, nil
}

func createRemoteText(client *sftp.Client, remotePath string) error {
	if err := ensureRemotePathAbsent(client, remotePath); err != nil {
		return err
	}
	// 排他创建防止检查后目标被其他客户端建立，不截断文件或跟随同名符号链接。
	file, err := client.OpenFile(remotePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return userErrorCause("errors.sshFile.createTextFailed", err)
	}
	if err := file.Close(); err != nil {
		return userErrorCause("errors.sshFile.createTextFailed", err)
	}
	return nil
}

// CreateRemoteTextFile 创建空白纯文本文件，不覆盖已有项目，也不隐式创建父目录。
func (s *FileService) CreateRemoteTextFile(ctx context.Context, sourceID, remotePath string) error {
	remotePath, err := remoteTextPath(remotePath)
	if err != nil {
		return err
	}
	_, connection, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	session, err := s.acquirePersistentSFTP(ctx, sourceID, connection)
	if err != nil {
		return err
	}
	defer s.releasePersistentSFTP(session)
	return createRemoteText(session.sftp, remotePath)
}

func readRemoteText(client *sftp.Client, remotePath string) (RemoteTextFile, os.FileMode, error) {
	info, err := client.Lstat(remotePath)
	if err != nil {
		return RemoteTextFile{}, 0, userErrorCause("errors.sshFile.readTextFailed", err)
	}
	if !info.Mode().IsRegular() {
		return RemoteTextFile{}, 0, userError("errors.sshFile.textNotRegular")
	}
	if info.Size() > remoteTextFileLimit {
		return RemoteTextFile{}, 0, userError("errors.sshFile.textTooLarge")
	}
	file, err := client.Open(remotePath)
	if err != nil {
		return RemoteTextFile{}, 0, userErrorCause("errors.sshFile.readTextFailed", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, remoteTextFileLimit+1))
	if err != nil {
		return RemoteTextFile{}, 0, userErrorCause("errors.sshFile.readTextFailed", err)
	}
	if len(data) > remoteTextFileLimit {
		return RemoteTextFile{}, 0, userError("errors.sshFile.textTooLarge")
	}
	if !utf8.Valid(data) || containsNul(data) {
		return RemoteTextFile{}, 0, userError("errors.sshFile.textInvalidEncoding")
	}
	sum := sha256.Sum256(data)
	return RemoteTextFile{Content: string(data), Revision: hex.EncodeToString(sum[:])}, info.Mode().Perm(), nil
}

func containsNul(data []byte) bool {
	for _, value := range data {
		if value == 0 {
			return true
		}
	}
	return false
}

func saveRemoteText(client *sftp.Client, remotePath, content, revision string) (string, error) {
	data := []byte(content)
	if len(data) > remoteTextFileLimit {
		return "", userError("errors.sshFile.textTooLarge")
	}
	if !utf8.Valid(data) || containsNul(data) {
		return "", userError("errors.sshFile.textInvalidEncoding")
	}
	current, mode, err := readRemoteText(client, remotePath)
	if err != nil {
		return "", err
	}
	if current.Revision != revision {
		return "", userError("errors.sshFile.textChanged")
	}
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	tempPath := path.Join(path.Dir(remotePath), fmt.Sprintf(".tinkerkit-edit-%x", random))
	temp, err := client.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return "", userErrorCause("errors.sshFile.writeTextFailed", err)
	}
	defer client.Remove(tempPath)
	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()
		return "", userErrorCause("errors.sshFile.writeTextFailed", err)
	}
	written, writeErr := temp.Write(data)
	if writeErr == nil && written != len(data) {
		writeErr = io.ErrShortWrite
	}
	closeErr := temp.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return "", userErrorCause("errors.sshFile.writeTextFailed", err)
	}
	latest, _, err := readRemoteText(client, remotePath)
	if err != nil {
		return "", err
	}
	if latest.Revision != revision {
		return "", userError("errors.sshFile.textChanged")
	}
	if err := client.PosixRename(tempPath, remotePath); err != nil {
		return "", userErrorCause("errors.sshFile.writeTextFailed", err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func (s *FileService) ReadRemoteTextFile(ctx context.Context, sourceID, remotePath string) (RemoteTextFile, error) {
	remotePath, err := remoteTextPath(remotePath)
	if err != nil {
		return RemoteTextFile{}, err
	}
	_, connection, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return RemoteTextFile{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	session, err := s.acquirePersistentSFTP(ctx, sourceID, connection)
	if err != nil {
		return RemoteTextFile{}, err
	}
	defer s.releasePersistentSFTP(session)
	result, _, err := readRemoteText(session.sftp, remotePath)
	if err != nil {
		s.invalidatePersistentSFTP(sourceID, session)
	}
	return result, err
}

func (s *FileService) SaveRemoteTextFile(ctx context.Context, sourceID, remotePath, content, revision string) (string, error) {
	remotePath, err := remoteTextPath(remotePath)
	if err != nil {
		return "", err
	}
	_, connection, err := s.sourceSnapshot(sourceID)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	session, err := s.acquirePersistentSFTP(ctx, sourceID, connection)
	if err != nil {
		return "", err
	}
	defer s.releasePersistentSFTP(session)
	return saveRemoteText(session.sftp, remotePath, content, revision)
}
