package audiojobs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const audioBucket = "arvc-audio-analysis"

var objectKeyPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$`)

// ObjectStorage exposes only the private audio bucket operations required by
// the job lifecycle. Keys are UUID-pair scoped and never accepted from clients.
type ObjectStorage interface {
	Put(context.Context, string, []byte) error
	Get(context.Context, string) ([]byte, error)
	Delete(context.Context, string) error
}

type SupabaseStorage struct {
	baseURL string
	key     string
	client  *http.Client
}

func NewSupabaseStorage(baseURL, serverKey string) (*SupabaseStorage, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	u, err := url.Parse(baseURL)
	if err != nil || u == nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "https" && !(u.Scheme == "http" && isLoopbackHost(u.Hostname()))) || strings.TrimSpace(serverKey) == "" {
		return nil, errors.New("private audio Storage configuration is invalid")
	}
	return &SupabaseStorage{baseURL: baseURL, key: serverKey, client: &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (s *SupabaseStorage) Put(ctx context.Context, key string, data []byte) error {
	if len(data) < 45 || len(data) > 16<<20 {
		return errors.New("audio object size is outside the allowed range")
	}
	resp, err := s.request(ctx, http.MethodPost, "object/"+audioBucket+"/"+key, bytes.NewReader(data), "audio/wav")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	if resp.StatusCode == http.StatusConflict || resp.StatusCode == http.StatusBadRequest {
		// A timed-out/duplicated upload is successful only if the existing bytes
		// match exactly. This keeps a reused idempotency key content-bound.
		stored, getErr := s.Get(ctx, key)
		if getErr == nil && bytes.Equal(stored, data) {
			return nil
		}
	}
	return fmt.Errorf("private Storage upload failed with HTTP %d", resp.StatusCode)
}

func (s *SupabaseStorage) Get(ctx context.Context, key string) ([]byte, error) {
	if !objectKeyPattern.MatchString(key) {
		return nil, errors.New("audio object key is invalid")
	}
	resp, err := s.request(ctx, http.MethodGet, "object/"+audioBucket+"/"+key, nil, "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("private Storage download failed with HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, (16<<20)+1))
	if err != nil || len(b) > 16<<20 {
		return nil, errors.New("private Storage object could not be read safely")
	}
	return b, nil
}

func (s *SupabaseStorage) Delete(ctx context.Context, key string) error {
	if !objectKeyPattern.MatchString(key) {
		return errors.New("audio object key is invalid")
	}
	resp, err := s.request(ctx, http.MethodDelete, "object/"+audioBucket+"/"+key, nil, "")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if (resp.StatusCode >= 200 && resp.StatusCode < 300) || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	return fmt.Errorf("private Storage delete failed with HTTP %d", resp.StatusCode)
}

func (s *SupabaseStorage) request(ctx context.Context, method, endpoint string, body io.Reader, contentType string) (*http.Response, error) {
	if s == nil || !objectKeyPattern.MatchString(strings.TrimPrefix(endpoint, "object/"+audioBucket+"/")) && endpoint != "object/"+audioBucket {
		return nil, errors.New("private Storage request is invalid")
	}
	req, err := http.NewRequestWithContext(ctx, method, s.baseURL+"/storage/v1/"+endpoint, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("apikey", s.key)
	req.Header.Set("Authorization", "Bearer "+s.key)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if method == http.MethodPost && strings.HasPrefix(endpoint, "object/"+audioBucket+"/") {
		req.Header.Set("x-upsert", "false")
	}
	return s.client.Do(req)
}

func isLoopbackHost(host string) bool {
	return host == "localhost" || strings.HasPrefix(host, "127.") || host == "::1"
}
