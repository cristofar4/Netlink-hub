// Package files serves the folders an owner has explicitly approved.
//
// The one rule that everything here exists to enforce: a request can never
// reach outside an approved root. Not by "..", not by an absolute path, not by
// a symlink pointing elsewhere, not by a Windows 8.3 short name, not by an
// alternate data stream. Every path is resolved to its real location on disk
// and checked against the root before anything is opened.
//
// NetLink does not expose a whole drive. There is no path here that lists
// C:\ — the only reachable places are the ones an owner added.
package files

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	// ErrOutsideRoot means the resolved path is not inside an approved folder.
	ErrOutsideRoot = errors.New("netlink: that path is outside the approved folder")
	// ErrNotApproved means no folder with that identifier has been approved.
	ErrNotApproved = errors.New("netlink: that folder has not been approved")
	// ErrNotAFile / ErrNotADirectory guard the obvious type confusions.
	ErrNotAFile      = errors.New("netlink: that path is not a file")
	ErrNotADirectory = errors.New("netlink: that path is not a folder")
)

// Entry is one item inside an approved folder.
type Entry struct {
	Name       string    `json:"name"`
	Path       string    `json:"path"`
	IsDir      bool      `json:"isDir"`
	SizeBytes  int64     `json:"sizeBytes"`
	ModifiedAt time.Time `json:"modifiedAt"`
}

// Root is one approved folder.
type Root struct {
	// ID is the resource id the control plane assigned. The client only ever
	// names a root by this, never by a path.
	ID   string
	Name string
	// Path is the real, symlink-resolved absolute path.
	Path string
	// ReadOnly folders can be browsed and downloaded from, never written to.
	ReadOnly bool
}

// Vault owns the set of approved roots and every path decision.
type Vault struct {
	mu    sync.RWMutex
	roots map[string]Root
}

func NewVault() *Vault {
	return &Vault{roots: make(map[string]Root)}
}

// Approve registers a folder.
//
// The path is resolved and stat'ed now, so a root that does not exist or is not
// a directory is refused at approval time rather than at the first request.
func (v *Vault) Approve(id, name, path string, readOnly bool) (Root, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return Root{}, fmt.Errorf("netlink: resolving %q: %w", path, err)
	}

	// EvalSymlinks collapses any link in the root itself, so the stored root is
	// the real location. Without this, approving a symlink would approve
	// whatever it happens to point at later.
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return Root{}, fmt.Errorf("netlink: %q cannot be opened: %w", path, err)
	}

	info, err := os.Stat(resolved)
	if err != nil {
		return Root{}, fmt.Errorf("netlink: %q cannot be opened: %w", path, err)
	}
	if !info.IsDir() {
		return Root{}, fmt.Errorf("%w: %s", ErrNotADirectory, path)
	}

	root := Root{ID: id, Name: name, Path: resolved, ReadOnly: readOnly}

	v.mu.Lock()
	v.roots[id] = root
	v.mu.Unlock()

	return root, nil
}

// Revoke stops serving a folder immediately.
func (v *Vault) Revoke(id string) {
	v.mu.Lock()
	delete(v.roots, id)
	v.mu.Unlock()
}

// Roots lists the approved folders.
func (v *Vault) Roots() []Root {
	v.mu.RLock()
	defer v.mu.RUnlock()

	roots := make([]Root, 0, len(v.roots))
	for _, root := range v.roots {
		roots = append(roots, root)
	}
	sort.Slice(roots, func(i, j int) bool { return roots[i].Name < roots[j].Name })
	return roots
}

func (v *Vault) root(id string) (Root, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	root, ok := v.roots[id]
	if !ok {
		return Root{}, ErrNotApproved
	}
	return root, nil
}

// Resolve turns a client-supplied relative path into a real absolute path
// inside the root, or refuses.
//
// This is the security boundary of the whole package. Everything that touches
// the filesystem goes through it.
func (v *Vault) Resolve(rootID, relative string) (string, Root, error) {
	root, err := v.root(rootID)
	if err != nil {
		return "", Root{}, err
	}

	// Reject anything that names an absolute location. A UNC path has to be
	// checked explicitly: on Linux `\\server\share` is neither absolute nor
	// drive-prefixed, so it would slip past both other checks and only become
	// dangerous once the same request ran on Windows.
	if filepath.IsAbs(relative) || hasDriveLetter(relative) || isUNCPath(relative) {
		return "", root, ErrOutsideRoot
	}

	// NUL and the Windows alternate-data-stream separator are refused outright.
	// ADS would let "notes.txt:hidden" read a stream the listing never showed.
	if strings.ContainsRune(relative, 0) || strings.Contains(relative, ":") {
		return "", root, ErrOutsideRoot
	}

	// Normalise separators so a Windows-style path works on either platform and
	// cannot smuggle a traversal past a Unix-only check.
	cleaned := filepath.Clean(filepath.FromSlash(strings.ReplaceAll(relative, "\\", "/")))
	if cleaned == "." {
		cleaned = ""
	}

	candidate := filepath.Join(root.Path, cleaned)

	// Join already collapses "..", but check the textual result too: this
	// catches the case where the traversal escaped before Join could contain it.
	if !withinRoot(root.Path, candidate) {
		return "", root, ErrOutsideRoot
	}

	// Finally resolve symlinks. A link *inside* an approved folder pointing
	// outside it is the case a purely textual check would miss entirely.
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		if os.IsNotExist(err) {
			// A path that does not exist yet is legitimate: an upload names its
			// destination, and mkdir names several levels at once. Walk up to
			// the nearest ancestor that *does* exist and check that instead —
			// that is the deepest point a symlink could redirect from.
			if !existingAncestorIsInside(root.Path, candidate) {
				return "", root, ErrOutsideRoot
			}
			return candidate, root, nil
		}
		return "", root, fmt.Errorf("netlink: %w", err)
	}

	if !withinRoot(root.Path, resolved) {
		return "", root, ErrOutsideRoot
	}
	return resolved, root, nil
}

// existingAncestorIsInside walks up from a not-yet-existing path to the first
// ancestor that exists, resolves it, and reports whether it is inside the root.
//
// Anything below a real, in-root directory is in-root too, because the parts
// that do not exist cannot be symlinks.
func existingAncestorIsInside(root, candidate string) bool {
	current := filepath.Dir(candidate)

	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			return withinRoot(root, resolved)
		}
		if !os.IsNotExist(err) {
			return false
		}

		parent := filepath.Dir(current)
		if parent == current {
			// Reached the filesystem root without finding anything real.
			return false
		}
		// Never climb above the approved folder while searching.
		if !withinRoot(root, parent) && parent != root {
			return false
		}
		current = parent
	}
}

// withinRoot reports whether path is root itself or below it.
//
// The separator suffix matters: without it, "/home/user/photos-private" would
// register as inside "/home/user/photos".
func withinRoot(root, path string) bool {
	if path == root {
		return true
	}
	prefix := root
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(path, prefix)
}

// isUNCPath spots a Windows network path, in either separator style.
func isUNCPath(path string) bool {
	return strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, "//")
}

func hasDriveLetter(path string) bool {
	if len(path) < 2 {
		return false
	}
	c := path[0]
	return path[1] == ':' && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))
}

// List returns the contents of a folder inside an approved root.
func (v *Vault) List(rootID, relative string) ([]Entry, error) {
	resolved, root, err := v.Resolve(rootID, relative)
	if err != nil {
		return nil, err
	}

	info, err := os.Stat(resolved)
	if err != nil {
		return nil, fmt.Errorf("netlink: %w", err)
	}
	if !info.IsDir() {
		return nil, ErrNotADirectory
	}

	items, err := os.ReadDir(resolved)
	if err != nil {
		return nil, fmt.Errorf("netlink: %w", err)
	}

	entries := make([]Entry, 0, len(items))
	for _, item := range items {
		itemInfo, err := item.Info()
		if err != nil {
			// A file that vanished mid-listing is not an error worth failing
			// the whole request over.
			continue
		}

		full := filepath.Join(resolved, item.Name())

		// A symlink inside the folder that points outside it is skipped rather
		// than listed — showing it would advertise something unreachable.
		if itemInfo.Mode()&os.ModeSymlink != 0 {
			target, err := filepath.EvalSymlinks(full)
			if err != nil || !withinRoot(root.Path, target) {
				continue
			}
		}

		relativePath, err := filepath.Rel(root.Path, full)
		if err != nil {
			continue
		}

		entries = append(entries, Entry{
			Name:       item.Name(),
			Path:       filepath.ToSlash(relativePath),
			IsDir:      item.IsDir(),
			SizeBytes:  itemInfo.Size(),
			ModifiedAt: itemInfo.ModTime().UTC(),
		})
	}

	// Folders first, then names — the order people expect from a file manager.
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})

	return entries, nil
}

// Open returns a reader for a file, along with its size.
//
// The caller closes the reader. Range reads are supported so a transfer can be
// resumed rather than restarted.
func (v *Vault) Open(rootID, relative string, offset int64) (io.ReadSeekCloser, int64, error) {
	resolved, _, err := v.Resolve(rootID, relative)
	if err != nil {
		return nil, 0, err
	}

	info, err := os.Stat(resolved)
	if err != nil {
		return nil, 0, fmt.Errorf("netlink: %w", err)
	}
	if info.IsDir() {
		return nil, 0, ErrNotAFile
	}

	file, err := os.Open(resolved)
	if err != nil {
		return nil, 0, fmt.Errorf("netlink: %w", err)
	}

	if offset > 0 {
		if offset > info.Size() {
			file.Close()
			return nil, 0, fmt.Errorf("netlink: cannot resume past the end of the file")
		}
		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			file.Close()
			return nil, 0, fmt.Errorf("netlink: %w", err)
		}
	}

	return file, info.Size(), nil
}

// Checksum returns the SHA-256 of a file, so a transfer can be verified.
func (v *Vault) Checksum(rootID, relative string) (string, error) {
	reader, _, err := v.Open(rootID, relative, 0)
	if err != nil {
		return "", err
	}
	defer reader.Close()

	digest := sha256.New()
	if _, err := io.Copy(digest, reader); err != nil {
		return "", fmt.Errorf("netlink: %w", err)
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// Write creates or appends to a file inside an approved root.
//
// Appending is what makes an upload resumable: the client sends the offset it
// got to, and only the remainder travels again.
func (v *Vault) Write(rootID, relative string, offset int64, data io.Reader) (int64, error) {
	resolved, root, err := v.Resolve(rootID, relative)
	if err != nil {
		return 0, err
	}
	if root.ReadOnly {
		return 0, fmt.Errorf("netlink: %q is shared read-only", root.Name)
	}

	if err := os.MkdirAll(filepath.Dir(resolved), 0o755); err != nil {
		return 0, fmt.Errorf("netlink: %w", err)
	}

	flags := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flags |= os.O_TRUNC
	}

	file, err := os.OpenFile(resolved, flags, 0o644)
	if err != nil {
		return 0, fmt.Errorf("netlink: %w", err)
	}
	defer file.Close()

	if offset > 0 {
		info, err := file.Stat()
		if err != nil {
			return 0, fmt.Errorf("netlink: %w", err)
		}
		// Refuse an offset that does not match what is already there, rather
		// than writing into a hole and producing a corrupt file.
		if info.Size() != offset {
			return 0, fmt.Errorf(
				"netlink: cannot resume at %d; the file is %d bytes", offset, info.Size())
		}
		if _, err := file.Seek(offset, io.SeekStart); err != nil {
			return 0, fmt.Errorf("netlink: %w", err)
		}
	}

	written, err := io.Copy(file, data)
	if err != nil {
		return written, fmt.Errorf("netlink: %w", err)
	}
	return written, nil
}

// MakeDir creates a folder inside an approved root.
func (v *Vault) MakeDir(rootID, relative string) error {
	resolved, root, err := v.Resolve(rootID, relative)
	if err != nil {
		return err
	}
	if root.ReadOnly {
		return fmt.Errorf("netlink: %q is shared read-only", root.Name)
	}
	if err := os.MkdirAll(resolved, 0o755); err != nil {
		return fmt.Errorf("netlink: %w", err)
	}
	return nil
}

// Rename moves an item within one approved root.
//
// Both ends are resolved independently, so a rename cannot be used to move
// something out of the folder it lives in.
func (v *Vault) Rename(rootID, from, to string) error {
	fromPath, root, err := v.Resolve(rootID, from)
	if err != nil {
		return err
	}
	if root.ReadOnly {
		return fmt.Errorf("netlink: %q is shared read-only", root.Name)
	}

	toPath, _, err := v.Resolve(rootID, to)
	if err != nil {
		return err
	}

	if err := os.Rename(fromPath, toPath); err != nil {
		return fmt.Errorf("netlink: %w", err)
	}
	return nil
}

// Delete removes a file or an empty folder.
//
// Deliberately not recursive. `files.delete` is already a separate permission
// with its own confirmation; a single mistaken call should not be able to
// erase a directory tree.
func (v *Vault) Delete(rootID, relative string) error {
	resolved, root, err := v.Resolve(rootID, relative)
	if err != nil {
		return err
	}
	if root.ReadOnly {
		return fmt.Errorf("netlink: %q is shared read-only", root.Name)
	}
	// Refuse to delete the root itself, whatever path was used to name it.
	if resolved == root.Path {
		return fmt.Errorf("netlink: an approved folder cannot be deleted through NetLink")
	}

	if err := os.Remove(resolved); err != nil {
		return fmt.Errorf("netlink: %w", err)
	}
	return nil
}
