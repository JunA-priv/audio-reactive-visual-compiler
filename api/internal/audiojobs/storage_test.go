package audiojobs

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const storageTestKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.wav"

func TestSupabaseStoragePrivateObjectLifecycle(t *testing.T) {
	var object []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("apikey") != "server-secret" || r.Header.Get("Authorization") != "Bearer server-secret" {
			t.Errorf("server credentials were not attached")
		}
		if r.URL.Path != "/storage/v1/object/arvc-audio-analysis" && !strings.HasPrefix(r.URL.Path, "/storage/v1/object/arvc-audio-analysis/") {
			t.Errorf("unexpected Storage path %q", r.URL.Path)
		}
		switch r.Method {
		case http.MethodPost:
			if r.Header.Get("x-upsert") != "false" {
				t.Errorf("upload must not overwrite")
			}
			b, _ := io.ReadAll(r.Body)
			if len(object) != 0 {
				w.WriteHeader(http.StatusConflict)
				return
			}
			object = b
			w.WriteHeader(http.StatusOK)
		case http.MethodDelete:
			if r.URL.Path != "/storage/v1/object/arvc-audio-analysis/"+storageTestKey {
				t.Errorf("unexpected delete path %q", r.URL.Path)
			}
			object = nil
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			if len(object) == 0 {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write(object)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()
	storage, err := NewSupabaseStorage(server.URL, "server-secret")
	if err != nil {
		t.Fatal(err)
	}
	audio := append([]byte("RIFF"), make([]byte, 80)...)
	ctx := context.Background()
	if err := storage.Put(ctx, storageTestKey, audio); err != nil {
		t.Fatal(err)
	}
	if err := storage.Put(ctx, storageTestKey, audio); err != nil {
		t.Fatalf("identical retry was not idempotent: %v", err)
	}
	got, err := storage.Get(ctx, storageTestKey)
	if err != nil || string(got) != string(audio) {
		t.Fatalf("get mismatch: err=%v", err)
	}
	if err := storage.Delete(ctx, storageTestKey); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Get(ctx, storageTestKey); err == nil {
		t.Fatal("deleted object remained available")
	}
}

func TestSupabaseStorageLiveOwnerPolicy(t *testing.T) {
	base := os.Getenv("ARVC_STEP7K52_STORAGE_URL")
	anon := os.Getenv("ARVC_STEP7K52_ANON_KEY")
	service := os.Getenv("ARVC_STEP7K52_SERVICE_KEY")
	secret := os.Getenv("ARVC_STEP7K52_JWT_SECRET")
	if base == "" || anon == "" || service == "" || secret == "" {
		t.Skip("isolated Supabase Storage credentials not configured")
	}
	userA := "00000000-0000-4000-8000-0000000000c1"
	userB := "00000000-0000-4000-8000-0000000000c2"
	job := "00000000-0000-4000-8000-0000000000c3"
	key := userA + "/" + job + ".wav"
	audio := append([]byte("RIFF"), make([]byte, 80)...)
	storage, err := NewSupabaseStorage(base, service)
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Put(context.Background(), key, audio); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = storage.Delete(context.Background(), key) }()
	owner := storageUserJWT(t, secret, userA)
	other := storageUserJWT(t, secret, userB)
	request := func(token string) (int, []byte) {
		u, _ := url.Parse(base + "/storage/v1/object/authenticated/" + audioBucket + "/" + key)
		req, _ := http.NewRequest(http.MethodGet, u.String(), nil)
		req.Header.Set("apikey", anon)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return resp.StatusCode, b
	}
	status, b := request(owner)
	if status != http.StatusOK || len(b) != len(audio) {
		t.Fatalf("owner Storage read rejected: status=%d", status)
	}
	if status, _ = request(other); status == http.StatusOK {
		t.Fatal("cross-user Storage read succeeded")
	}
	if status, _ = request(""); status == http.StatusOK {
		t.Fatal("anonymous Storage read succeeded")
	}
	if err := storage.Delete(context.Background(), key); err != nil {
		t.Fatalf("service Storage delete failed: %v", err)
	}
	if _, err := storage.Get(context.Background(), key); err == nil {
		t.Fatal("service-deleted object remained available")
	}
}

func storageUserJWT(t *testing.T, secret, user string) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"iss": "supabase-demo", "aud": "authenticated", "role": "authenticated", "sub": user, "exp": time.Now().Add(time.Hour).Unix()})
	encoded, err := token.SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestStorageTestConstantsRemainValid(t *testing.T) {
	if !objectKeyPattern.MatchString(storageTestKey) {
		t.Fatal(fmt.Sprintf("bad object key %q", storageTestKey))
	}
	if _, err := json.Marshal(map[string][]string{"prefixes": {storageTestKey}}); err != nil {
		t.Fatal(err)
	}
}

func TestSupabaseStorageRejectsUnsafeConfigurationAndKeys(t *testing.T) {
	for _, tc := range []struct{ url, key string }{
		{"http://example.com", "secret"}, {"https://user@example.com", "secret"}, {"https://example.com/path", "secret"}, {"https://example.com", ""},
	} {
		if _, err := NewSupabaseStorage(tc.url, tc.key); err == nil {
			t.Errorf("accepted unsafe Storage config %q", tc.url)
		}
	}
	storage, err := NewSupabaseStorage("https://example.supabase.co", "secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := storage.Get(context.Background(), "../other.wav"); err == nil {
		t.Fatal("accepted path traversal key")
	}
	if err := storage.Delete(context.Background(), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/../../secret"); err == nil {
		t.Fatal("accepted unsafe delete key")
	}
}
