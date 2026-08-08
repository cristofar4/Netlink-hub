package files

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

/*
The tests that matter most here are the escape attempts.

An approved folder is the entire boundary between "the files I chose to share"
and "my whole computer", so each way out is tried explicitly rather than
trusting that filepath.Join is enough.
*/

func newVault(t *testing.T) (*Vault, string) {
	t.Helper()

	base := t.TempDir()
	shared := filepath.Join(base, "shared")
	private := filepath.Join(base, "private")

	for _, dir := range []string{shared, private, filepath.Join(shared, "photos")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}

	write(t, filepath.Join(shared, "notes.txt"), "hello from the shared folder")
	write(t, filepath.Join(shared, "photos", "beach.jpg"), "not really a jpeg")
	write(t, filepath.Join(private, "secrets.txt"), "this must never be reachable")

	vault := NewVault()
	if _, err := vault.Approve("root-1", "Shared", shared, false); err != nil {
		t.Fatalf("Approve: %v", err)
	}
	return vault, base
}

func write(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// -----------------------------------------------------------------------------
// Escaping an approved folder
// -----------------------------------------------------------------------------

func TestTraversalIsRefused(t *testing.T) {
	vault, _ := newVault(t)

	attempts := []string{
		"../private/secrets.txt",
		"../../etc/passwd",
		"photos/../../private/secrets.txt",
		"./../private/secrets.txt",
		"..",
		"../",
		`..\private\secrets.txt`,
		`photos\..\..\private\secrets.txt`,
	}

	for _, attempt := range attempts {
		if _, _, err := vault.Resolve("root-1", attempt); !errors.Is(err, ErrOutsideRoot) {
			t.Errorf("Resolve(%q) err = %v, want ErrOutsideRoot", attempt, err)
		}
	}
}

func TestAbsolutePathsAreRefused(t *testing.T) {
	vault, base := newVault(t)

	attempts := []string{
		filepath.Join(base, "private", "secrets.txt"),
		"/etc/passwd",
		`C:\Windows\System32\config\SAM`,
		`\\server\share\file`,
	}

	for _, attempt := range attempts {
		if _, _, err := vault.Resolve("root-1", attempt); err == nil {
			t.Errorf("Resolve(%q) was accepted", attempt)
		}
	}
}

func TestAlternateDataStreamsAreRefused(t *testing.T) {
	vault, _ := newVault(t)

	// "notes.txt:hidden" would read an NTFS stream that no listing ever showed.
	for _, attempt := range []string{"notes.txt:hidden", "notes.txt:$DATA", "photos:stream"} {
		if _, _, err := vault.Resolve("root-1", attempt); !errors.Is(err, ErrOutsideRoot) {
			t.Errorf("Resolve(%q) err = %v, want ErrOutsideRoot", attempt, err)
		}
	}
}

func TestNulBytesAreRefused(t *testing.T) {
	vault, _ := newVault(t)
	if _, _, err := vault.Resolve("root-1", "notes.txt\x00.png"); !errors.Is(err, ErrOutsideRoot) {
		t.Errorf("err = %v, want ErrOutsideRoot", err)
	}
}

func TestSymlinkOutOfTheFolderIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks on Windows needs elevation")
	}

	vault, base := newVault(t)
	shared := filepath.Join(base, "shared")

	// A link *inside* the approved folder pointing outside it is exactly what a
	// purely textual path check would miss.
	link := filepath.Join(shared, "escape")
	if err := os.Symlink(filepath.Join(base, "private"), link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	if _, _, err := vault.Resolve("root-1", "escape/secrets.txt"); !errors.Is(err, ErrOutsideRoot) {
		t.Errorf("Resolve through a symlink err = %v, want ErrOutsideRoot", err)
	}

	// ...and it is not advertised in the listing either.
	entries, err := vault.List("root-1", "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, entry := range entries {
		if entry.Name == "escape" {
			t.Error("a symlink pointing outside the folder was listed")
		}
	}
}

func TestSiblingDirectoryWithSharedPrefixIsRefused(t *testing.T) {
	base := t.TempDir()
	shared := filepath.Join(base, "photos")
	sibling := filepath.Join(base, "photos-private")

	for _, dir := range []string{shared, sibling} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write(t, filepath.Join(sibling, "secret.txt"), "private")

	vault := NewVault()
	if _, err := vault.Approve("root-1", "Photos", shared, false); err != nil {
		t.Fatalf("Approve: %v", err)
	}

	// "photos-private" starts with "photos"; without a separator in the prefix
	// check, this would resolve as inside the approved folder.
	if _, _, err := vault.Resolve("root-1", "../photos-private/secret.txt"); !errors.Is(err, ErrOutsideRoot) {
		t.Errorf("err = %v, want ErrOutsideRoot", err)
	}
}

func TestUnknownRootIsRefused(t *testing.T) {
	vault, _ := newVault(t)
	if _, _, err := vault.Resolve("not-a-root", "notes.txt"); !errors.Is(err, ErrNotApproved) {
		t.Errorf("err = %v, want ErrNotApproved", err)
	}
}

func TestRevokedRootBecomesUnreachableImmediately(t *testing.T) {
	vault, _ := newVault(t)

	if _, _, err := vault.Resolve("root-1", "notes.txt"); err != nil {
		t.Fatalf("before revoke: %v", err)
	}

	vault.Revoke("root-1")

	if _, _, err := vault.Resolve("root-1", "notes.txt"); !errors.Is(err, ErrNotApproved) {
		t.Errorf("after revoke: err = %v, want ErrNotApproved", err)
	}
}

func TestApproveRefusesAFileOrAMissingPath(t *testing.T) {
	base := t.TempDir()
	write(t, filepath.Join(base, "a-file"), "x")

	vault := NewVault()
	if _, err := vault.Approve("r", "File", filepath.Join(base, "a-file"), false); err == nil {
		t.Error("Approve accepted a file as a folder")
	}
	if _, err := vault.Approve("r", "Missing", filepath.Join(base, "nope"), false); err == nil {
		t.Error("Approve accepted a path that does not exist")
	}
}

// -----------------------------------------------------------------------------
// Ordinary use
// -----------------------------------------------------------------------------

func TestListReturnsFoldersFirst(t *testing.T) {
	vault, _ := newVault(t)

	entries, err := vault.List("root-1", "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2", len(entries))
	}
	if !entries[0].IsDir || entries[0].Name != "photos" {
		t.Errorf("first entry = %+v, want the photos folder", entries[0])
	}
	if entries[1].Name != "notes.txt" || entries[1].SizeBytes == 0 {
		t.Errorf("second entry = %+v", entries[1])
	}
}

func TestListUsesForwardSlashesInPaths(t *testing.T) {
	vault, _ := newVault(t)

	entries, err := vault.List("root-1", "photos")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 || entries[0].Path != "photos/beach.jpg" {
		t.Errorf("entry path = %q, want photos/beach.jpg", entries[0].Path)
	}
}

func TestListRefusesAFile(t *testing.T) {
	vault, _ := newVault(t)
	if _, err := vault.List("root-1", "notes.txt"); !errors.Is(err, ErrNotADirectory) {
		t.Errorf("err = %v, want ErrNotADirectory", err)
	}
}

func TestOpenReadsAFile(t *testing.T) {
	vault, _ := newVault(t)

	reader, size, err := vault.Open("root-1", "notes.txt", 0)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reader.Close()

	contents, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(contents) != "hello from the shared folder" {
		t.Errorf("contents = %q", contents)
	}
	if size != int64(len(contents)) {
		t.Errorf("size = %d, want %d", size, len(contents))
	}
}

func TestOpenResumesFromAnOffset(t *testing.T) {
	vault, _ := newVault(t)

	reader, _, err := vault.Open("root-1", "notes.txt", 6)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer reader.Close()

	contents, _ := io.ReadAll(reader)
	if string(contents) != "from the shared folder" {
		t.Errorf("resumed read = %q", contents)
	}
}

func TestOpenRefusesAnOffsetPastTheEnd(t *testing.T) {
	vault, _ := newVault(t)
	if _, _, err := vault.Open("root-1", "notes.txt", 10_000); err == nil {
		t.Error("Open accepted an offset past the end of the file")
	}
}

func TestOpenRefusesAFolder(t *testing.T) {
	vault, _ := newVault(t)
	if _, _, err := vault.Open("root-1", "photos", 0); !errors.Is(err, ErrNotAFile) {
		t.Errorf("err = %v, want ErrNotAFile", err)
	}
}

func TestChecksumMatchesTheFile(t *testing.T) {
	vault, base := newVault(t)

	got, err := vault.Checksum("root-1", "notes.txt")
	if err != nil {
		t.Fatalf("Checksum: %v", err)
	}

	raw, _ := os.ReadFile(filepath.Join(base, "shared", "notes.txt"))
	digest := sha256.Sum256(raw)
	if got != hex.EncodeToString(digest[:]) {
		t.Errorf("checksum = %s", got)
	}
}

func TestWriteCreatesAFile(t *testing.T) {
	vault, base := newVault(t)

	written, err := vault.Write("root-1", "uploaded.txt", 0, strings.NewReader("new contents"))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if written != 12 {
		t.Errorf("wrote %d bytes", written)
	}

	contents, _ := os.ReadFile(filepath.Join(base, "shared", "uploaded.txt"))
	if string(contents) != "new contents" {
		t.Errorf("file contains %q", contents)
	}
}

func TestWriteResumesAnInterruptedUpload(t *testing.T) {
	vault, base := newVault(t)

	if _, err := vault.Write("root-1", "big.bin", 0, bytes.NewReader([]byte("first half "))); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	if _, err := vault.Write("root-1", "big.bin", 11, bytes.NewReader([]byte("second half"))); err != nil {
		t.Fatalf("second chunk: %v", err)
	}

	contents, _ := os.ReadFile(filepath.Join(base, "shared", "big.bin"))
	if string(contents) != "first half second half" {
		t.Errorf("resumed upload produced %q", contents)
	}
}

func TestWriteRefusesAMismatchedOffset(t *testing.T) {
	vault, _ := newVault(t)

	if _, err := vault.Write("root-1", "big.bin", 0, strings.NewReader("12345")); err != nil {
		t.Fatalf("first chunk: %v", err)
	}
	// Writing into a hole would produce a corrupt file that looked complete.
	if _, err := vault.Write("root-1", "big.bin", 99, strings.NewReader("x")); err == nil {
		t.Error("Write accepted an offset that does not match the file")
	}
}

func TestWriteTruncatesWhenStartingOver(t *testing.T) {
	vault, base := newVault(t)

	_, _ = vault.Write("root-1", "f.txt", 0, strings.NewReader("a much longer original"))
	_, _ = vault.Write("root-1", "f.txt", 0, strings.NewReader("short"))

	contents, _ := os.ReadFile(filepath.Join(base, "shared", "f.txt"))
	if string(contents) != "short" {
		t.Errorf("restarting an upload left %q", contents)
	}
}

func TestWriteCannotEscapeTheFolder(t *testing.T) {
	vault, base := newVault(t)

	if _, err := vault.Write("root-1", "../private/planted.txt", 0, strings.NewReader("x")); err == nil {
		t.Fatal("Write escaped the approved folder")
	}
	if _, err := os.Stat(filepath.Join(base, "private", "planted.txt")); err == nil {
		t.Fatal("a file was written outside the approved folder")
	}
}

func TestMakeDirAndRename(t *testing.T) {
	vault, base := newVault(t)

	if err := vault.MakeDir("root-1", "documents/2026"); err != nil {
		t.Fatalf("MakeDir: %v", err)
	}
	if info, err := os.Stat(filepath.Join(base, "shared", "documents", "2026")); err != nil || !info.IsDir() {
		t.Fatalf("folder was not created: %v", err)
	}

	if err := vault.Rename("root-1", "notes.txt", "documents/notes.txt"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if _, err := os.Stat(filepath.Join(base, "shared", "documents", "notes.txt")); err != nil {
		t.Errorf("renamed file is missing: %v", err)
	}
}

func TestRenameCannotMoveOutOfTheFolder(t *testing.T) {
	vault, _ := newVault(t)
	if err := vault.Rename("root-1", "notes.txt", "../private/stolen.txt"); err == nil {
		t.Error("Rename moved a file out of the approved folder")
	}
}

func TestDelete(t *testing.T) {
	vault, base := newVault(t)

	if err := vault.Delete("root-1", "notes.txt"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(base, "shared", "notes.txt")); !os.IsNotExist(err) {
		t.Error("the file is still there")
	}
}

func TestDeleteRefusesTheRootItself(t *testing.T) {
	vault, _ := newVault(t)

	for _, path := range []string{"", ".", "./"} {
		if err := vault.Delete("root-1", path); err == nil {
			t.Errorf("Delete(%q) removed the approved folder itself", path)
		}
	}
}

func TestDeleteIsNotRecursive(t *testing.T) {
	vault, _ := newVault(t)
	// "photos" contains a file. A single mistaken call must not erase a tree.
	if err := vault.Delete("root-1", "photos"); err == nil {
		t.Error("Delete removed a non-empty folder")
	}
}

func TestReadOnlyFolderRefusesEveryWrite(t *testing.T) {
	base := t.TempDir()
	shared := filepath.Join(base, "readonly")
	if err := os.MkdirAll(shared, 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(shared, "doc.txt"), "readable")

	vault := NewVault()
	if _, err := vault.Approve("ro", "Read only", shared, true); err != nil {
		t.Fatalf("Approve: %v", err)
	}

	if _, err := vault.Write("ro", "new.txt", 0, strings.NewReader("x")); err == nil {
		t.Error("Write succeeded on a read-only folder")
	}
	if err := vault.MakeDir("ro", "sub"); err == nil {
		t.Error("MakeDir succeeded on a read-only folder")
	}
	if err := vault.Rename("ro", "doc.txt", "other.txt"); err == nil {
		t.Error("Rename succeeded on a read-only folder")
	}
	if err := vault.Delete("ro", "doc.txt"); err == nil {
		t.Error("Delete succeeded on a read-only folder")
	}

	// ...but reading still works, which is the point of read-only.
	if _, _, err := vault.Open("ro", "doc.txt", 0); err != nil {
		t.Errorf("Open failed on a read-only folder: %v", err)
	}
}

func TestRootsAreListedAlphabetically(t *testing.T) {
	base := t.TempDir()
	vault := NewVault()

	for _, name := range []string{"Zebra", "Alpha", "Mango"} {
		dir := filepath.Join(base, name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := vault.Approve(name, name, dir, false); err != nil {
			t.Fatal(err)
		}
	}

	roots := vault.Roots()
	if len(roots) != 3 || roots[0].Name != "Alpha" || roots[2].Name != "Zebra" {
		t.Errorf("roots = %+v", roots)
	}
}

func TestNothingOutsideAnApprovedFolderIsReachable(t *testing.T) {
	// The product promise, asserted directly: with one folder approved, no
	// call reaches the sibling folder beside it.
	vault, base := newVault(t)
	secret := filepath.Join(base, "private", "secrets.txt")

	for _, attempt := range []string{
		"../private/secrets.txt",
		secret,
		"photos/../../private/secrets.txt",
		`..\private\secrets.txt`,
	} {
		if _, _, err := vault.Open("root-1", attempt, 0); err == nil {
			t.Errorf("Open(%q) reached outside the approved folder", attempt)
		}
		if _, err := vault.List("root-1", attempt); err == nil {
			t.Errorf("List(%q) reached outside the approved folder", attempt)
		}
	}
}
