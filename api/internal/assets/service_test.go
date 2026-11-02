package assets

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/labstack/echo/v5"
)

func TestAllowedAssetLimitsAndTypes(t *testing.T) {
	cases := []struct {
		kind, contentType string
		size              int64
		want              bool
	}{
		{"source_audio", "audio/wav", 1, true},
		{"source_audio", "audio/wav", maxAudioBytes, true},
		{"source_audio", "audio/wav", maxAudioBytes + 1, false},
		{"source_audio", "application/octet-stream", 10, false},
		{"background_image", "image/png", maxImageBytes, true},
		{"background_image", "image/jpeg", maxImageBytes + 1, false},
		{"background_image", "image/svg+xml", 1024, false},
		{"source_audio", "audio/mp3", 1, false},
		{"source_audio", "audio/flac", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.kind+"-"+tc.contentType+"-"+strconv.FormatInt(tc.size, 10), func(t *testing.T) {
			if got := allowed(tc.kind, tc.contentType, tc.size); got != tc.want {
				t.Fatalf("allowed(%q,%q,%d)=%v want %v", tc.kind, tc.contentType, tc.size, got, tc.want)
			}
		})
	}
}

func TestSafeNameAndObjectKey(t *testing.T) {
	if got := safeName("../private\\sound.wav"); got != "sound.wav" {
		t.Fatalf("safeName=%q", got)
	}
	for _, value := range []string{"", ".", "a\"b.wav", strings.Repeat("x", 256)} {
		if safeName(value) != "" {
			t.Fatalf("unsafe name was accepted: %q", value)
		}
	}
	a := Asset{ID: "00000000-0000-4000-8000-000000000003", ProjectID: "00000000-0000-4000-8000-000000000002", OwnerID: "00000000-0000-4000-8000-000000000001", ObjectKey: "00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003"}
	if !validObjectKey(a) {
		t.Fatal("generated key did not validate")
	}
	a.ObjectKey = "another-owner/" + a.ProjectID + "/" + a.ID
	if validObjectKey(a) {
		t.Fatal("foreign key was accepted")
	}
}

func TestValidateSignatureForImagesAndAudio(t *testing.T) {
	cases := []struct {
		kind, contentType, data string
		valid                   bool
	}{
		{"background_image", "image/png", "\x89PNG\r\n\x1a\nrest", true},
		{"background_image", "image/jpeg", "\xff\xd8\xffrest", true},
		{"source_audio", "audio/wav", "RIFF\x00\x00\x00\x00WAVEdata", true},
		{"source_audio", "audio/ogg", "OggSrest", true},
		{"source_audio", "audio/flac", "fLaCrest", true},
		{"background_image", "image/png", "not an image", false},
	}
	for _, tc := range cases {
		t.Run(tc.contentType+"-"+strconv.FormatBool(tc.valid), func(t *testing.T) {
			file, err := os.CreateTemp(t.TempDir(), "sig")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := file.WriteString(tc.data); err != nil {
				t.Fatal(err)
			}
			if _, err := file.Seek(0, 0); err != nil {
				t.Fatal(err)
			}
			err = validateSignature(file, tc.contentType)
			file.Close()
			if (err == nil) != tc.valid {
				t.Fatalf("signature validity=%v, error=%v", err == nil, err)
			}
		})
	}
}

func TestSpoolAndVerifyUsesBoundedStreamAndDigest(t *testing.T) {
	request := httptest.NewRequest("POST", "/", strings.NewReader("RIFF\x00\x00\x00\x00WAVEdata"))
	recorder := httptest.NewRecorder()
	data := "RIFF\x00\x00\x00\x00WAVEdata"
	digestSum := sha256.Sum256([]byte(data))
	asset := Asset{Kind: "source_audio", ContentType: "audio/wav", ByteSize: 16, SHA256: hex.EncodeToString(digestSum[:])}
	ctx := echo.New().NewContext(request, recorder)
	file, gotHash, size, err := spoolAndVerify(ctx, asset)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if size != 16 || gotHash != asset.SHA256 {
		t.Fatalf("size=%d digest matches=%v", size, gotHash == asset.SHA256)
	}
}
